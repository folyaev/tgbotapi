"""UI helpers for progress messages and keyboards."""

from __future__ import annotations

import logging
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, cast

from telegram import InlineKeyboardButton, InlineKeyboardMarkup
from telegram.error import BadRequest
from telegram.ext import ContextTypes

from utmanager.config import local_dt
from utmanager.db import selection_get
from utmanager.db import ui_get_page as db_ui_get_page
from utmanager.topics import sync_topics_from_fs, topics_ordered

log = logging.getLogger(__name__)


_last_edit: Dict[Tuple[int, int], Tuple[int, float]] = {}


def progress_bar(progress: float, width: int = 10) -> str:
    progress = max(0.0, min(1.0, progress))
    filled = int(round(progress * width))
    return "#" * filled + "-" * (width - filled)


def format_progress_text(header: str, percent: int) -> str:
    width = 12
    filled = max(0, min(width, int(round((percent / 100) * width))))
    bar = "█" * filled + "░" * (width - filled)
    if percent >= 100:
        status_icon = "✅"
        status_text = "Готово! Контент сохранён."
    elif percent >= 60:
        status_icon = "📦"
        status_text = "Обрабатываем…"
    else:
        status_icon = "⬇️"
        status_text = "Скачиваем файл…"
    return f"{header}\n{status_icon} {status_text}\n{bar} {percent}%"

def format_download_progress_text(folder_label: str, percent: int, index: int = 1, total: int = 1) -> str:
    width = 12
    filled = max(0, min(width, int(round((percent / 100) * width))))
    bar = "█" * filled + "░" * (width - filled)
    total = max(1, total)
    index = max(1, min(index, total))
    header = f"📂 {folder_label} [{index}/{total}]"
    status = "✅ Готово! Контент сохранён." if percent >= 100 else "⬇️ Скачивание..."
    return f"{header}\n{status}\n{bar} {percent}%"


async def edit_progress(
    ctx: ContextTypes.DEFAULT_TYPE,
    chat_id: int,
    message_id: int,
    header: str,
    percent: int,
    bucket: str,
    throttle: bool = True,
) -> None:
    key = (chat_id, message_id)
    now = time.time()
    last_percent, last_ts = _last_edit.get(key, (None, 0.0))
    if throttle and last_percent is not None and percent - last_percent < 5 and now - last_ts < 1.0:
        return
    _last_edit[key] = (percent, now)

    text = format_progress_text(header, percent)
    try:
        await ctx.bot.edit_message_text(
            chat_id=chat_id,
            message_id=message_id,
            text=text,
            reply_markup=kb_for_progress(chat_id, message_id, bucket),
        )
        return
    except BadRequest as exc:
        if "message is not modified" in str(exc).lower():
            return
        try:
            await ctx.bot.edit_message_reply_markup(
                chat_id=chat_id,
                message_id=message_id,
                reply_markup=kb_for_progress(chat_id, message_id, bucket),
            )
            return
        except BadRequest as exc2:
            if "message is not modified" in str(exc2).lower():
                return
            log.exception("Failed to edit reply markup: %s", exc2)
    except Exception as exc:  # pragma: no cover
        log.exception("Failed to edit progress message: %s", exc)

async def edit_download_progress(
    ctx: ContextTypes.DEFAULT_TYPE,
    chat_id: int,
    message_id: int,
    folder_label: str,
    percent: int,
    index: int = 1,
    total: int = 1,
    throttle: bool = True,
) -> None:
    key = (chat_id, message_id)
    now = time.time()
    last_percent, last_ts = _last_edit.get(key, (None, 0.0))
    if throttle and last_percent is not None and percent - last_percent < 5 and now - last_ts < 1.0:
        return
    _last_edit[key] = (percent, now)

    text = format_download_progress_text(folder_label, percent, index=index, total=total)
    try:
        await ctx.bot.edit_message_text(
            chat_id=chat_id,
            message_id=message_id,
            text=text,
        )
    except BadRequest as exc:
        if "message is not modified" in str(exc).lower():
            return
        log.exception("Failed to edit download progress: %s", exc)
    except Exception as exc:  # pragma: no cover
        log.exception("Failed to edit download progress: %s", exc)


