"""Helpers for Telegram Bot API interactions."""

from __future__ import annotations

from typing import Any

from telegram.error import BadRequest
from telegram import Message
from telegram.ext import ContextTypes


async def send_silent_message(
    ctx: ContextTypes.DEFAULT_TYPE,
    chat_id: int,
    text: str,
    *,
    disable_notification: bool = True,
    **kwargs: Any,
):
    """Proxy to ctx.bot.send_message with notifications disabled by default."""
    payload = dict(kwargs)
    payload.setdefault("disable_notification", disable_notification)
    try:
        return await ctx.bot.send_message(chat_id, text, **payload)
    except BadRequest as exc:
        if (
            "message thread not found" in str(exc).lower()
            and "message_thread_id" in payload
        ):
            payload.pop("message_thread_id", None)
            return await ctx.bot.send_message(chat_id, text, **payload)
        raise


async def reply_silent(
    message: Message,
    text: str,
    *,
    disable_notification: bool = True,
    **kwargs: Any,
):
    """Reply to a message without triggering a notification by default."""
    payload = dict(kwargs)
    payload.setdefault("disable_notification", disable_notification)
    try:
        return await message.reply_text(text, **payload)
    except BadRequest as exc:
        if (
            "message thread not found" in str(exc).lower()
            and "message_thread_id" in payload
        ):
            payload.pop("message_thread_id", None)
            return await message.reply_text(text, **payload)
        raise
