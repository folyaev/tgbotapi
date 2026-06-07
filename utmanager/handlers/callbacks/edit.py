"""Callbacks and helpers for editing item metadata."""

from __future__ import annotations

import re
from datetime import datetime
from typing import List, Optional, Tuple, cast

from telegram import InlineKeyboardButton, InlineKeyboardMarkup, Message, Update
from telegram.error import BadRequest
from telegram.ext import ContextTypes

from utmanager.config import TZ, TITLE_MAX_LEN, bucket_root, current_bucket, local_dt
from utmanager.db import (
    filemap_by_origin,
    filemap_get,
    item_delete,
    item_get,
    item_set_tags,
    item_update_author,
    item_update_created_at,
    item_update_bucket,
    item_update_topic_id,
    item_update_title,
    item_apply_topic_tags,
    last_topic_set,
    pending_newtopic_clear,
    pending_newtopic_get,
    pending_newtopic_set,
    pending_item_edit_clear,
    pending_item_edit_get,
    pending_item_edit_set,
    pending_tags_clear,
    pending_tags_get,
    tags_for_item,
    topic_create,
    topic_get,
    topic_set_tags,
)
from utmanager.topics import sync_topics_from_fs
from utmanager.handlers.utils import (
    record_thread_topic_from_message,
    render_item_card,
    render_item_summary,
    _cancel_followup_jobs,
)
from utmanager.telegram_utils import reply_silent, send_silent_message
from utmanager.ui import (
    _format_created_at,
    format_item_card,
    item_actions_keyboard,
    kb_for_item_topic_picker,
    kb_for_progress,
    kb_for_topic_picker,
    schedule_autodelete,
)

from .common import _is_admin, _safe_answer, log, log_action

__all__ = [
    "cb_item_action",
    "cb_item_edit",
    "cb_item_refresh",
    "cb_item_pick",
    "cb_item_topics_page",
    "cb_item_newtopic",
    "editcard_cmd",
    "text_catcher",
]

EDITCARD_STATE_KEY = "editcard_wait_link"
EDITCARD_INPUT_AUTODELETE_S = 30


def _parse_message_link(text: str) -> Optional[Tuple[int, int]]:
    """Parse a t.me/c/<chat>/<msg>[/<reply>] link into chat_id/message_id."""
    m = re.search(r"https?://t\.me/c/(\d+)/(?:\d+/)?(\d+)", text)
    if not m:
        return None
    raw_chat = int(m.group(1))
    msg_id = int(m.group(2))
    chat_id = -1000000000000 - raw_chat
    return chat_id, msg_id


async def _send_item_card(
    ctx: ContextTypes.DEFAULT_TYPE,
    *,
    target_chat_id: int,
    target_message_id: int,
    reply_to: Optional[Message],
) -> None:
    item = item_get(target_chat_id, target_message_id)
    if not item:
        if reply_to:
            await reply_silent(reply_to, "Карточка не найдена.")
        return

    topic_id = int(item.get("topic_id") or 0)
    topic_info = topic_get(topic_id) if topic_id else None
    topic_name = topic_info[2] if topic_info else "(none)"
    tag_pairs = tags_for_item(target_chat_id, target_message_id)
    tag_names = [name for _, name in tag_pairs]

    text = format_item_card(
        topic_name=topic_name,
        kind=item.get("kind", ""),
        title=item.get("title"),
        author=item.get("author", "Noname"),
        created_at=item.get("created_at", ""),
        link=item.get("link"),
        tags=tag_names,
    )
    keyboard = item_actions_keyboard(
        target_chat_id,
        target_message_id,
        topic_id=topic_id,
        topic_name=topic_name,
        tags=tag_pairs,
        author=item.get("author", "Noname") or "Noname",
        date_display=_format_created_at(item.get("created_at", "")),
        kind=item.get("kind", ""),
    )

    await send_silent_message(
        ctx,
        reply_to.chat.id if reply_to else target_chat_id,
        text,
        reply_markup=keyboard,
        reply_to_message_id=reply_to.message_id if reply_to else None,
        message_thread_id=getattr(reply_to, "message_thread_id", None),
    )


