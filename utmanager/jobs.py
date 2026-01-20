"""Background jobs for delayed UI updates."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Dict, cast

from telegram.ext import ContextTypes

from utmanager.db import filemap_get, selection_get
from utmanager.ui import format_finalize_text, kb_reopen, schedule_autodelete

log = logging.getLogger(__name__)


async def close_selector_job(ctx: ContextTypes.DEFAULT_TYPE) -> None:
    job = cast(Any, ctx.job)
    data: Dict[str, Any] = cast(Dict[str, Any], job.data or {})
    chat_id = int(data.get("chat_id", 0))
    message_id = int(data.get("pmsg", 0))
    if not chat_id or not message_id:
        return

    try:
        await ctx.bot.edit_message_reply_markup(
            chat_id=chat_id,
            message_id=message_id,
            reply_markup=kb_reopen(message_id),
        )
    except Exception:  # pragma: no cover - best effort UI cleanup
        pass


async def finalize_post_job(ctx: ContextTypes.DEFAULT_TYPE) -> None:
    job = cast(Any, ctx.job)
    data: Dict[str, Any] = cast(Dict[str, Any], job.data or {})
    chat_id = int(data.get("chat_id", 0))
    message_id = int(data.get("pmsg", 0))
    if not chat_id or not message_id:
        return

    rec = filemap_get(chat_id, message_id)
    if not rec:
        return

    if selection_get(chat_id, message_id):
        try:
            await ctx.bot.delete_message(chat_id=chat_id, message_id=message_id)
        except Exception:  # pragma: no cover - best effort cleanup
            pass
        return

    path, _, _, files_count = rec
    folder = str(Path(path).parent)
    text = format_finalize_text(max(1, files_count), folder)
    try:
        await ctx.bot.edit_message_text(chat_id=chat_id, message_id=message_id, text=text)
        await schedule_autodelete(ctx, chat_id, message_id, delay_s=300)
    except Exception:  # pragma: no cover - best effort UI cleanup
        pass


async def delete_message_later(ctx: ContextTypes.DEFAULT_TYPE) -> None:
    job = cast(Any, ctx.job)
    data: Dict[str, Any] = cast(Dict[str, Any], job.data or {})
    chat_id = int(data.get("chat_id", 0))
    message_id = int(data.get("message_id", 0))
    if not chat_id or not message_id:
        return
    try:
        await ctx.bot.delete_message(chat_id, message_id)
    except Exception:  # pragma: no cover - cleanup only
        pass
