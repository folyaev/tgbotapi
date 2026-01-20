"""Callbacks for topic management and tagging workflows."""

from __future__ import annotations

from typing import Any, Iterable, List, Optional, Tuple, cast

from telegram import InlineKeyboardButton, InlineKeyboardMarkup, Message, Update
from telegram.error import BadRequest
from telegram.ext import ContextTypes

from utmanager.config import current_bucket
from utmanager.db import (
    db,
    items_by_tag,
    pending_item_edit_clear,
    pending_newtopic_set,
    pending_tags_clear,
    pending_tags_get,
    pending_tags_set,
    tag_name,
    tags_for_item,
    topic_get,
    topic_tags,
)
from utmanager.topics import sync_topics_from_fs
from utmanager.ui import format_item_card, format_topic_summary, schedule_autodelete, topic_actions_keyboard
from utmanager.telegram_utils import send_silent_message
from utmanager.handlers.utils import _cancel_followup_jobs

from .common import _is_admin, _safe_answer, log, log_action


def _bucket_token(bucket: str) -> str:
    return bucket or "-"


def _bucket_from_token(token: str) -> str:
    return "" if token in {"-", "None", "none"} else token


def _management_keyboard(bucket: str) -> InlineKeyboardMarkup:
    token = _bucket_token(bucket)
    return InlineKeyboardMarkup(
        [
            [InlineKeyboardButton("Create topic", callback_data=f"newtopic:create:{token}")],
            [InlineKeyboardButton("Refresh folders", callback_data=f"newtopic:resync:{token}")],
        ]
    )


async def _render_topic_summary(
    ctx: ContextTypes.DEFAULT_TYPE,
    chat_id: int,
    message_id: int,
    topic_id: int,
) -> None:
    info = topic_get(topic_id)
    if not info:
        return
    _, bucket, name = info
    tag_pairs = topic_tags(topic_id)
    text = format_topic_summary(name, [tag for _, tag in tag_pairs])
    keyboard = topic_actions_keyboard(topic_id, bucket, tag_pairs, chat_id=chat_id, message_id=message_id)
    try:
        await ctx.bot.edit_message_text(
            chat_id=chat_id,
            message_id=message_id,
            text=text,
            reply_markup=keyboard,
        )
    except BadRequest as exc:
        lowered = str(exc).lower()
        if "message is not modified" in lowered:
            return
        log.debug("Topic summary update failed: %s", exc)
    except Exception:
        log.exception("Failed to render topic summary")


def _item_summary_text(item: dict[str, Any], topic_name: str, tags: Iterable[str]) -> str:
    return format_item_card(
        topic_name=topic_name,
        kind=item.get("kind", ""),
        title=item.get("title"),
        author=item.get("author", "Noname"),
        created_at=item.get("created_at", ""),
        link=item.get("link"),
        tags=list(tags),
    )