def kb_for_progress(chat_id: int, progress_msg_id: int, bucket: str) -> InlineKeyboardMarkup:
    selected = selection_get(chat_id, progress_msg_id)
    buttons: List[List[InlineKeyboardButton]] = []

    if selected is not None:
        from utmanager.db import db

        row = db("SELECT name FROM topics WHERE id=?", selected).fetchone()
        topic_name = row[0] if row else "Topic"
        buttons.append([InlineKeyboardButton(f"Topic selected: {topic_name}", callback_data="noop")])
        buttons.append([InlineKeyboardButton("Edit", callback_data=f"reopen:{progress_msg_id}")])
        return InlineKeyboardMarkup(buttons)

    return kb_for_topic_picker(chat_id, progress_msg_id, bucket)


def kb_for_topic_picker(chat_id: int, progress_msg_id: int, bucket: str) -> InlineKeyboardMarkup:
    buttons: List[List[InlineKeyboardButton]] = []

    try:
        sync_topics_from_fs(chat_id, bucket)
    except Exception:
        pass

    per_page = 6
    topics_list = topics_ordered(chat_id, bucket)
    total = len(topics_list)
    page = db_ui_get_page(chat_id, progress_msg_id)
    pages = max(1, (total + per_page - 1) // per_page)
    page = min(page, pages - 1)

    buttons.append([InlineKeyboardButton("Оставить без темы", callback_data=f"pick:{progress_msg_id}:0")])
    buttons.append([InlineKeyboardButton("+ New topic", callback_data=f"new:{progress_msg_id}")])
    start = page * per_page
    end = start + per_page
    for topic_id, name in topics_list[start:end]:
        buttons.append([InlineKeyboardButton(name, callback_data=f"pick:{progress_msg_id}:{topic_id}")])

    if pages > 1:
        buttons.append(
            [
                InlineKeyboardButton("<", callback_data=f"topics:{progress_msg_id}:{max(0, page - 1)}"),
                InlineKeyboardButton(f"{page + 1}/{pages}", callback_data="noop"),
                InlineKeyboardButton(">", callback_data=f"topics:{progress_msg_id}:{min(pages - 1, page + 1)}"),
            ]
        )

    return InlineKeyboardMarkup(buttons)


def kb_reopen(progress_msg_id: int) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        [[InlineKeyboardButton("Choose topic", callback_data=f"reopen:{progress_msg_id}")]]
    )


async def job_autodelete(ctx: ContextTypes.DEFAULT_TYPE) -> None:
    job = ctx.job
    if not job or not getattr(job, "data", None):
        return
    data = cast(Dict[str, Any], job.data)
    chat_id = int(data.get("chat_id", 0))
    message_id = int(data.get("message_id", 0))
    if not chat_id or not message_id:
        return
    try:
        await ctx.bot.delete_message(chat_id=chat_id, message_id=message_id)
    except Exception:  # pragma: no cover
        pass


async def schedule_autodelete(
    ctx: ContextTypes.DEFAULT_TYPE,
    chat_id: int,
    message_id: int,
    delay_s: int = 10,
) -> None:
    job_queue = ctx.job_queue
    if not job_queue:
        return
    try:
        job_queue.run_once(  # type: ignore[arg-type]
            job_autodelete,
            when=delay_s,
            data={"chat_id": chat_id, "message_id": message_id},
            name=f"autodel-{chat_id}-{message_id}",
        )
    except Exception:  # pragma: no cover
        pass


async def try_set_reaction(
    ctx: ContextTypes.DEFAULT_TYPE,
    chat_id: int,
    message_id: int,
    emojis: Optional[List[str]] = None,
    is_big: bool = False,
) -> None:
    emojis = emojis or ["❤️"]
    try:
        try:
            from telegram._inline.reactiontype import ReactionTypeEmoji  # type: ignore
        except Exception:  # pragma: no cover
            from telegram import ReactionTypeEmoji  # type: ignore

        await ctx.bot.set_message_reaction(
            chat_id=chat_id,
            message_id=message_id,
            reaction=[ReactionTypeEmoji(emoji=e) for e in emojis],  # type: ignore[arg-type]
            is_big=is_big,
        )
    except Exception:  # pragma: no cover
        pass


