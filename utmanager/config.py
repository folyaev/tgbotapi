# utmanager/config.py
from __future__ import annotations

import os
import re
import logging
from pathlib import Path
from typing import Optional
from urllib.parse import quote
from datetime import datetime

from dotenv import load_dotenv

log = logging.getLogger(__name__)
load_dotenv()

# ====== ENV / CONSTANTS ======
BOT_TOKEN: str = os.environ.get("BOT_TOKEN", "")
if not BOT_TOKEN:
    raise ValueError("BOT_TOKEN is not set in .env")

BASE_API_URL: str = os.environ.get("BASE_API_URL", "http://localhost:8081/bot").rstrip("/")
BASE_FILE_URL: str = os.environ.get("BASE_FILE_URL", "").rstrip("/")
TGGROUP_LINK: str = os.environ.get("TGGROUPLINK", "").strip()

# локальный/удалённый базовые URL для файлов (не зависят от BASE_FILE_URL)
FILE_BASE_LOCAL = "http://tgbotapi:8081/file"
FILE_BASE_REMOTE = "https://api.telegram.org/file"

BASE_ROOT = Path(os.environ.get("BASE_ROOT", "C:\\Users\\Nemifist\\YandexDisk\\PAMPAM"))
BASE_ROOT.mkdir(parents=True, exist_ok=True)

ALLOWED = {int(x.strip()) for x in os.environ.get("ALLOWED_CHAT_IDS", "").split(",") if x.strip()}
OWNER = int(os.environ["OWNER_USER_ID"]) if os.environ.get("OWNER_USER_ID") else None
TIMEZONE = os.environ.get("TIMEZONE", "Europe/Amsterdam")

MAX_SIZE = 2 * 1024 * 1024 * 1024  # 2 GB
USE_DATE_BUCKETS = os.environ.get("USE_DATE_BUCKETS", "0") not in {"0", "false", "False", ""}

STORAGE_PREFIX = "/var/lib/telegram-bot-api/"
TITLE_MAX_LEN = 100

# ====== tz helpers ======
try:
    from zoneinfo import ZoneInfo
    TZ = ZoneInfo(TIMEZONE)
except Exception:
    TZ = None  # fallback

def local_dt(dt: datetime) -> datetime:
    return dt.astimezone(TZ) if TZ else dt

def ts_name(dt: datetime) -> str:
    return local_dt(dt).strftime("%Y-%m-%d_%H-%M-%S")

def ut_bucket(dt: datetime) -> str:
    return "UT" + local_dt(dt).strftime("%d%m%y")

def current_bucket(dt: datetime) -> str:
    return ut_bucket(dt) if USE_DATE_BUCKETS else ""

def bucket_root(bucket: str) -> Path:
    return BASE_ROOT / bucket if (USE_DATE_BUCKETS and bucket) else BASE_ROOT

# ====== names / regex ======
SAFE = re.compile(r"[^-\w.\s]+", re.UNICODE)
def safe(s: str) -> str:
    return SAFE.sub("_", s).strip()[:150] or "item"

VIDEO_EXT = {".mp4", ".mov", ".gif"}

# ====== paths / urls ======
def local_abs_path_for(file_path: str) -> str:
    """Превратить относительный tail в абсолютный путь внутри тома Bot API."""
    fp = (file_path or "").replace("\\", "/")
    if fp.startswith(STORAGE_PREFIX):
        return fp
    return f"{STORAGE_PREFIX}/{fp.lstrip('/')}"

def resolve_download_url(file_path: str) -> str:
    """
    Унифицированная сборка URL скачивания:
    - REMOTE: https://api.telegram.org/file/bot<TOKEN>/<tail>
    - LOCAL : http://tgbotapi:8081/file/<tail>
    где tail = относительный путь внутри STORAGE_PREFIX.
    """
    token = BOT_TOKEN
    fp = (file_path or "").replace("\\", "/")
    is_remote = "api.telegram.org" in BASE_API_URL

    # абсолютный путь в хранилище
    if fp.startswith(STORAGE_PREFIX):
        tail = fp[len(STORAGE_PREFIX):].lstrip("/")
        return (
            f"{FILE_BASE_REMOTE}/bot{token}/{quote(tail, safe='/._-:')}"
            if is_remote else
            f"{FILE_BASE_LOCAL}/{quote(tail, safe='/._-:')}"
        )

    # уже remote URL -> нормализуем к REMOTE
    if fp.startswith("https://api.telegram.org"):
        marker = "/file/"
        tail = fp.split(marker, 1)[1] if marker in fp else fp
        return f"{FILE_BASE_REMOTE}/{quote(tail.lstrip('/'), safe='/._-:')}"

    # относительный tail
    tail = fp.lstrip("/")
    return (
        f"{FILE_BASE_REMOTE}/bot{token}/{quote(tail, safe='/._-:')}"
        if is_remote else
        f"{FILE_BASE_LOCAL}/{quote(tail, safe='/._-:')}"
    )
