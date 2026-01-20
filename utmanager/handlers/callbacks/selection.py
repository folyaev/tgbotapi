"""Callbacks related to saving items and topic selection."""

from __future__ import annotations

from pathlib import Path
from typing import Optional, Tuple, cast

from telegram import Message, Update
from telegram.ext import ContextTypes

from utmanager.config import bucket_root, current_bucket
from utmanager.db import (
    db,
    filemap_delete,
    filemap_entries,
    filemap_get,
    filemap_set,
    item_apply_topic_tags,
    item_delete,
    item_get,
    item_update_bucket,
    item_update_topic_id,
    selection_set,
)
from utmanager.ui import add_reaction_done, kb_for_progress, kb_for_topic_picker

from .common import _safe_answer, log


def _ensure_unique(path: Path) -> Path:
    if not path.exists():
        return path
    stem = path.stem
    suffix = path.suffix
    counter = 2
    while True:
        candidate = path.with_name(f"{stem} ({counter}){suffix}")
        if not candidate.exists():
            return candidate
        counter += 1


def _move_saved_file(chat_id: int, progress_msg_id: int, topic_id: int) -> Optional[Tuple[str, str, str]]:
    record = filemap_get(chat_id, progress_msg_id)
    if not record:
        return None
    abs_path_s, bucket, category, _, origin_message_id = record
    topic_row = db("SELECT name FROM topics WHERE id=?", topic_id).fetchone()
    if not topic_row:
        log.warning("move: topic %s not found", topic_id)
        return None

    topic_name = topic_row[0]
    entries = filemap_entries(chat_id, progress_msg_id)

    def _move_single(src_path: Path, entry_bucket: str, entry_category: str, origin_id: int) -> Optional[Path]:
        target_dir = bucket_root(entry_bucket) / topic_name
        target_dir.mkdir(parents=True, exist_ok=True)
        candidate = target_dir / src_path.name
        try:
            if src_path.resolve() == candidate.resolve():
                return src_path
        except Exception:
            pass
        destination_path = _ensure_unique(candidate)
        try:
            src_path.replace(destination_path)
        except Exception:
            log.exception("move: failed %s -> %s", src_path, destination_path)
            return None
        filemap_set(
            chat_id,
            progress_msg_id,
            str(destination_path),
            entry_bucket,
            entry_category,
            origin_message_id=origin_id or origin_message_id,
        )
        return destination_path

    last_destination: Optional[Path] = None
    last_bucket = bucket
    last_category = category

    if entries:
        for entry_origin, entry_path, entry_bucket, entry_category in entries:
            src = Path(entry_path)
            if not src.exists():
                continue
            bucket_to_use = entry_bucket or bucket
            category_to_use = entry_category or category
            moved_path = _move_single(src, bucket_to_use, category_to_use, entry_origin)
            if moved_path:
                last_destination = moved_path
                last_bucket = bucket_to_use
                last_category = category_to_use
    else:
        if not abs_path_s:
            return None
        source = Path(abs_path_s)
        if not source.exists():
            return None
        last_destination = _move_single(source, bucket, category, origin_message_id)

    if last_destination is None:
        return None
    return last_bucket, last_category, str(last_destination)



