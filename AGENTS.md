# AGENTS.md

Project: UT Content Manager (Telegram bot + local Bot API).

Purpose
- Downloads and catalogs media from Telegram chats.
- Stores files under BASE_ROOT and metadata in state.sqlite.

Run (Docker)
- `docker-compose up -d`
- `docker-compose logs -f utmanager`

Run (Local, minimal)
- `python -m venv .venv`
- `.venv\\Scripts\\activate` (Windows)
- `pip install -r requirements.txt`
- `python -m utmanager.app`

Checks
- `python -m utmanager.checks` (consistency check)
- `python -m py_compile utmanager\\handlers\\media.py` (quick sanity)

Key env vars (.env)
- `BOT_TOKEN` (required)
- `BASE_API_URL` (default: http://localhost:8081/bot)
- `BASE_FILE_URL` (optional)
- `TGGROUPLINK` (optional)
- `BASE_ROOT` (default: ./downloads)
- `ALLOWED_CHAT_IDS` (comma-separated)
- `OWNER_USER_ID` (optional)
- `TIMEZONE` (default: Europe/Amsterdam)
- `USE_DATE_BUCKETS` (0/1)

Layout
- `utmanager/app.py`: app entrypoint and handlers wiring.
- `utmanager/handlers/media.py`: media ingest/download logic.
- `utmanager/handlers/callbacks/`: UI callbacks.
- `utmanager/db.py`: sqlite schema + helpers.
- `utmanager/ui.py`: message formatting and keyboards.

Notes
- Local Bot API container runs on `tgbotapi:8081` per `docker-compose.yml`.
- Files are first saved to `BASE_ROOT/UNSORTED/<Category>` then moved on topic selection.
- In `VBAUT`, `Newsroom` is no longer embedded on the main page; it lives on the separate route `http://localhost:5173/newsroom`.
- In `VBAUT`, `Research` now lives on the separate route `http://localhost:5173/research` and the main workflow is a single ranked-list search, not `main/backup pair` selection.
- `Research` reruns exclude duplicates already present in the document link list and previously seen URLs; it can optionally use parent topic title and saved theme tags.
- `Source Registry` in `VBAUT` lives in `data/source-profiles.json` and stores both `domain_profiles` and `channel_profiles`, including metadata like language, RF blocking, watermarks, default quality and `screenshot_profiles`.
- In `VBAUT` SDVG mode, research suggestions are sent as separate Telegram messages with per-link actions.
- In `VBAUT` SDVG mode, downloadable links still go through the normal `yt-dlp/gallery-dl` flow; non-downloadable links are first added to topic links and then get a screenshot preview.
- Screenshot preview in SDVG uses per-source browser presets: `+` attaches the screenshot to the segment, `-` dismisses the preview, `✖️` retries with different browser parameters and successful presets are saved back into `Source Registry`.
