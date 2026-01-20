# utmanager/preflight.py
from __future__ import annotations
import logging
import aiohttp
from aiohttp import ClientTimeout
from utmanager.config import BOT_TOKEN, BASE_API_URL

log = logging.getLogger(__name__)

async def preflight_check() -> None:
    if not BOT_TOKEN:
        raise SystemExit("BOT_TOKEN is not set in .env")
    test_url = f"{BASE_API_URL}{BOT_TOKEN}/getMe"
    try:
        timeout = ClientTimeout(total=10)
        async with aiohttp.ClientSession(timeout=timeout) as sess:
            async with sess.post(test_url) as resp:
                text = await resp.text()
                if resp.status == 401 and "invalid api-id/api-hash" in text:
                    raise SystemExit(
                        "Локальный Bot API отверг запрос: 401 invalid api-id/api-hash.\n"
                        "Проверь docker (TELEGRAM_API_ID/HASH). По этому URL должно быть ok:true:\n"
                        f"{test_url}"
                    )
                if resp.status != 200:
                    log.warning("Preflight getMe returned %s: %s", resp.status, text[:200])
    except SystemExit:
        raise
    except Exception as e:
        log.warning("Preflight check failed: %s", e)
