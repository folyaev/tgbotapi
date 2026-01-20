# utmanager/storage.py
from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Optional

import aiohttp
from aiohttp import ClientTimeout
from telegram import File as TgFile

from .config import (
    BASE_API_URL, FILE_BASE_LOCAL, FILE_BASE_REMOTE, BOT_TOKEN,
    STORAGE_PREFIX, resolve_download_url, local_abs_path_for
)

log = logging.getLogger(__name__)

async def get_file_with_retry(obj_with_get_file, tries: int = 3, base_sleep: float = 1.5) -> TgFile:
    """Типобезопасный ретрай для .get_file()."""
    last_err: Optional[Exception] = None
    for attempt in range(1, tries + 1):
        try:
            return await obj_with_get_file.get_file()
        except Exception as e:
            last_err = e
            if attempt < tries:
                log.warning("get_file attempt %d/%d failed: %s", attempt, tries, e)
                await asyncio.sleep(base_sleep * attempt)
            else:
                break
    raise RuntimeError("get_file failed after retries") from last_err

async def stream_download(bot, file_path: str, dest: Path, progress_cb, tg_file: Optional[TgFile] = None):
    """
    LOCAL (--local): копируем напрямую из /var/lib/telegram-bot-api (без HTTP).
    REMOTE (api.telegram.org): качаем по HTTP, при фейле — PTB fallback.
    """
    fp = (file_path or "").replace("\\", "/")
    is_remote = "api.telegram.org" in BASE_API_URL

    tmp = dest.with_suffix(dest.suffix + ".part")
    dest.parent.mkdir(parents=True, exist_ok=True)

    # локальная копия из тома
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

    # http
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

    # fallback через PTB
    if tg_file is not None:
        log.info("Fallback: PTB download_to_drive → %s", tmp)
        await tg_file.download_to_drive(custom_path=str(tmp))
        try:
            await progress_cb(1, 1)
        except Exception:
            pass
        Path(tmp).replace(dest)
        return

    raise RuntimeError(f"All download attempts failed for {url}")
