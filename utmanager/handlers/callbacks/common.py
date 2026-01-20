"""Shared helpers for callback callback modules."""

from __future__ import annotations

import logging
from typing import Dict, Optional

from telegram.error import BadRequest
from telegram.ext import ContextTypes

from utmanager.config import OWNER

log = logging.getLogger(__name__)


async def _safe_answer(q, *, text: Optional[str] = None, show_alert: bool = False) -> None:
    """Safely answer a callback query, swallowing stale query errors."""
    if not q:
        return
    try:
        await q.answer(text=text, show_alert=show_alert)
    except BadRequest as exc:
        lowered = str(exc).lower()
        if "query is too old" in lowered or "query id is invalid" in lowered:
            return
        log.debug("safe_answer: ignoring bad request: %s", exc)
    except Exception as exc:  # pragma: no cover - defensive
        log.exception("safe_answer: unexpected error: %s", exc)


async def _is_admin(ctx: ContextTypes.DEFAULT_TYPE, chat_id: int, user_id: int) -> bool:
    """Return True if the user is considered an administrator for the chat."""
    if chat_id == user_id:
        # In private chats the user implicitly "owns" the conversation.
        return True
    if OWNER and user_id == OWNER:
        return True
    if not ctx.bot:
        return False
    try:
        member = await ctx.bot.get_chat_member(chat_id, user_id)
        return getattr(member, "status", None) in {"administrator", "creator"}
    except Exception:  # pragma: no cover - Telegram errors
        log.exception("is_admin: failed to fetch status chat=%s user=%s", chat_id, user_id)
        return False


def log_action(action: str, *, chat_id: int, user_id: int, **extra: object) -> None:
    """Structured log entry for user actions."""
    details: Dict[str, object] = {**extra}
    if details:
        parts = " ".join(f"{key}={value}" for key, value in sorted(details.items()))
        log.info("action=%s chat=%s user=%s %s", action, chat_id, user_id, parts)
    else:
        log.info("action=%s chat=%s user=%s", action, chat_id, user_id)


__all__ = ["log", "_safe_answer", "_is_admin", "log_action"]
