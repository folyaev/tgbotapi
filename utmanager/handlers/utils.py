# utmanager/handlers/utils.py
from __future__ import annotations

import logging
from pathlib import Path
from typing import List, Optional

from telegram import InlineKeyboardButton, InlineKeyboardMarkup
from telegram.error import BadRequest
from telegram.ext import ContextTypes

from utmanager.config import bucket_root
from utmanager.db import item_get, tags_for_item, thread_topic_set, topic_get
from utmanager.ui import format_item_card, item_actions_keyboard, schedule_autodelete, _format_created_at

log = logging.getLogger(__name__)
ui_log = logging.getLogger(__name__ + ".ui")


def log_ui_error(context: str, exc: Exception) -> None:
    ui_log.debug("%s failed: %s", context, exc, exc_info=True)


def record_thread_topic_from_message(msg) -> Optional[str]:
    """If message references a forum topic creation, remember thread_id -> name."""
    chat = getattr(msg, "chat", None)
    reply = getattr(msg, "reply_to_message", None)
    ftc = getattr(reply, "forum_topic_created", None)
    thread_id = getattr(msg, "message_thread_id", None) or getattr(reply, "message_thread_id", None)
    name = getattr(ftc, "name", None) if ftc else None
    if not (chat and thread_id and name):
        return None
    try:
        thread_topic_set(int(chat.id), int(thread_id), name)
    except Exception:
        log.debug("record_thread_topic_from_message: failed to store thread topic", exc_info=True)
    return name


def move_to_topic(abs_path: Path, bucket: str, topic_name: str, category: str) -> Path:
    final_dir = bucket_root(bucket) / topic_name / category
    final_dir.mkdir(parents=True, exist_ok=True)
    new_path = final_dir / abs_path.name
    try:
        abs_path.replace(new_path)
        return new_path
    except Exception:
        return abs_path


def _cancel_followup_jobs(ctx: ContextTypes.DEFAULT_TYPE, chat_id: int, progress_msg_id: int) -> None:
    job_queue = ctx.job_queue
    if not job_queue:
        return
    for name in (
        f"close-{chat_id}-{progress_msg_id}",
        f"finalize-{chat_id}-{progress_msg_id}",
    ):
        for job in job_queue.get_jobs_by_name(name):
            job.schedule_removal()
    # also cancel any pending autodelete to allow manual save scheduling later
    for job in job_queue.get_jobs_by_name(f"autodel-{chat_id}-{progress_msg_id}"):
        job.schedule_removal()


async def render_item_card(
    ctx: ContextTypes.DEFAULT_TYPE,
    *,
    chat_id: int,
    progress_msg_id: int,
    topic_id: int,
    bucket: str,
    origin_message_id: int,
) -> None:
    log.debug(
        "render_item_card enter chat=%s progress=%s topic=%s bucket=%r origin=%s",
        chat_id,
        progress_msg_id,
        topic_id,
        bucket,
        origin_message_id,
    )
    item = item_get(chat_id, origin_message_id)
    if not item:
        log.debug("render_item_card: item %s/%s not found", chat_id, origin_message_id)
        return

    topic_info = topic_get(topic_id) if topic_id else None
    topic_name = topic_info[2] if topic_info else "-"
    tag_pairs = tags_for_item(chat_id, origin_message_id)
    tag_names: List[str] = [name for _, name in tag_pairs]

    kind = item.get("kind", "")
    author = item.get("author", "Noname")
    created_at = item.get("created_at", "")
    date_display = _format_created_at(created_at)
    text = format_item_card(
        topic_name=topic_name,
        kind=kind,
        title=item.get("title"),
        author=author,
        created_at=created_at,
        link=item.get("link"),
        tags=tag_names,
    )
    keyboard = item_actions_keyboard(
        chat_id,
        origin_message_id,
        topic_id=topic_id,
        topic_name=topic_name,
        tags=tag_pairs,
        author=author,
        date_display=date_display,
        kind=kind,
    )

    _cancel_followup_jobs(ctx, chat_id, progress_msg_id)

    try:
        await ctx.bot.edit_message_text(
            chat_id=chat_id,
            message_id=progress_msg_id,
            text=text,
            reply_markup=keyboard,
            disable_web_page_preview=True,
        )
    except BadRequest as exc:
        lowered = str(exc).lower()
        if "message is not modified" in lowered:
            try:
                await ctx.bot.edit_message_reply_markup(
                    chat_id=chat_id,
                    message_id=progress_msg_id,
                    reply_markup=keyboard,
                )
            except Exception:
                pass
            return
        log_ui_error(f"render_item_card chat={chat_id} msg={progress_msg_id}", exc)
    except Exception as exc:  # pragma: no cover - best effort UI update
        log_ui_error(f"render_item_card chat={chat_id} msg={progress_msg_id}", exc)


def _short(text: Optional[str], limit: int = 256) -> str:
    if not text:
        return ""
    if len(text) <= limit:
        return text
    return text[: limit - 1].rstrip() + "…"

async def render_item_summary(
    ctx: ContextTypes.DEFAULT_TYPE,
    *,
    chat_id: int,
    progress_msg_id: int,
    topic_id: int,
    bucket: str,
    origin_message_id: int,
) -> None:
    item = item_get(chat_id, origin_message_id)
    if not item:
        log.debug("render_item_summary: item %s/%s not found", chat_id, origin_message_id)
        return

    topic_info = topic_get(topic_id) if topic_id else None
    topic_name = topic_info[2] if topic_info else "-"
    tag_text = item.get("tags_cache") or "(none)"
    title = _short(item.get("title"), 600)
    type_map = {"Video": "\U0001F4F9", "Images": "\U0001F5BC", "Documents": "\U0001F4C4"}
    kind_value = item.get("kind", "-")
    type_display = type_map.get(kind_value, kind_value or "-")
    created_at_raw = item.get("created_at", "")
    date_display = _format_created_at(created_at_raw)
    lines = [
        f"Topic: {topic_name}",
        f"Title: {title or '(empty)'}",
        f"Type: {type_display}",
        f"Author: {_short(item.get('author')) or 'Noname'}",
        f"Date: {_short(date_display) or '-'}",
        f"Tags: {tag_text}",
    ]
    text = "\n".join(lines)

    keyboard = InlineKeyboardMarkup(
        [
            [
                InlineKeyboardButton("Редактировать", callback_data=f"item:edit:{chat_id}:{progress_msg_id}"),
                InlineKeyboardButton("Скачать", callback_data=f"item:download:{chat_id}:{origin_message_id}"),
            ]
        ]
    )

    try:
        await ctx.bot.edit_message_text(
            chat_id=chat_id,
            message_id=progress_msg_id,
            text=text,
            reply_markup=keyboard,
            link_preview_options=None,
        )
        await schedule_autodelete(ctx, chat_id, progress_msg_id, delay_s=300)
    except BadRequest as exc:
        lowered = str(exc).lower()
        if "message is not modified" in lowered:
            return
        log_ui_error(f"render_item_summary chat={chat_id} msg={progress_msg_id}", exc)
    except Exception as exc:  # pragma: no cover
        log_ui_error(f"render_item_summary chat={chat_id} msg={progress_msg_id}", exc)