async def add_reaction_done(
    ctx: ContextTypes.DEFAULT_TYPE,
    chat_id: int,
    message_id: int,
) -> None:
    await try_set_reaction(ctx, chat_id, message_id, emojis=["✅"], is_big=True)


async def add_reaction_error(
    ctx: ContextTypes.DEFAULT_TYPE,
    chat_id: int,
    message_id: int,
) -> None:
    await try_set_reaction(ctx, chat_id, message_id, emojis=["❌"], is_big=False)


def format_finalize_text(files_count: int, folder: Path | str) -> str:
    count = max(1, files_count)
    folder_path = Path(folder)
    return f"Saved {count} file(s)\nFolder: {folder_path}"


def _format_created_at(created_at: str) -> str:
    if not created_at:
        return "-"
    try:
        parsed = datetime.fromisoformat(created_at)
    except Exception:
        return created_at
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    local = local_dt(parsed)
    return local.strftime("%d.%m.%Y")


def format_item_card(
    *,
    topic_name: str,
    kind: str,
    title: Optional[str],
    author: str,
    created_at: str,
    link: Optional[str],
    tags: List[str],
) -> str:
    lines: List[str] = []
    lines.append(f"Topic: {topic_name or '-'}")
    lines.append(f"Title: {title or '(empty)'}")
    type_map = {"Video": "📹", "Images": "🖼", "Documents": "📄"}
    type_display = type_map.get(kind, kind or "-")
    lines.append(f"Type: {type_display}")
    lines.append(f"Author: {author or 'Noname'}")
    lines.append(f"Date: {_format_created_at(created_at)}")
    lines.append(f"Tags: {', '.join(tags) if tags else '(none)'}")
    if link:
        lines.append(f"Link: {link}")
    return "\n".join(lines)



def item_actions_keyboard(
    chat_id: int,
    message_id: int,
    *,
    topic_id: int,
    topic_name: str,
    tags: List[Tuple[int, str]],
    author: str,
    date_display: str,
    kind: str,
) -> InlineKeyboardMarkup:
    rows: List[List[InlineKeyboardButton]] = []

    topic_label = topic_name or "-"
    rows.append(
        [
            InlineKeyboardButton(
                f"Topic: {topic_label}",
                callback_data=f"item:topic:{chat_id}:{message_id}",
            )
        ]
    )
    rows.append(
        [
            InlineKeyboardButton("Tags", callback_data=f"item:tags:{chat_id}:{message_id}"),
            InlineKeyboardButton("Author", callback_data=f"item:author:{chat_id}:{message_id}"),
        ]
    )
    rows.append(
        [
            InlineKeyboardButton("Title", callback_data=f"item:title:{chat_id}:{message_id}"),
            InlineKeyboardButton("Date", callback_data=f"item:date:{chat_id}:{message_id}"),
        ]
    )
    rows.append(
        [
            InlineKeyboardButton("Save", callback_data=f"item:save:{chat_id}:{message_id}"),
        ]
    )
    rows.append(
        [
            InlineKeyboardButton("Delete", callback_data=f"item:delete:{chat_id}:{message_id}"),
        ]
    )

    return InlineKeyboardMarkup(rows)



def topic_actions_keyboard(
    topic_id: int,
    bucket: str,
    tag_pairs: List[Tuple[int, str]],
    *,
    chat_id: Optional[int] = None,
    message_id: Optional[int] = None,
) -> InlineKeyboardMarkup:
    token = bucket or "-"
    rows: List[List[InlineKeyboardButton]] = [
        [InlineKeyboardButton("Добавить теги", callback_data=f"topic:addtags:{topic_id}:{token}")],
    ]
    if chat_id is not None and message_id is not None:
        rows.append([InlineKeyboardButton("К карточке", callback_data=f"item:refresh:{chat_id}:{message_id}")])
    for tag_id, tag_name in tag_pairs:
        rows.append([InlineKeyboardButton(f"#{tag_name}", callback_data=f"tag:view:{topic_id}:{tag_id}:0")])
    if not tag_pairs:
        rows.append([InlineKeyboardButton("No tags yet", callback_data="noop")])
    return InlineKeyboardMarkup(rows)


def format_topic_summary(topic_name: str, tags: List[str]) -> str:
    tags_text = ", ".join(tags) if tags else "(no tags)"
    return f"Topic: {topic_name}\nTags: {tags_text}"
