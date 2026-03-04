# utmanager/storage.py
from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Awaitable, Callable, Optional

import aiohttp
from aiohttp import ClientTimeout
from telegram import File as TgFile
from telegram.error import BadRequest, Forbidden

from .config import (
    BASE_API_URL,
    resolve_download_url,
    local_abs_path_for,
)

log = logging.getLogger(__name__)


async def _run_with_retry(
    call: Callable[[], Awaitable[TgFile]],
    *,
    op_name: str,
    tries: int,
    base_sleep: float,
) -> TgFile:
    last_err: Optional[Exception] = None
    for attempt in range(1, tries + 1):
        try:
            return await call()
        except (BadRequest, Forbidden):
            # Invalid request/permissions are not transient and should fail fast.
            raise
        except Exception as e:
            last_err = e
            if attempt < tries:
                retry_after = getattr(e, "retry_after", None)
                delay = base_sleep * attempt
                if isinstance(retry_after, (int, float)) and retry_after > 0:
                    delay = max(delay, float(retry_after))
                log.warning("%s attempt %d/%d failed: %s", op_name, attempt, tries, e)
                await asyncio.sleep(delay)
            else:
                break
    raise RuntimeError(f"{op_name} failed after retries") from last_err


async def get_file_with_retry(obj_with_get_file, tries: int = 3, base_sleep: float = 1.5) -> TgFile:
    """Type-safe retry helper for object.get_file()."""
    return await _run_with_retry(
        obj_with_get_file.get_file,
        op_name="get_file",
        tries=tries,
        base_sleep=base_sleep,
    )


async def get_file_by_id_with_retry(
    bot,
    file_id: str,
    *,
    tries: int = 4,
    base_sleep: float = 2.0,
    connect_timeout: float = 30.0,
    read_timeout: float = 300.0,
    pool_timeout: float = 60.0,
) -> TgFile:
    """Retry helper for bot.get_file(file_id) with extended read timeout."""

    async def _call() -> TgFile:
        return await bot.get_file(
            file_id=file_id,
            connect_timeout=connect_timeout,
            read_timeout=read_timeout,
            pool_timeout=pool_timeout,
        )

    return await _run_with_retry(
        _call,
        op_name=f"bot.get_file({file_id})",
        tries=tries,
        base_sleep=base_sleep,
    )


async def stream_download(bot, file_path: str, dest: Path, progress_cb, tg_file: Optional[TgFile] = None):
    """
    LOCAL (--local): copy directly from /var/lib/telegram-bot-api (no HTTP).
    REMOTE (api.telegram.org): download over HTTP; on failure use PTB fallback.
    """
    fp = (file_path or "").replace("\\", "/")
    is_remote = "api.telegram.org" in BASE_API_URL

    tmp = dest.with_suffix(dest.suffix + ".part")
    dest.parent.mkdir(parents=True, exist_ok=True)

    # local copy from mounted bot-api volume
    if not is_remote:
        abs_fp = local_abs_path_for(fp)
        src = Path(abs_fp)
        try:
            if not src.exists():
                raise FileNotFoundError(f"Local file not found: {src}")
            import shutil

            with open(src, "rb") as s, open(tmp, "wb") as d:
                shutil.copyfileobj(s, d, length=1024 * 1024)
            try:
                await progress_cb(1, 1)
            except Exception:
                pass
            tmp.replace(dest)
            return
        except Exception as e:
            log.exception("Local copy failed: %s", e)
            raise

    # HTTP download
    url = resolve_download_url(fp)
    timeout = ClientTimeout(total=3600)
    async with aiohttp.ClientSession(timeout=timeout) as sess:
        for i in range(1, 4):
            try:
                log.info("Downloading from: %s | file_path=%s", url, fp)
                async with sess.get(url) as resp:
                    resp.raise_for_status()
                    total = int(resp.headers.get("Content-Length", "0")) or None
                    got = 0
                    with open(tmp, "wb") as f:
                        async for chunk in resp.content.iter_chunked(1024 * 1024):
                            f.write(chunk)
                            got += len(chunk)
                            if total:
                                await progress_cb(got, total)
                tmp.replace(dest)
                return
            except Exception as e:
                log.exception("Download attempt %d failed: %s", i, e)
                await asyncio.sleep(1.5 * i)

    # fallback through PTB
    if tg_file is not None:
        log.info("Fallback: PTB download_to_drive -> %s", tmp)
        await tg_file.download_to_drive(custom_path=str(tmp))
        try:
            await progress_cb(1, 1)
        except Exception:
            pass
        Path(tmp).replace(dest)
        return

    raise RuntimeError(f"All download attempts failed for {url}")