async def cb_item_edit(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    q = update.callback_query
    if not q or not q.data or not q.message:
        return
    await _safe_answer(q)

    try:
        _, _, chat_s, progress_s = q.data.split(":")
        item_chat_id = int(chat_s)
        progress_msg_id = int(progress_s)
    except ValueError:
        return

    info = filemap_get(item_chat_id, progress_msg_id)
    if not info:
        return
    _, bucket, _, _, origin_message_id = info
    item = item_get(item_chat_id, origin_message_id)
    topic_id = int(item.get("topic_id", 0)) if item else 0

    await render_item_card(
        ctx,
        chat_id=item_chat_id,
        progress_msg_id=progress_msg_id,
        topic_id=topic_id,
        bucket=bucket,
        origin_message_id=origin_message_id,
    )
    # schedule auto-delete of the card after 5 minutes
    await schedule_autodelete(ctx, item_chat_id, progress_msg_id, delay_s=300)


async def cb_item_refresh(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    q = update.callback_query
    if not q or not q.data or not q.message:
        return
    await _safe_answer(q)

    try:
        _, _, chat_s, progress_s = q.data.split(":")
        item_chat_id = int(chat_s)
        progress_msg_id = int(progress_s)
    except ValueError:
        return

    info = filemap_get(item_chat_id, progress_msg_id)
    if not info:
        return
    _, bucket, _, _, origin_message_id = info
    item = item_get(item_chat_id, origin_message_id)
    topic_id = int(item.get("topic_id", 0)) if item else 0

    await render_item_card(
        ctx,
        chat_id=item_chat_id,
        progress_msg_id=progress_msg_id,
        topic_id=topic_id,
        bucket=bucket,
        origin_message_id=origin_message_id,
    )


async def cb_item_action(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    q = update.callback_query
    if not q or not q.data or not q.message or not q.from_user:
        return

    try:
        _, field, chat_s, message_s = q.data.split(":")
    except ValueError:
        return

    item_chat_id = int(chat_s)
    item_message_id = int(message_s)
    user_id = q.from_user.id

    if not await _is_admin(ctx, item_chat_id, user_id):
        await _safe_answer(q, text="\u041d\u0435\u0434\u043e\u0441\u0442\u0430\u0442\u043e\u0447\u043d\u043e \u043f\u0440\u0430\u0432 \u0434\u043b\u044f \u0440\u0435\u0434\u0430\u043a\u0442\u0438\u0440\u043e\u0432\u0430\u043d\u0438\u044f.", show_alert=True)
        return

    item = item_get(item_chat_id, item_message_id)
    if not item:
        await _safe_answer(q, text="\u041a\u0430\u0440\u0442\u043e\u0447\u043a\u0430 \u043d\u0435 \u043d\u0430\u0439\u0434\u0435\u043d\u0430.", show_alert=True)
        return

    if field == "topic":
        bucket = item.get("bucket") or current_bucket(q.message.date)
        try:
            await ctx.bot.edit_message_reply_markup(
                chat_id=q.message.chat.id,
                message_id=q.message.message_id,
                reply_markup=kb_for_item_topic_picker(
                    item_chat_id,
                    q.message.message_id,
                    bucket,
                    item_message_id=item_message_id,
                ),
            )
        except Exception:
            pass
        await _safe_answer(q)
        return

    if field == "save":
        file_info = filemap_by_origin(item_chat_id, item_message_id)
        progress_msg_id = q.message.message_id if q.message else item_message_id
        bucket = item.get("bucket") or current_bucket(q.message.date)
        if file_info and file_info[0] == progress_msg_id:
            bucket = file_info[2] or bucket
        topic_id = int(item.get("topic_id", 0))
        await render_item_summary(
            ctx,
            chat_id=item_chat_id,
            progress_msg_id=progress_msg_id,
            topic_id=topic_id,
            bucket=bucket,
            origin_message_id=item_message_id,
        )
        await _safe_answer(q)
        return

    if field == "download":
        progress_msg_id = q.message.message_id if q.message else item_message_id
        bucket = item.get("bucket") or current_bucket(q.message.date)
        topic_id = int(item.get("topic_id", 0))
        await render_item_summary(
            ctx,
            chat_id=item_chat_id,
            progress_msg_id=progress_msg_id,
            topic_id=topic_id,
            bucket=bucket,
            origin_message_id=item_message_id,
        )
        await _safe_answer(q)
        from utmanager.handlers.media import download_item_content

        await download_item_content(
            ctx,
            item_chat_id=item_chat_id,
            item_message_id=item_message_id,
            card_message_id=progress_msg_id,
            reply_to_message_id=progress_msg_id,
        )
        return

    if field == "delete":
        item_delete(item_chat_id, item_message_id)
        await _safe_answer(q, text="\u0423\u0434\u0430\u043b\u0435\u043d\u043e.", show_alert=True)
        try:
            await ctx.bot.edit_message_text(
                chat_id=q.message.chat.id,
                message_id=q.message.message_id,
                text="\u041a\u0430\u0440\u0442\u043e\u0447\u043a\u0430 \u0443\u0434\u0430\u043b\u0435\u043d\u0430.",
            )
        except Exception:
            pass
        return

    if field == "tags":
        keyboard = InlineKeyboardMarkup(
            [
                [
                    InlineKeyboardButton("Add", callback_data=f"item:tagsadd:{item_chat_id}:{item_message_id}"),
                    InlineKeyboardButton("Rewrite", callback_data=f"item:tagsrewrite:{item_chat_id}:{item_message_id}"),
                ]
            ]
        )
        await send_silent_message(
            ctx,
            q.message.chat.id,
            "\u0422\u0435\u0433\u0438: \u0432\u044b\u0431\u0440\u0430\u0442\u044c \u0434\u0435\u0439\u0441\u0442\u0432\u0438\u0435.",
            reply_to_message_id=q.message.message_id,
            message_thread_id=q.message.message_thread_id,
            reply_markup=keyboard,
        )
        await _safe_answer(q)
        return

    edit_field = field
    if field == "tagsadd":
        edit_field = "tags_add"
    elif field == "tagsrewrite":
        edit_field = "tags_rewrite"

    if field in {"tagsadd", "tagsrewrite"}:
        try:
            await ctx.bot.delete_message(chat_id=q.message.chat.id, message_id=q.message.message_id)
        except Exception:
            pass

    existing_tags = [name for _, name in tags_for_item(item_chat_id, item_message_id)]
    prompts = {
        "tags_add": "\u0412\u0432\u0435\u0434\u0438\u0442\u0435 \u0442\u0435\u0433\u0438 \u0447\u0435\u0440\u0435\u0437 \u0437\u0430\u043f\u044f\u0442\u0443\u044e (\u0431\u0443\u0434\u0443\u0442 \u0434\u043e\u0431\u0430\u0432\u043b\u0435\u043d\u044b).",
        "tags_rewrite": "\u0412\u0432\u0435\u0434\u0438\u0442\u0435 \u0442\u0435\u0433\u0438 \u0447\u0435\u0440\u0435\u0437 \u0437\u0430\u043f\u044f\u0442\u0443\u044e (\u0437\u0430\u043c\u0435\u043d\u044f\u0442 \u0442\u0435\u043a\u0443\u0449\u0438\u0435).",
        "author": "\u0412\u0432\u0435\u0434\u0438\u0442\u0435 \u0430\u0432\u0442\u043e\u0440\u0430.",
        "title": "\u0412\u0432\u0435\u0434\u0438\u0442\u0435 \u0437\u0430\u0433\u043e\u043b\u043e\u0432\u043e\u043a.",
        "date": "\u0412\u0432\u0435\u0434\u0438\u0442\u0435 \u0434\u0430\u0442\u0443 (\u043d\u0430\u043f\u0440\u0438\u043c\u0435\u0440 25.11.2025 \u0438\u043b\u0438 2025-11-25).",
    }
    text = prompts.get(edit_field)
    if not text:
        await _safe_answer(q)
        return

    if edit_field in {"tags_add", "tags_rewrite"} and existing_tags:
        text += f"\n\u0421\u0435\u0439\u0447\u0430\u0441: {', '.join(existing_tags)}"
    if edit_field == "author" and item.get("author"):
        text += f"\n\u0421\u0435\u0439\u0447\u0430\u0441: {item.get('author')}"
    if edit_field == "title" and item.get("title"):
        text += f"\n\u0421\u0435\u0439\u0447\u0430\u0441: {item.get('title')}"
    if edit_field == "date" and item.get("created_at"):
        text += f"\n\u0421\u0435\u0439\u0447\u0430\u0441: {_format_created_at(item.get('created_at', ''))}"

    prompt = await send_silent_message(
        ctx,
        q.message.chat.id,
        text,
        reply_to_message_id=q.message.message_id,
        message_thread_id=q.message.message_thread_id,
    )

    pending_item_edit_clear(q.message.chat.id, user_id)
    pending_item_edit_set(
        q.message.chat.id,
        user_id,
        item_chat_id,
        item_message_id,
        edit_field,
        prompt.message_id,
        q.message.message_id,
    )
    await _safe_answer(q)
    log_action(
        "item.edit_prompt",
        chat_id=q.message.chat.id,
        user_id=user_id,
        field=edit_field,
        item_chat=item_chat_id,
        item_message=item_message_id,
    )


def _parse_date(text: str) -> Tuple[str, bool]:
    """Try to parse date; returns (value_to_store, parsed_ok)."""
    raw = text.strip()
    for fmt in ("%d.%m.%Y", "%Y-%m-%d"):
        try:
            parsed = datetime.strptime(raw, fmt)
            if TZ:
                parsed = parsed.replace(tzinfo=TZ)
            return parsed.isoformat(), True
        except Exception:
            continue
    return raw, False


async def _handle_pending_item_edit(
    ctx: ContextTypes.DEFAULT_TYPE,
    *,
    msg: Message,
    item_chat_id: int,
    item_message_id: int,
    field: str,
    prompt_message_id: int,
    context_message_id: int,
) -> None:
    text = (msg.text or "").strip()
    if prompt_message_id:
        try:
            await ctx.bot.delete_message(chat_id=msg.chat.id, message_id=prompt_message_id)
        except Exception:
            pass

    item = item_get(item_chat_id, item_message_id)
    if not item:
        await reply_silent(msg, "Карточка не найдена.")
        return

    parsed_ok = True
    if field in {"tags", "tags_add", "tags_rewrite"}:
        tags = [t.strip() for t in text.split(",") if t.strip()]
        if field == "tags_add":
            existing = [name for _, name in tags_for_item(item_chat_id, item_message_id)]
            merged = existing[:]
            for tag in tags:
                if tag not in merged:
                    merged.append(tag)
            item_set_tags(item_chat_id, item_message_id, merged)
        else:
            item_set_tags(item_chat_id, item_message_id, tags)
    elif field == "author":
        item_update_author(item_chat_id, item_message_id, text[:128])
    elif field == "title":
        item_update_title(item_chat_id, item_message_id, text[:TITLE_MAX_LEN])
    elif field == "date":
        value, parsed_ok = _parse_date(text)
        item_update_created_at(item_chat_id, item_message_id, value)

    file_info = filemap_by_origin(item_chat_id, item_message_id)
    bucket = file_info[2] if file_info else (item.get("bucket") or current_bucket(msg.date))
    progress_msg_id = context_message_id or (file_info[0] if file_info else item_message_id)
    topic_id = int(item.get("topic_id", 0))

    await render_item_card(
        ctx,
        chat_id=item_chat_id,
        progress_msg_id=progress_msg_id,
        topic_id=topic_id,
        bucket=bucket,
        origin_message_id=item_message_id,
    )
    # no extra confirmation message; just clean up user input
    await schedule_autodelete(ctx, msg.chat.id, msg.message_id, delay_s=30)


async def _handle_pending_topic_tags(
    ctx: ContextTypes.DEFAULT_TYPE,
    *,
    msg: Message,
    topic_id: int,
    source_message_id: int,
    prompt_message_id: int,
) -> None:
    text = (msg.text or "").strip()
    tags = [t.strip() for t in text.split(",") if t.strip()]
    topic_set_tags(topic_id, tags)
    if prompt_message_id:
        try:
            await ctx.bot.delete_message(chat_id=msg.chat.id, message_id=prompt_message_id)
        except Exception:
            pass
    await reply_silent(msg, f"Теги обновлены: {', '.join(tags) if tags else '(пусто)'}", disable_notification=True)
    await schedule_autodelete(ctx, msg.chat.id, msg.message_id, delay_s=30)

    try:
        from utmanager.handlers.callbacks.topics import _render_topic_summary

        await _render_topic_summary(ctx, msg.chat.id, source_message_id, topic_id)
    except Exception:
        log.debug("Failed to refresh topic summary after tags update", exc_info=True)


async def cb_item_pick(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    q = update.callback_query
    if not q or not q.message or not q.data:
        return
    await _safe_answer(q)

    try:
        _, card_s, item_chat_s, item_msg_s, topic_s = q.data.split(":")
        card_message_id = int(card_s)
        item_chat_id = int(item_chat_s)
        item_message_id = int(item_msg_s)
        topic_id = int(topic_s)
    except ValueError:
        return

    item = item_get(item_chat_id, item_message_id)
    if not item:
        await reply_silent(q.message, "Карточка не найдена.")
        return

    bucket = item.get("bucket") or current_bucket(q.message.date)
    topic_info = topic_get(topic_id) if topic_id else None
    if topic_info:
        bucket = topic_info[1] or bucket

    item_update_topic_id(item_chat_id, item_message_id, topic_id)
    item_update_bucket(item_chat_id, item_message_id, bucket)
    if topic_id:
        item_apply_topic_tags(item_chat_id, item_message_id, topic_id)
        last_topic_set(item_chat_id, bucket, topic_id)

    await render_item_card(
        ctx,
        chat_id=item_chat_id,
        progress_msg_id=card_message_id,
        topic_id=topic_id,
        bucket=bucket,
        origin_message_id=item_message_id,
    )


async def cb_item_topics_page(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    q = update.callback_query
    if not q or not q.message or not q.data:
        return
    await _safe_answer(q)

    try:
        _, card_s, item_chat_s, item_msg_s, page_s = q.data.split(":")
        card_message_id = int(card_s)
        item_chat_id = int(item_chat_s)
        item_message_id = int(item_msg_s)
        page = int(page_s)
    except ValueError:
        return

    from utmanager.db import ui_set_page as db_ui_set_page

    db_ui_set_page(item_chat_id, card_message_id, page)
    item = item_get(item_chat_id, item_message_id)
    bucket = item.get("bucket") if item else current_bucket(q.message.date)
    try:
        await ctx.bot.edit_message_reply_markup(
            chat_id=q.message.chat.id,
            message_id=card_message_id,
            reply_markup=kb_for_item_topic_picker(
                item_chat_id,
                card_message_id,
                bucket or "",
                item_message_id=item_message_id,
            ),
        )
    except Exception:
        pass


async def cb_item_newtopic(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    q = update.callback_query
    if not q or not q.message or not q.data:
        return
    await _safe_answer(q)

    try:
        _, card_s, item_chat_s, item_msg_s = q.data.split(":")
        card_message_id = int(card_s)
        item_chat_id = int(item_chat_s)
        item_message_id = int(item_msg_s)
    except ValueError:
        return

    msg: Message = cast(Message, q.message)
    chat_id = msg.chat.id
    user_id = q.from_user.id

    item = item_get(item_chat_id, item_message_id)
    bucket = (item.get("bucket") if item else "") or current_bucket(msg.date)

    pending_item_edit_clear(chat_id, user_id)
    pending_tags_clear(chat_id, user_id)
    pending_newtopic_set(chat_id, user_id, card_message_id, item_message_id, bucket, msg.message_id)

    prompt_kwargs = {
        "message_thread_id": msg.message_thread_id,
        "reply_to_message_id": msg.message_id,
    }
    try:
        prompt = await send_silent_message(
            ctx,
            chat_id,
            "Send the new topic name in the next message.",
            **prompt_kwargs,
        )
    except BadRequest as exc:
        if "message thread not found" not in str(exc).lower():
            raise
        prompt_kwargs.pop("message_thread_id", None)
        prompt = await send_silent_message(
            ctx,
            chat_id,
            "Send the new topic name in the next message.",
            **prompt_kwargs,
        )

    pending_newtopic_set(chat_id, user_id, card_message_id, item_message_id, bucket, prompt.message_id)
    await schedule_autodelete(ctx, chat_id, prompt.message_id, delay_s=30)


async def text_catcher(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    msg = update.message
    if not msg or not update.effective_chat or not update.effective_user:
        return

    record_thread_topic_from_message(msg)

    chat_id = msg.chat.id
    user_id = msg.from_user.id

    # Handle pending new topic creation
    pending_newtopic = pending_newtopic_get(chat_id, user_id)
    if pending_newtopic:
        progress_msg_id, source_message_id, bucket, instruction_message_id = pending_newtopic
        pending_newtopic_clear(chat_id, user_id)
        name = (msg.text or "").strip()
        if not name:
            await reply_silent(msg, "Имя темы пустое, попробуйте снова.")
            return
        topic_id = topic_create(chat_id, bucket, name)
        last_topic_set(chat_id, bucket, topic_id)
        # Ensure folder exists so sync doesn't drop the new topic.
        try:
            (bucket_root(bucket) / name).mkdir(parents=True, exist_ok=True)
        except Exception:
            log.debug("Failed to create topic folder", exc_info=True)
        try:
            sync_topics_from_fs(chat_id, bucket)
        except Exception:
            pass
        confirm = await reply_silent(msg, f"Тема создана: {name}", disable_notification=True)
        if progress_msg_id:
            try:
                _cancel_followup_jobs(ctx, chat_id, progress_msg_id)
                if filemap_get(chat_id, progress_msg_id):
                    keyboard = kb_for_progress(chat_id, progress_msg_id, bucket)
                else:
                    keyboard = kb_for_item_topic_picker(
                        chat_id,
                        progress_msg_id,
                        bucket,
                        item_message_id=source_message_id or progress_msg_id,
                    )
                await ctx.bot.edit_message_reply_markup(
                    chat_id=chat_id,
                    message_id=progress_msg_id,
                    reply_markup=keyboard,
                )
            except Exception:
                pass
        # auto-delete instruction prompt to reduce clutter
        if instruction_message_id and instruction_message_id != progress_msg_id:
            try:
                await ctx.bot.delete_message(chat_id=chat_id, message_id=instruction_message_id)
            except Exception:
                pass
        await schedule_autodelete(ctx, chat_id, msg.message_id, delay_s=30)
        await schedule_autodelete(ctx, chat_id, confirm.message_id, delay_s=30)
        return

    # Handle pending item edits and tags first
    pending_edit = pending_item_edit_get(chat_id, user_id)
    if pending_edit:
        item_chat_id, item_message_id, field, prompt_message_id, context_message_id = pending_edit
        pending_item_edit_clear(chat_id, user_id)
        ctx.chat_data.pop(EDITCARD_STATE_KEY, None)
        await _handle_pending_item_edit(
            ctx,
            msg=msg,
            item_chat_id=item_chat_id,
            item_message_id=item_message_id,
            field=field,
            prompt_message_id=prompt_message_id,
            context_message_id=context_message_id,
        )
        return

    pending_tags = pending_tags_get(chat_id, user_id)
    if pending_tags:
        topic_id, source_message_id, prompt_message_id = pending_tags
        pending_tags_clear(chat_id, user_id)
        ctx.chat_data.pop(EDITCARD_STATE_KEY, None)
        await _handle_pending_topic_tags(
            ctx,
            msg=msg,
            topic_id=topic_id,
            source_message_id=source_message_id,
            prompt_message_id=prompt_message_id,
        )
        return


    if ctx.chat_data.get(EDITCARD_STATE_KEY):
        parsed = _parse_message_link(msg.text or "")
        if not parsed:
            await reply_silent(msg, "Не смог разобрать ссылку. Пример: https://t.me/c/<id>/<message>")
            return
        ctx.chat_data.pop(EDITCARD_STATE_KEY, None)
        target_chat_id, target_message_id = parsed
        await _send_item_card(ctx, target_chat_id=target_chat_id, target_message_id=target_message_id, reply_to=msg)
        return

async def editcard_cmd(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    msg = update.message
    if not msg:
        return
    await schedule_autodelete(ctx, msg.chat.id, msg.message_id, delay_s=EDITCARD_INPUT_AUTODELETE_S)

    link = None
    if ctx.args:
        link = ctx.args[0]
    else:
        parts = (msg.text or "").split(maxsplit=1)
        if len(parts) > 1:
            link = parts[1]

    if not link:
        ctx.chat_data[EDITCARD_STATE_KEY] = True
        await reply_silent(msg, "Пришли ссылку на сообщение (t.me/c/...).")
        return

    parsed = _parse_message_link(link)
    if not parsed:
        await reply_silent(msg, "Не смог разобрать ссылку. Пример: https://t.me/c/<id>/<message>")
        return

    target_chat_id, target_message_id = parsed
    await _send_item_card(ctx, target_chat_id=target_chat_id, target_message_id=target_message_id, reply_to=msg)