async def cb_noop(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    await _safe_answer(update.callback_query)


async def cb_pick(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    q = update.callback_query
    if not q or not q.message or not q.data:
        return
    await _safe_answer(q)

    msg: Message = cast(Message, q.message)
    chat_id = msg.chat.id
    try:
        _, progress_s, topic_s = q.data.split(":")
        progress_msg_id = int(progress_s)
        topic_id = int(topic_s)
    except ValueError:
        log.warning("cb_pick: malformed payload %s", q.data)
        return

    selection_set(chat_id, progress_msg_id, topic_id)
    record = filemap_get(chat_id, progress_msg_id)
    bucket = record[1] if record else current_bucket(msg.date)
    origin_message_id = record[4] if record else (msg.reply_to_message.message_id if msg.reply_to_message else 0)
    origin_ids: list[int] = []
    entries = filemap_entries(chat_id, progress_msg_id)
    if entries:
        origin_ids = [entry_origin for entry_origin, _, _, _ in entries]
    elif origin_message_id:
        origin_ids = [origin_message_id]
    primary_origin_id = origin_message_id or (origin_ids[0] if origin_ids else 0)
    log.debug(
        "cb_pick: chat=%s progress=%s topic=%s bucket=%r origin=%s origins=%s record=%s",
        chat_id,
        progress_msg_id,
        topic_id,
        bucket,
        origin_message_id,
        origin_ids,
        record,
    )

    _move_saved_file(chat_id, progress_msg_id, topic_id)

    updated_any = False
    for origin_id in origin_ids:
        info = item_get(chat_id, origin_id)
        if not info:
            continue
        item_update_topic_id(chat_id, origin_id, topic_id)
        item_update_bucket(chat_id, origin_id, bucket)
        item_apply_topic_tags(chat_id, origin_id, topic_id)
        updated_any = True
        try:
            await add_reaction_done(ctx, chat_id, origin_id)
        except Exception:
            pass

    if updated_any and primary_origin_id:
        from utmanager.handlers.utils import render_item_summary

        await render_item_summary(
            ctx,
            chat_id=chat_id,
            progress_msg_id=progress_msg_id,
            topic_id=topic_id,
            bucket=bucket,
            origin_message_id=primary_origin_id,
        )
    elif not updated_any:
        try:
            await ctx.bot.edit_message_reply_markup(
                chat_id=chat_id,
                message_id=msg.message_id,
                reply_markup=kb_for_progress(chat_id, progress_msg_id, bucket),
            )
        except Exception:
            pass


async def cb_reopen(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    q = update.callback_query
    if not q or not q.message or not q.data:
        return
    await _safe_answer(q)

    msg: Message = cast(Message, q.message)
    chat_id = msg.chat.id
    _, progress_s = q.data.split(":")
    progress_msg_id = int(progress_s)

    record = filemap_get(chat_id, progress_msg_id)
    bucket = record[1] if record else current_bucket(msg.date)
    try:
        await ctx.bot.edit_message_reply_markup(
            chat_id=chat_id,
            message_id=msg.message_id,
            reply_markup=kb_for_topic_picker(chat_id, progress_msg_id, bucket),
        )
    except Exception:
        pass


async def cb_progress_delete(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    q = update.callback_query
    if not q or not q.message:
        return
    await _safe_answer(q)

    msg: Message = cast(Message, q.message)
    chat_id = msg.chat.id
    progress_msg_id = msg.message_id

    record = filemap_get(chat_id, progress_msg_id)
    if record:
        abs_path, _, _, _, origin_message_id = record
        try:
            Path(abs_path).unlink(missing_ok=True)  # type: ignore[arg-type]
        except Exception:
            pass
        filemap_delete(chat_id, progress_msg_id)
        db("DELETE FROM msg_selection WHERE chat_id=? AND progress_msg_id=?", chat_id, progress_msg_id)
        if origin_message_id:
            item_delete(chat_id, origin_message_id)

    try:
        await ctx.bot.delete_message(chat_id=chat_id, message_id=progress_msg_id)
    except Exception:
        pass


async def cb_topics_page(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    q = update.callback_query
    if not q or not q.message or not q.data:
        return
    await _safe_answer(q)

    msg: Message = cast(Message, q.message)
    chat_id = msg.chat.id
    _, progress_s, page_s = q.data.split(":")
    progress_msg_id = int(progress_s)
    page = int(page_s)

    from utmanager.db import ui_set_page as db_ui_set_page

    db_ui_set_page(chat_id, progress_msg_id, page)
    record = filemap_get(chat_id, progress_msg_id)
    bucket = record[1] if record else current_bucket(msg.date)
    try:
        await ctx.bot.edit_message_reply_markup(
            chat_id=chat_id,
            message_id=msg.message_id,
            reply_markup=kb_for_progress(chat_id, progress_msg_id, bucket),
        )
    except Exception:
        pass


__all__ = [
    "_ensure_unique",
    "_move_saved_file",
    "cb_noop",
    "cb_pick",
    "cb_progress_delete",
    "cb_reopen",
    "cb_topics_page",
]
