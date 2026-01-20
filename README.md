# UT Content Manager

Telegram bot for collecting media from chats and saving it to disk with metadata.

## Features
- Saves photos, videos, documents, animations.
- Stores metadata in SQLite (state.sqlite under BASE_ROOT).
- Works with local Telegram Bot API via docker-compose.

## Quick start (Docker)
1. Create `.env` with required values (see below).
2. Run:
   - `docker-compose up -d`
   - `docker-compose logs -f utmanager`

## Run locally (minimal)
```
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
python -m utmanager.app
```

## Storage layout
- If `USE_DATE_BUCKETS=1`:
  - `BASE_ROOT/UTDDMMYY/<Topic>`
- Otherwise:
  - `BASE_ROOT/<Topic>`
- Incoming files are staged under `BASE_ROOT/UNSORTED/<Category>` and then moved into the chosen topic.

## Key env vars
- `BOT_TOKEN` (required)
- `BASE_API_URL` (default: http://localhost:8081/bot)
- `BASE_FILE_URL` (optional)
- `TGGROUPLINK` (optional)
- `BASE_ROOT` (default: ./downloads)
- `ALLOWED_CHAT_IDS` (comma-separated)
- `OWNER_USER_ID` (optional)
- `TIMEZONE` (default: Europe/Amsterdam)
- `USE_DATE_BUCKETS` (0/1)

## Checks
- `python -m utmanager.checks`
