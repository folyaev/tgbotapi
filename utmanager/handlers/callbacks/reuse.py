"""Callbacks for reusing existing topics and browsing items."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from telegram import InlineKeyboardButton, InlineKeyboardMarkup, Update
from telegram.ext import ContextTypes

from utmanager.db import (
    filemap_by_origin,
    filemap_set,
    item_apply_topic_tags,
    item_get,
    item_update_bucket,
    item_update_topic_id,
    reuse_state_clear,
    reuse_state_get,
    reuse_state_set,
    tags_for_item,
    topic_get,
)
from utmanager.handlers.utils import move_to_topic
from utmanager.telegram_utils import send_silent_message
from utmanager.ui import format_item_card, schedule_autodelete
from utmanager.topics import topics_ordered

from .common import _safe_answer, log

REUSE_TOPICS_PER_PAGE = 6


def _reuse_summary_text(item: Dict[str, Any], topic_name: str, bucket: str) -> str:
    tag_names = [name for _, name in tags_for_item(item["chat_id"], item["message_id"])]
    text_val = format_item_card(
        topic_name=topic_name,
        kind=item.get("kind", ""),
        title=item.get("title"),
        author=item.get("author", "Noname"),
        created_at=item.get("created_at", ""),
        link=item.get("link"),
        tags=tag_names,
    )
    if bucket:
        text_val = f"Bucket: {bucket}\n{text_val}"
    return text_val


def _build_reuse_keyboard(
    *,
    message_id: int,
    item_chat_id: int,
    bucket: str,
    page: int = 0,
) -> InlineKeyboardMarkup:
    buttons: List[List[InlineKeyboardButton]] = []
    buttons.append([InlineKeyboardButton("+ Новая тема", callback_data=f"reusenew:{message_id}")])

    ordered = topics_ordered(item_chat_id, bucket)
    total = len(ordered)
    pages = max(1, (total + REUSE_TOPICS_PER_PAGE - 1) // REUSE_TOPICS_PER_PAGE)
    page = max(0, min(page, pages - 1))

    start = page * REUSE_TOPICS_PER_PAGE
    end = start + REUSE_TOPICS_PER_PAGE
    for topic_id, name in ordered[start:end]:
        buttons.append([InlineKeyboardButton(name, callback_data=f"reusepick:{message_id}:{topic_id}")])

    if pages > 1:
        buttons.append(
            [
                InlineKeyboardButton("<", callback_data=f"reusetopics:{message_id}:{max(0, page - 1)}"),
                InlineKeyboardButton(f"{page + 1}/{pages}", callback_data="noop"),
                InlineKeyboardButton(">", callback_data=f"reusetopics:{message_id}:{min(pages - 1, page + 1)}"),
            ]
        )

    buttons.append([InlineKeyboardButton("✖ Закрыть", callback_data=f"reuseclose:{message_id}")])
    return InlineKeyboardMarkup(buttons)


async def _reuse_apply_topic(
    ctx: ContextTypes.DEFAULT_TYPE,
    *,
    chat_id: int,
    reuse_message_id: int,
    item_chat_id: int,
    item_message_id: int,
    topic_id: int,
) -> None:
    item_info = item_get(item_chat_id, item_message_id)
    if not item_info:
        reuse_state_clear(chat_id, reuse_message_id)
        try:
            await ctx.bot.edit_message_text(
                chat_id=chat_id,
                message_id=reuse_message_id,
                text="Карточка недоступна.",
            )
        except Exception:
            pass
        return

    topic_info = topic_get(topic_id)
    topic_bucket = item_info.get("bucket") or ""
    topic_name = topic_info[2] if topic_info else "(без темы)"
    if topic_info:
        topic_bucket = topic_info[1] or topic_bucket

    item_update_topic_id(item_chat_id, item_message_id, topic_id)
    item_update_bucket(item_chat_id, item_message_id, topic_bucket)
    item_apply_topic_tags(item_chat_id, item_message_id, topic_id)

    file_info = filemap_by_origin(item_chat_id, item_message_id)
    if file_info:
        progress_msg_id, abs_path, _, category, _ = file_info
        try:
            new_path = move_to_topic(Path(abs_path), topic_bucket, topic_name, category)
            filemap_set(
                item_chat_id,
                progress_msg_id,
                str(new_path),
                topic_bucket,
                category,
                origin_message_id=item_message_id,
            )
        except Exception:
            log.debug("reuse move failed", exc_info=True)

    updated_item = item_get(item_chat_id, item_message_id) or item_info
    summary = _reuse_summary_text(updated_item, topic_name, updated_item.get("bucket") or topic_bucket)
    reuse_state_clear(chat_id, reuse_message_id)
    close_markup = InlineKeyboardMarkup(
        [[InlineKeyboardButton("✖ Закрыть", callback_data=f"reuseclose:{reuse_message_id}")]]
    )
    try:
        await ctx.bot.edit_message_text(
            chat_id=chat_id,
            message_id=reuse_message_id,
            text=summary + "\n\nГотово.",
            reply_markup=close_markup,
            disable_web_page_preview=True,
        )
    except Exception:
        pass


async def cb_reuse_topics_page(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    q = update.callback_query
    if not q or not q.message or not q.data:
        return
    await _safe_answer(q)

    try:
        _, msg_id_s, page_s = q.data.split(":")
        reuse_message_id = int(msg_id_s)
        page = max(0, int(page_s))
    except ValueError:
        return

    state = reuse_state_get(q.message.chat.id, reuse_message_id)
    if not state:
        await _safe_answer(q, text="Сессия устарела.", show_alert=True)
        return

    item_chat_id, item_message_id, bucket = state
    keyboard = _build_reuse_keyboard(
        message_id=reuse_message_id,
        item_chat_id=item_chat_id,
        bucket=bucket,
        page=page,
    )
    try:
        await ctx.bot.edit_message_reply_markup(
            chat_id=q.message.chat.id,
            message_id=reuse_message_id,
            reply_markup=keyboard,
        )
    except Exception:
        pass


async def cb_reuse_pick(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    q = update.callback_query
    if not q or not q.message or not q.data:
        return
    await _safe_answer(q)

    try:
        _, msg_id_s, topic_s = q.data.split(":")
        reuse_message_id = int(msg_id_s)
        topic_id = int(topic_s)
    except ValueError:
        return

    state = reuse_state_get(q.message.chat.id, reuse_message_id)
    if not state:
        await _safe_answer(q, text="Сессия устарела.", show_alert=True)
        return

    item_chat_id, item_message_id, _ = state
    await _reuse_apply_topic(
        ctx,
        chat_id=q.message.chat.id,
        reuse_message_id=reuse_message_id,
        item_chat_id=item_chat_id,
        item_message_id=item_message_id,
        topic_id=topic_id,
    )


async def cb_reuse_newtopic(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    q = update.callback_query
    if not q or not q.message or not q.data:
        return
    await _safe_answer(q)

    try:
        _, msg_id_s = q.data.split(":")
        reuse_message_id = int(msg_id_s)
    except ValueError:
        return

    state = reuse_state_get(q.message.chat.id, reuse_message_id)
    if not state:
        await _safe_answer(q, text="Сессия устарела.", show_alert=True)
        return

    item_chat_id, item_message_id, bucket = state
    prompt = await send_silent_message(
        ctx,
        q.message.chat.id,
        "Пришлите название новой темы.",
        disable_notification=True,
        reply_to_message_id=q.message.message_id,
        message_thread_id=q.message.message_thread_id,
    )
    from utmanager.db import pending_reuse_topic_set  # local import to avoid cycles

    pending_reuse_topic_set(
        q.message.chat.id,
        q.from_user.id,
        reuse_message_id,
        item_chat_id,
        item_message_id,
        bucket,
        prompt.message_id,
    )
    await schedule_autodelete(ctx, q.message.chat.id, prompt.message_id, delay_s=60)


async def cb_reuse_close(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    q = update.callback_query
    if not q or not q.message or not q.data:
        return
    await _safe_answer(q)

    try:
        _, msg_id_s = q.data.split(":")
        reuse_message_id = int(msg_id_s)
    except ValueError:
        return

    reuse_state_clear(q.message.chat.id, reuse_message_id)
    try:
        await ctx.bot.delete_message(chat_id=q.message.chat.id, message_id=reuse_message_id)
    except Exception:
        pass


__all__ = [
    "REUSE_TOPICS_PER_PAGE",
    "_build_reuse_keyboard",
    "_reuse_apply_topic",
    "_reuse_summary_text",
    "cb_reuse_close",
    "cb_reuse_newtopic",
    "cb_reuse_pick",
    "cb_reuse_topics_page",
]