async def cb_new(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    q = update.callback_query
    if not q or not q.message or not q.data:
        return
    msg: Message = cast(Message, q.message)
    chat_id = msg.chat.id
    user_id = q.from_user.id

    await _safe_answer(q)
    _, progress_s = q.data.split(":")
    progress_msg_id = int(progress_s)

    source_msg_id = msg.reply_to_message.message_id if msg.reply_to_message else 0
    bucket = current_bucket(msg.date)
    _cancel_followup_jobs(ctx, chat_id, progress_msg_id)

    pending_item_edit_clear(chat_id, user_id)
    existing_pending = pending_tags_get(chat_id, user_id)
    if existing_pending:
        _, _, old_prompt_id = existing_pending
        if old_prompt_id:
            try:
                await ctx.bot.delete_message(chat_id=chat_id, message_id=old_prompt_id)
            except Exception:
                pass

    pending_tags_clear(chat_id, user_id)

    # record pending new topic; prompt id will be updated below
    pending_newtopic_set(
        chat_id,
        user_id,
        progress_msg_id,
        source_msg_id,
        bucket,
        msg.message_id,
    )
    log_action(
        "topic.new_prompt",
        chat_id=chat_id,
        user_id=user_id,
        progress_msg_id=progress_msg_id,
        bucket=bucket or "-",
    )

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

    pending_newtopic_set(
        chat_id,
        user_id,
        progress_msg_id,
        source_msg_id,
        bucket,
        prompt.message_id,
    )
    await schedule_autodelete(ctx, chat_id, prompt.message_id, delay_s=30)


async def cb_newtopic_action(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    q = update.callback_query
    if not q or not q.message or not q.data:
        return
    await _safe_answer(q)

    try:
        _, action, token = q.data.split(":")
    except ValueError:
        return

    bucket = _bucket_from_token(token)
    msg: Message = cast(Message, q.message)
    chat_id = msg.chat.id
    user_id = q.from_user.id

    if action == "create":
        pending_item_edit_clear(chat_id, user_id)

        pending_tags_clear(chat_id, user_id)
        pending_newtopic_set(chat_id, user_id, 0, 0, bucket, msg.message_id)
        text = "Send the new topic name in the next message."
        if bucket:
            text += f"\nBucket: {bucket}"
        try:
            await ctx.bot.edit_message_text(
                chat_id=chat_id,
                message_id=msg.message_id,
                text=text,
                reply_markup=_management_keyboard(bucket),
            )
        except Exception:
            pass
        log_action("topic.manage_open", chat_id=chat_id, user_id=user_id, bucket=bucket or "-")
        return

    if action == "resync":
        try:
            added = sync_topics_from_fs(chat_id, bucket)
            text = "РџР°РїРєРё РѕР±РЅРѕРІР»РµРЅС‹"
            if added:
                text += f"; +{added} РЅРѕРІС‹С…"
        except Exception as exc:
            text = f"РЎРёРЅС…СЂРѕРЅРёР·Р°С†РёСЏ РїР°РїРѕРє РЅРµ СѓРґР°Р»Р°СЃСЊ: {exc}"
        try:
            await ctx.bot.edit_message_text(
                chat_id=chat_id,
                message_id=msg.message_id,
                text=text,
                reply_markup=_management_keyboard(bucket),
            )
        except Exception:
            pass
        log_action(
            "topic.resync",
            chat_id=chat_id,
            user_id=user_id,
            bucket=bucket or "-",
            added=locals().get("added", 0),
        )


async def cb_topic_addtags(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    q = update.callback_query
    if not q or not q.message or not q.data:
        return
    await _safe_answer(q)

    try:
        _, _, topic_s, token = q.data.split(":")
    except ValueError:
        return

    topic_id = int(topic_s)
    msg: Message = cast(Message, q.message)
    chat_id = msg.chat.id
    user_id = q.from_user.id

    if not await _is_admin(ctx, chat_id, user_id):
        await _safe_answer(q, text="РќРµРґРѕСЃС‚Р°С‚РѕС‡РЅРѕ РїСЂР°РІ: С‚РѕР»СЊРєРѕ Р°РґРјРёРЅС‹.", show_alert=True)
        return

    pending_tags_clear(chat_id, user_id)
    existing = [name for _, name in topic_tags(topic_id)]
    text = "РџСЂРёС€Р»РёС‚Рµ С‚РµРіРё РґР»СЏ СЌС‚РѕР№ С‚РµРјС‹ С‡РµСЂРµР· Р·Р°РїСЏС‚СѓСЋ."
    if existing:
        text += f"\nРЎРµР№С‡Р°СЃ: {', '.join(existing)}"
    prompt = await send_silent_message(
        ctx,
        chat_id,
        text,
        message_thread_id=msg.message_thread_id,
        reply_to_message_id=msg.message_id,
    )
    log_action(
        "topic.addtags_prompt",
        chat_id=chat_id,
        user_id=user_id,
        topic_id=topic_id,
        existing=len(existing),
    )
    log.debug(
        "cb_topic_addtags: chat=%s topic=%s prompt_msg=%s existing=%s",
        chat_id,
        topic_id,
        prompt.message_id,
        existing,
    )
    pending_tags_set(chat_id, user_id, topic_id, msg.message_id, prompt.message_id)
    log.debug(
        "cb_topic_addtags: pending_tags_set chat=%s user=%s topic=%s message=%s prompt=%s",
        chat_id,
        user_id,
        topic_id,
        msg.message_id,
        prompt.message_id,
    )


async def cb_topic_view(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    q = update.callback_query
    if not q or not q.message or not q.data:
        return
    await _safe_answer(q)

    try:
        _, _, topic_s, token = q.data.split(":")
    except ValueError:
        return

    topic_id = int(topic_s)
    msg: Message = cast(Message, q.message)
    await _render_topic_summary(ctx, msg.chat.id, msg.message_id, topic_id)


async def cb_tag_view(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    q = update.callback_query
    if not q or not q.message or not q.data:
        return
    await _safe_answer(q)

    try:
        _, _, topic_s, tag_s, page_s = q.data.split(":")
    except ValueError:
        return

    topic_id = int(topic_s)
    tag_id = int(tag_s)
    page = max(0, int(page_s))
    msg: Message = cast(Message, q.message)

    topic_info = topic_get(topic_id)
    tag_title = tag_name(tag_id)
    if not topic_info or not tag_title:
        return

    items = items_by_tag(tag_id, page)
    topic_tags_list = topic_tags(topic_id)
    lines = [
        f"Tag: {tag_title}",
        f"Page: {page + 1}",
        "",
    ]
    if not items:
        lines.append("No items yet.")
    else:
        for item in items:
            topic_info_for_item = topic_get(item["topic_id"])
            if not topic_info_for_item:
                continue
            tag_pairs = tags_for_item(item["chat_id"], item["message_id"])
            lines.append(
                _item_summary_text(
                    item,
                    topic_info_for_item[2],
                    [name for _, name in tag_pairs],
                )
            )
            lines.append("")

    text = "\n".join(lines).strip()
    nav_buttons: List[InlineKeyboardButton] = []
    if page > 0:
        nav_buttons.append(InlineKeyboardButton("<", callback_data=f"tag:view:{topic_id}:{tag_id}:{page - 1}"))
    if len(items) == 10:
        nav_buttons.append(InlineKeyboardButton(">", callback_data=f"tag:view:{topic_id}:{tag_id}:{page + 1}"))

    base_keyboard = topic_actions_keyboard(
        topic_id,
        topic_info[1],
        topic_tags_list,
        chat_id=msg.chat.id,
        message_id=msg.message_id,
    )
    rows: List[List[InlineKeyboardButton]] = [row[:] for row in base_keyboard.inline_keyboard]
    if nav_buttons:
        rows.append(nav_buttons)
    rows.append(
        [
            InlineKeyboardButton(
                "Рљ С‚РµРјРµ",
                callback_data=f"topic:view:{topic_id}:{_bucket_token(topic_info[1])}",
            )
        ]
    )

    try:
        await ctx.bot.edit_message_text(
            chat_id=msg.chat.id,
            message_id=msg.message_id,
            text=text,
            reply_markup=InlineKeyboardMarkup(rows),
        )
    except Exception:
        pass


__all__ = [
    "_bucket_from_token",
    "_bucket_token",
    "_item_summary_text",
    "_management_keyboard",
    "_render_topic_summary",
    "cb_new",
    "cb_newtopic_action",
    "cb_tag_view",
    "cb_topic_addtags",
    "cb_topic_view",
]
