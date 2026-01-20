"""Browse callbacks for navigating saved content."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple, cast

from telegram import InlineKeyboardButton, InlineKeyboardMarkup, Message, Update
from telegram.error import BadRequest
from telegram.ext import ContextTypes

from utmanager.db import (
    browse_items,
    browse_state_clear,
    browse_state_get,
    browse_state_set,
    browse_state_update_page,
    tag_name,
    topic_get,
)
from utmanager.telegram_utils import send_silent_message
from .common import _safe_answer, log
from .reuse import _build_reuse_keyboard, _reuse_summary_text

TYPE_EMOJI = {"Video": "📹", "Images": "🖼️", "Documents": "📄"}
BROWSE_PAGE_SIZE = 5
BROWSE_TITLES = {
    "topic": "Контент по теме",
    "date": "Контент по дате",
    "author": "Контент по автору",
    "tag": "Контент по тэгу",
}


def _type_icon(kind: Optional[str]) -> str:
    if not kind:
        return "📁"
    return TYPE_EMOJI.get(kind, "📁")


def _trim_title(title: Optional[str], limit: int = 48) -> str:
    if not title:
        return "(без названия)"
    if len(title) <= limit:
        return title
    return title[: limit - 1].rstrip() + "…"


def _format_browse_value(filter_type: str, filter_value: str, *, chat_id: int) -> str:
    if filter_type == "topic":
        try:
            topic_id = int(filter_value)
        except ValueError:
            topic_id = 0
        topic_info = topic_get(topic_id) if topic_id else None
        return topic_info[2] if topic_info else "(без темы)"
    if filter_type == "tag":
        try:
            tag_id = int(filter_value)
        except ValueError:
            tag_id = -1
        name = tag_name(tag_id) if tag_id >= 0 else None
        return f"#{name}" if name else "(тэг)"
    if filter_type == "author":
        return filter_value or "Noname"
    if filter_type == "date":
        try:
            parsed = datetime.strptime(filter_value, "%Y-%m-%d")
            return parsed.strftime("%d.%m.%Y")
        except Exception:
            return filter_value
    return filter_value


def _compose_browse_text(filter_type: str, value_display: str, page: int, has_items: bool) -> str:
    title = BROWSE_TITLES.get(filter_type, "Контент")
    lines = [f"{title}: «{value_display}»"]
    if not has_items:
        lines.append("Нет элементов.")
    lines.append(f"Страница {page + 1}")
    return "\n".join(lines)


def _build_browse_keyboard(
    items: List[Dict[str, Any]],
    page: int,
    has_next: bool,
) -> InlineKeyboardMarkup:
    rows: List[List[InlineKeyboardButton]] = []
    for item in items:
        icon = _type_icon(item.get("kind"))
        title = _trim_title(item.get("title"))
        rows.append(
            [
                InlineKeyboardButton(
                    f"{icon} {title}",
                    callback_data=f"browseitem:{item['chat_id']}:{item['message_id']}",
                )
            ]
        )
    nav_row: List[InlineKeyboardButton] = []
    if page > 0:
        nav_row.append(
            InlineKeyboardButton(
                "◀️",
                callback_data=f"browsepage:{page - 1}",
            )
        )
    else:
        nav_row.append(InlineKeyboardButton("◀️", callback_data="noop"))
    nav_row.append(InlineKeyboardButton("✖️", callback_data="browseclose"))
    if has_next:
        nav_row.append(
            InlineKeyboardButton(
                "▶️",
                callback_data=f"browsepage:{page + 1}",
            )
        )
    else:
        nav_row.append(InlineKeyboardButton("▶️", callback_data="noop"))
    rows.append(nav_row)
    return InlineKeyboardMarkup(rows)


async def cb_browse_open(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    q = update.callback_query
    if not q or not q.message or not q.data:
        return
    await _safe_answer(q)

    parts = q.data.split(":")
    if len(parts) < 4:
        return

    _, action, item_chat_s, origin_s, *rest = parts
    try:
        item_chat_id = int(item_chat_s)
        origin_message_id = int(origin_s)
    except ValueError:
        return

    from utmanager.db import item_get  # local import to avoid cycles

    item_info = item_get(item_chat_id, origin_message_id)
    if not item_info:
        return

    filter_type: str
    filter_value: str
    if action == "topic":
        filter_type = "topic"
        filter_value = str(item_info.get("topic_id") or 0)
    elif action == "date":
        created_at = item_info.get("created_at") or ""
        if not created_at:
            await _safe_answer(q, text="Дата не указана.", show_alert=True)
            return
        filter_type = "date"
        filter_value = created_at[:10]
    elif action == "author":
        filter_type = "author"
        filter_value = item_info.get("author") or ""
    elif action == "tag" and rest:
        filter_type = "tag"
        try:
            filter_value = str(int(rest[0]))
        except ValueError:
            return
    else:
        return

    msg: Message = cast(Message, q.message)
    list_chat_id = msg.chat.id
    display_value = _format_browse_value(filter_type, filter_value, chat_id=list_chat_id)
    items, has_next = browse_items(
        filter_type,
        list_chat_id,
        filter_value,
        page=0,
        per_page=BROWSE_PAGE_SIZE,
    )
    text = _compose_browse_text(filter_type, display_value, 0, bool(items))

    reply = await send_silent_message(
        ctx,
        msg.chat.id,
        text,
        disable_notification=True,
        reply_to_message_id=msg.message_id,
        message_thread_id=msg.message_thread_id,
    )

    keyboard = _build_browse_keyboard(items, 0, has_next)
    try:
        await ctx.bot.edit_message_reply_markup(
            chat_id=reply.chat.id,
            message_id=reply.message_id,
            reply_markup=keyboard,
        )
    except Exception:
        pass

    browse_state_set(reply.chat.id, reply.message_id, filter_type, filter_value, 0)


async def cb_browse_page(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    q = update.callback_query
    if not q or not q.message or not q.data:
        return
    await _safe_answer(q)

    try:
        _, page_s = q.data.split(":")
        target_page = max(0, int(page_s))
    except Exception:
        return

    msg: Message = cast(Message, q.message)
    state = browse_state_get(msg.chat.id, msg.message_id)
    if not state:
        await _safe_answer(q, text="Список устарел.", show_alert=True)
        return

    filter_type, filter_value, _ = state
    items, has_next = browse_items(
        filter_type,
        msg.chat.id,
        filter_value,
        page=target_page,
        per_page=BROWSE_PAGE_SIZE,
    )
    display_value = _format_browse_value(filter_type, filter_value, chat_id=msg.chat.id)
    text = _compose_browse_text(filter_type, display_value, target_page, bool(items))
    keyboard = _build_browse_keyboard(items, target_page, has_next)

    try:
        await ctx.bot.edit_message_text(
            chat_id=msg.chat.id,
            message_id=msg.message_id,
            text=text,
            reply_markup=keyboard,
            disable_web_page_preview=True,
        )
    except BadRequest as exc:
        if "message is not modified" in str(exc).lower():
            return
        log.exception("cb_browse_page: failed to edit list %s/%s: %s", msg.chat.id, msg.message_id, exc)
    except Exception as exc:  # pragma: no cover
        log.exception("cb_browse_page: unexpected error: %s", exc)

    browse_state_update_page(msg.chat.id, msg.message_id, target_page)


async def cb_browse_item(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    q = update.callback_query
    if not q or not q.message or not q.data:
        return
    await _safe_answer(q)

    parts = q.data.split(":")
    if len(parts) != 3:
        return
    _, item_chat_s, origin_s = parts
    try:
        item_chat_id = int(item_chat_s)
        origin_message_id = int(origin_s)
    except ValueError:
        return

    from utmanager.db import item_get  # local import to avoid cycles

    item_info = item_get(item_chat_id, origin_message_id)
    if not item_info:
        await _safe_answer(q, text="Карточка недоступна.", show_alert=True)
        return

    try:
        await ctx.bot.copy_message(
            chat_id=q.message.chat.id,
            from_chat_id=item_chat_id,
            message_id=origin_message_id,
            message_thread_id=q.message.message_thread_id,
        )
    except Exception as exc:  # pragma: no cover - best effort
        log.debug("reuse copy failed: %s", exc)

    bucket = item_info.get("bucket") or ""
    topic_name = ""
    topic_id_for_item = item_info.get("topic_id")
    if topic_id_for_item:
        topic_info = topic_get(topic_id_for_item)
        if topic_info:
            bucket = topic_info[1] or bucket
            topic_name = topic_info[2]

    summary = _reuse_summary_text(item_info, topic_name or "(без темы)", bucket)
    summary += "\n\nВыберите тему или создайте новую."

    reuse_message = await send_silent_message(
        ctx,
        q.message.chat.id,
        summary,
        reply_to_message_id=q.message.message_id,
        message_thread_id=q.message.message_thread_id,
    )

    from utmanager.db import reuse_state_set

    reuse_state_set(q.message.chat.id, reuse_message.message_id, item_chat_id, origin_message_id, bucket)

    keyboard = _build_reuse_keyboard(
        message_id=reuse_message.message_id,
        item_chat_id=item_chat_id,
        bucket=bucket,
    )
    try:
        await ctx.bot.edit_message_reply_markup(
            chat_id=reuse_message.chat.id,
            message_id=reuse_message.message_id,
            reply_markup=keyboard,
        )
    except Exception:
        pass


async def cb_browse_close(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    q = update.callback_query
    if not q or not q.message:
        return
    await _safe_answer(q)

    msg: Message = cast(Message, q.message)
    browse_state_clear(msg.chat.id, msg.message_id)
    try:
        await ctx.bot.delete_message(chat_id=msg.chat.id, message_id=msg.message_id)
    except Exception:
        pass


__all__ = [
    "BROWSE_PAGE_SIZE",
    "cb_browse_close",
    "cb_browse_item",
    "cb_browse_open",
    "cb_browse_page",
]
