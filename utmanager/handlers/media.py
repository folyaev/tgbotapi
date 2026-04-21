"""Handlers for media messages: download, progress UI, storage."""

from __future__ import annotations

import logging
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Tuple, cast

from telegram import Animation, Chat, Document, InlineKeyboardButton, InlineKeyboardMarkup, Message, PhotoSize, Update, Video
from telegram.constants import MessageEntityType
from telegram.ext import ContextTypes

from utmanager.config import (
    ALLOWED,
    MAX_SIZE,
    TGGROUP_LINK,
    TITLE_MAX_LEN,
    bucket_root,
    current_bucket,
    safe,
    ts_name,
)
from utmanager.db import (
    db,
    filemap_entries,
    filemap_set,
    item_get,
    item_apply_topic_tags,
    item_set_tags,
    item_update_author,
    item_update_bucket,
    item_upsert,
    seen_file_get,
    seen_file_upsert,
    selection_get,
    topic_get,
    thread_topic_get,
)
from utmanager.jobs import close_selector_job, finalize_post_job
from utmanager.storage import get_file_by_id_with_retry, get_file_with_retry, local_abs_path_for, stream_download
from utmanager.ui import (
    add_reaction_done,
    add_reaction_error,
    edit_download_progress,
    edit_progress,
    format_download_progress_text,
    format_progress_text,
    kb_for_progress,
    schedule_autodelete,
)
from utmanager.handlers.utils import record_thread_topic_from_message, render_item_card, render_item_summary
from utmanager.telegram_utils import reply_silent, send_silent_message
from utmanager.topics import sync_topics_from_fs

log = logging.getLogger(__name__)

VIDEO_EXT = {".mp4", ".mov", ".gif"}

_album_anchor: Dict[tuple[int, str], int] = {}


# ---- helpers ------------------------------------------------------------------

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




def _pending_media_path(bucket: str, origin_message_id: int) -> Path:
    root = bucket_root(bucket)
    return root / "__PENDING__" / f"{origin_message_id}.pending"


def _extract_media_meta(msg: Message) -> Optional[Tuple[str, str, str, Optional[str], Optional[int]]]:
    if msg.document:
        document: Document = cast(Document, msg.document)
        ext = Path(document.file_name or "").suffix.lower()
        kind = "Video" if ext in VIDEO_EXT else "Documents"
        return kind, document.file_id, document.file_unique_id or "", document.file_name, document.file_size
    if msg.animation:
        animation: Animation = cast(Animation, msg.animation)
        return "Video", animation.file_id, animation.file_unique_id or "", animation.file_name, animation.file_size
    if msg.video:
        video: Video = cast(Video, msg.video)
        return "Video", video.file_id, video.file_unique_id or "", video.file_name, video.file_size
    if msg.photo:
        photo: PhotoSize = cast(PhotoSize, (msg.photo or [])[-1])
        return "Images", photo.file_id, photo.file_unique_id or "", None, photo.file_size
    return None


def _extract_hashtag_author(msg: Message) -> Optional[str]:
    try:
        if msg.caption:
            entities = msg.parse_caption_entities(types=[MessageEntityType.HASHTAG])
            if entities:
                first = min(entities.keys(), key=lambda e: e.offset)
                value = (entities.get(first) or "").lstrip("#").strip()
                return value or None
        if msg.text:
            entities = msg.parse_entities(types=[MessageEntityType.HASHTAG])
            if entities:
                first = min(entities.keys(), key=lambda e: e.offset)
                value = (entities.get(first) or "").lstrip("#").strip()
                return value or None
    except Exception:
        return None
    return None


def _default_suffix_for_kind(kind: str) -> str:
    if kind == "Images":
        return ".jpg"
    if kind == "Video":
        return ".mp4"
    return ".bin"


def _prepare_download_path(
    root: Path,
    topic_name: Optional[str],
    original_name: Optional[str],
    fallback_base: str,
    default_suffix: str,
    *,
    expected_size: Optional[int] = None,
) -> Path:
    dest_dir = root / topic_name if topic_name else root
    dest_dir.mkdir(parents=True, exist_ok=True)

    if original_name:
        original_path = Path(original_name)
        suffix = original_path.suffix or default_suffix
        base = safe(original_path.stem) or fallback_base
    else:
        suffix = default_suffix
        base = fallback_base

    if not suffix.startswith("."):
        suffix = f".{suffix}"

    filename = f"{base}{suffix}"
    candidate = dest_dir / filename

    if expected_size is not None and candidate.exists():
        try:
            if candidate.stat().st_size == expected_size:
                return candidate
        except Exception:
            pass

    return _ensure_unique(candidate)

def _prepare_unsorted_path(
    root: Path,
    category: str,
    original_name: Optional[str],
    fallback_base: str,
    default_suffix: str,
    *,
    expected_size: Optional[int] = None,
) -> Path:
    dest_dir = root / "UNSORTED" / category
    dest_dir.mkdir(parents=True, exist_ok=True)

    if original_name:
        original_path = Path(original_name)
        suffix = original_path.suffix or default_suffix
        base = safe(original_path.stem) or fallback_base
    else:
        suffix = default_suffix
        base = fallback_base

    if not suffix.startswith("."):
        suffix = f".{suffix}"

    filename = f"{base}{suffix}"
    candidate = dest_dir / filename

    # If file already exists with same size, reuse instead of creating duplicates.
    if expected_size is not None and candidate.exists():
        try:
            if candidate.stat().st_size == expected_size:
                return candidate
        except Exception:
            pass

    return _ensure_unique(candidate)


def _move_to_topic(abs_path: Path, bucket: str, topic_name: str, category: str) -> Path:
    target_dir = bucket_root(bucket) / topic_name / category
    target_dir.mkdir(parents=True, exist_ok=True)
    candidate = _ensure_unique(target_dir / abs_path.name)
    if candidate == abs_path:
        return abs_path
    try:
        abs_path.replace(candidate)
        return candidate
    except Exception:
        log.exception("Failed to move %s -> %s", abs_path, candidate)
        return abs_path


def _find_seen_file_path(
    chat_id: int,
    file_unique_id: str,
    *,
    expected_size: Optional[int] = None,
) -> Optional[Path]:
    saved_path = seen_file_get(chat_id, file_unique_id)
    if not saved_path:
        return None
    candidate = Path(saved_path)
    if not candidate.exists():
        return None
    if expected_size is not None:
        try:
            if candidate.stat().st_size != expected_size:
                return None
        except Exception:
            return None
    return candidate


def _materialize_seen_file(existing_path: Path, dest: Path) -> Path:
    try:
        if existing_path.resolve() == dest.resolve():
            return existing_path
    except Exception:
        pass

    if dest.exists():
        try:
            if dest.stat().st_size == existing_path.stat().st_size:
                return dest
        except Exception:
            pass

    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(existing_path, dest)
    return dest


def _topic_name_by_id(topic_id: int) -> Optional[str]:
    row = db("SELECT name FROM topics WHERE id=?", topic_id).fetchone()
    return row[0] if row else None


def _build_item_link(message_id: int) -> Optional[str]:
    if not TGGROUP_LINK:
        return None
    return f"{TGGROUP_LINK.rstrip('/')}/{message_id}"


def _schedule_followup_jobs(ctx: ContextTypes.DEFAULT_TYPE, chat_id: int, pmsg_id: int, bucket: str) -> None:
    job_queue = ctx.job_queue
    if not job_queue:
        return

    close_name = f"close-{chat_id}-{pmsg_id}"
    finalize_name = f"finalize-{chat_id}-{pmsg_id}"

    for job in job_queue.get_jobs_by_name(close_name):
        job.schedule_removal()
    for job in job_queue.get_jobs_by_name(finalize_name):
        job.schedule_removal()

    try:
        job_queue.run_once(
            close_selector_job,  # type: ignore[arg-type]
            when=30,
            data={"chat_id": chat_id, "pmsg": pmsg_id, "bucket": bucket},
            name=close_name,
        )
    except Exception:
        pass

    try:
        job_queue.run_once(
            finalize_post_job,  # type: ignore[arg-type]
            when=120,
            data={"chat_id": chat_id, "pmsg": pmsg_id, "bucket": bucket},
            name=finalize_name,
        )
    except Exception:
        pass


async def _download_to_dest(
    ctx: ContextTypes.DEFAULT_TYPE,
    msg: Message,
    header: str,
    progress_msg_id: int,
    bucket: str,
    tg_file,
    dest: Path,
) -> None:
    async def on_progress(received: int, total: int) -> None:
        percent = int(received * 100 / total) if total else 100
        await edit_progress(ctx, msg.chat_id, progress_msg_id, header, percent, bucket)

    await stream_download(ctx.bot, local_abs_path_for(tg_file.file_path or ""), dest, on_progress, tg_file)

async def _download_to_dest_simple(
    ctx: ContextTypes.DEFAULT_TYPE,
    chat_id: int,
    progress_msg_id: int,
    folder_label: str,
    tg_file,
    dest: Path,
    *,
    index: int = 1,
    total: int = 1,
) -> None:
    async def on_progress(received: int, total_bytes: int) -> None:
        percent = int(received * 100 / total_bytes) if total_bytes else 100
        await edit_download_progress(
            ctx,
            chat_id,
            progress_msg_id,
            folder_label,
            percent,
            index=index,
            total=total,
        )

    await stream_download(ctx.bot, local_abs_path_for(tg_file.file_path or ""), dest, on_progress, tg_file)


async def _save_photo(
    msg: Message,
    root: Path,
    ctx: ContextTypes.DEFAULT_TYPE,
    header: str,
    pid: int,
    bucket: str,
) -> Tuple[Path, str, str]:
    photo: PhotoSize = cast(PhotoSize, (msg.photo or [])[-1])
    if photo is None:
        raise RuntimeError("photo is empty")
    if photo.file_size and photo.file_size > MAX_SIZE:
        raise ValueError("Photo is larger than 2GB")

    tg_file = await get_file_with_retry(photo)
    fallback_base = safe(f"{ts_name(msg.date)}__{photo.file_unique_id or 'photo'}")
    dest = _prepare_unsorted_path(
        root,
        "Images",
        None,
        fallback_base,
        ".jpg",
        expected_size=photo.file_size,
    )
    existing_seen = _find_seen_file_path(msg.chat_id, photo.file_unique_id or "", expected_size=photo.file_size)
    if existing_seen is not None:
        dest = _materialize_seen_file(existing_seen, dest)
        log.debug("Reuse existing photo %s from %s", photo.file_unique_id, existing_seen)
    elif photo.file_size and dest.exists() and dest.stat().st_size == photo.file_size:
        log.debug("Skip download photo %s: already exists at %s", photo.file_unique_id, dest)
    else:
        await _download_to_dest(ctx, msg, header, pid, bucket, tg_file, dest)
    return dest, "Images", photo.file_unique_id or ""


async def _save_video(
    msg: Message,
    root: Path,
    ctx: ContextTypes.DEFAULT_TYPE,
    header: str,
    pid: int,
    bucket: str,
) -> Tuple[Path, str, str]:
    video: Video = cast(Video, msg.video)
    if video.file_size and video.file_size > MAX_SIZE:
        raise ValueError("Video is larger than 2GB")

    tg_file = await get_file_with_retry(video)
    fallback_base = safe(f"{ts_name(msg.date)}__{video.file_unique_id or 'video'}")
    dest = _prepare_unsorted_path(
        root,
        "Video",
        video.file_name,
        fallback_base,
        ".mp4",
        expected_size=video.file_size,
    )
    existing_seen = _find_seen_file_path(msg.chat_id, video.file_unique_id or "", expected_size=video.file_size)
    if existing_seen is not None:
        dest = _materialize_seen_file(existing_seen, dest)
        log.debug("Reuse existing video %s from %s", video.file_unique_id, existing_seen)
    elif video.file_size and dest.exists() and dest.stat().st_size == video.file_size:
        log.debug("Skip download video %s: already exists at %s", video.file_unique_id, dest)
    else:
        await _download_to_dest(ctx, msg, header, pid, bucket, tg_file, dest)
    return dest, "Video", video.file_unique_id or ""


async def _save_animation(
    msg: Message,
    root: Path,
    ctx: ContextTypes.DEFAULT_TYPE,
    header: str,
    pid: int,
    bucket: str,
) -> Tuple[Path, str, str]:
    animation: Animation = cast(Animation, msg.animation)
    if animation.file_size and animation.file_size > MAX_SIZE:
        raise ValueError("Animation is larger than 2GB")

    tg_file = await get_file_with_retry(animation)
    fallback_base = safe(f"{ts_name(msg.date)}__{animation.file_unique_id or 'gif'}")
    dest = _prepare_unsorted_path(
        root,
        "Video",
        animation.file_name,
        fallback_base,
        ".mp4",
        expected_size=animation.file_size,
    )
    existing_seen = _find_seen_file_path(msg.chat_id, animation.file_unique_id or "", expected_size=animation.file_size)
    if existing_seen is not None:
        dest = _materialize_seen_file(existing_seen, dest)
        log.debug("Reuse existing animation %s from %s", animation.file_unique_id, existing_seen)
    elif animation.file_size and dest.exists() and dest.stat().st_size == animation.file_size:
        log.debug("Skip download animation %s: already exists at %s", animation.file_unique_id, dest)
    else:
        await _download_to_dest(ctx, msg, header, pid, bucket, tg_file, dest)
    return dest, "Video", animation.file_unique_id or ""


async def _save_document(
    msg: Message,
    root: Path,
    ctx: ContextTypes.DEFAULT_TYPE,
    header: str,
    pid: int,
    bucket: str,
) -> Tuple[Path, str, str]:
    document: Document = cast(Document, msg.document)
    if document.file_size and document.file_size > MAX_SIZE:
        raise ValueError("Document is larger than 2GB")

    tg_file = await get_file_with_retry(document)
    ext = Path(document.file_name or "").suffix.lower()
    category = "Video" if ext in VIDEO_EXT else "Documents"
    fallback_base = safe(f"{ts_name(msg.date)}__{document.file_unique_id or 'doc'}")
    dest = _prepare_unsorted_path(
        root,
        category,
        document.file_name,
        fallback_base,
        ext or ".bin",
        expected_size=document.file_size,
    )
    existing_seen = _find_seen_file_path(msg.chat_id, document.file_unique_id or "", expected_size=document.file_size)
    if existing_seen is not None:
        dest = _materialize_seen_file(existing_seen, dest)
        log.debug("Reuse existing document %s from %s", document.file_unique_id, existing_seen)
    elif document.file_size and dest.exists() and dest.stat().st_size == document.file_size:
        log.debug("Skip download document %s: already exists at %s", document.file_unique_id, dest)
    else:
        await _download_to_dest(ctx, msg, header, pid, bucket, tg_file, dest)
    return dest, category, document.file_unique_id or ""


async def _save_media_content(
    msg: Message,
    root_base: Path,
    ctx: ContextTypes.DEFAULT_TYPE,
    header: str,
    progress_msg_id: int,
    bucket: str,
) -> Optional[Tuple[Path, str, str]]:
    if msg.document:
        return await _save_document(msg, root_base, ctx, header, progress_msg_id, bucket)
    if msg.animation:
        return await _save_animation(msg, root_base, ctx, header, progress_msg_id, bucket)
    if msg.video:
        return await _save_video(msg, root_base, ctx, header, progress_msg_id, bucket)
    if msg.photo:
        return await _save_photo(msg, root_base, ctx, header, progress_msg_id, bucket)
    return None


async def _finalize_saved_content(
    msg: Message,
    dest: Path,
    category: str,
    *,
    unique_id: Optional[str],
    ctx: ContextTypes.DEFAULT_TYPE,
    chat_id: int,
    header: str,
    bucket: str,
    progress_msg_id: int,
) -> None:
    filemap_set(
        chat_id,
        progress_msg_id,
        str(dest),
        bucket,
        category,
        inc=True,
        origin_message_id=msg.message_id,
    )
    await edit_progress(ctx, chat_id, progress_msg_id, header, 100, bucket, throttle=False)

    selected_topic = selection_get(chat_id, progress_msg_id)
    if selected_topic:
        topic_name = _topic_name_by_id(selected_topic)
        if topic_name:
            dest = _move_to_topic(dest, bucket, topic_name, category)
            filemap_set(
                chat_id,
                progress_msg_id,
                str(dest),
                bucket,
                category,
                origin_message_id=msg.message_id,
            )
        await _persist_item(msg, chat_id, selected_topic, category, bucket)
        item_apply_topic_tags(chat_id, msg.message_id, selected_topic)
        try:
            await add_reaction_done(ctx, chat_id, msg.message_id)
        except Exception:
            pass
        await render_item_summary(
            ctx,
            chat_id=chat_id,
            progress_msg_id=progress_msg_id,
            topic_id=selected_topic,
            bucket=bucket,
            origin_message_id=msg.message_id,
        )
    else:
        await _persist_item(msg, chat_id, 0, category, bucket)
        _schedule_followup_jobs(ctx, chat_id, progress_msg_id, bucket)

    if unique_id:
        seen_file_upsert(chat_id, unique_id, str(dest))


async def _persist_item(
    msg: Message,
    chat_id: int,
    topic_id: int,
    category: str,
    bucket: str,
) -> None:
    source_dt = getattr(msg, "forward_date", None)
    if source_dt is None:
        origin = getattr(msg, "forward_origin", None)
        origin_date = getattr(origin, "date", None) if origin else None
        if origin_date:
            source_dt = origin_date
    if source_dt is None:
        source_dt = msg.date

    if source_dt.tzinfo is None:
        source_dt = source_dt.replace(tzinfo=timezone.utc)
    created_at = source_dt.astimezone(timezone.utc).isoformat(timespec="seconds")

    meta = _extract_media_meta(msg)
    file_id = file_unique_id = file_name = None
    if meta:
        _, file_id, file_unique_id, file_name, _ = meta

    raw_title = ""
    if getattr(msg, "caption", None) or getattr(msg, "text", None):
        raw_title = (msg.caption or msg.text or "")
    if not raw_title and file_name:
        raw_title = file_name

    title_clean = raw_title.strip()
    if title_clean:
        title = title_clean[:TITLE_MAX_LEN]
    else:
        title = None
    link = _build_item_link(msg.message_id)

    author = "Noname"
    origin = getattr(msg, "forward_origin", None)
    if origin:
        origin_chat = getattr(origin, "chat", None)
        if origin_chat and getattr(origin_chat, "title", None):
            author = origin_chat.title
        else:
            sender_name = getattr(origin, "sender_user", None)
            if sender_name:
                author = sender_name.full_name or sender_name.username or author
            else:
                custom_name = getattr(origin, "sender_name", None)
                if custom_name:
                    author = custom_name
    else:
        forward_from_chat = getattr(msg, "forward_from_chat", None)
        if forward_from_chat and getattr(forward_from_chat, "title", None):
            author = forward_from_chat.title
        else:
            forward_sender_name = getattr(msg, "forward_sender_name", None)
            if forward_sender_name:
                author = forward_sender_name
            else:
                forward_from = getattr(msg, "forward_from", None)
                if forward_from:
                    author = forward_from.full_name or forward_from.username or author
                else:
                    from_user = getattr(msg, "from_user", None)
                    if from_user:
                        author = from_user.full_name or from_user.username or author

    hashtag_author = _extract_hashtag_author(msg)
    if hashtag_author:
        author = hashtag_author

    item_upsert(
        chat_id,
        msg.message_id,
        topic_id,
        category,
        title,
        link,
        created_at,
        file_id=file_id,
        file_unique_id=file_unique_id,
        file_name=file_name,
    )
    item_update_author(chat_id, msg.message_id, author)
    item_update_bucket(chat_id, msg.message_id, bucket)
    # add forum thread name as initial tag, if available
    thread_id = getattr(msg, "message_thread_id", None)
    if thread_id is not None:
        thread_tag = thread_topic_get(chat_id, thread_id)
        if thread_tag:
            item_set_tags(chat_id, msg.message_id, [thread_tag])




# ---- link handling ------------------------------------------------------------

_LINK_CATEGORY = "Links"
_PENDING_LINKS_KEY = "pending_links"
_PENDING_LINKS_GROUPS_KEY = "pending_link_groups"


def _content_hint(msg: Message) -> Optional[str]:
    if msg.caption:
        return msg.caption.strip()[:100]
    if msg.text:
        return msg.text.strip()[:100]
    if msg.document and msg.document.file_name:
        return msg.document.file_name
    if msg.photo:
        return "\u0424\u043e\u0442\u043e\u0433\u0440\u0430\u0444\u0438\u0438"
    if msg.video:
        return msg.video.file_name or "\u0412\u0438\u0434\u0435\u043e"
    if msg.animation:
        return "\u0410\u043d\u0438\u043c\u0430\u0446\u0438\u044f"
    return None


def _build_progress_header(chat: Chat, hint: Optional[str]) -> str:
    base = f"📂 {chat.title or chat.username or chat.id}"
    if hint:
        return f"{base}\n📝 {hint}"
    return str(base)

def _extract_links(msg: Message) -> List[str]:
    urls: List[str] = []
    seen: set[str] = set()
    entity_types = [MessageEntityType.URL, MessageEntityType.TEXT_LINK]

    try:
        entities = msg.parse_entities(types=entity_types)
    except Exception:
        entities = {}
    for entity, text in entities.items():
        candidate = entity.url if entity.type == MessageEntityType.TEXT_LINK and getattr(entity, "url", None) else text
        url = (candidate or "").strip()
        if url and url not in seen:
            urls.append(url)
            seen.add(url)

    if getattr(msg, "caption_entities", None):
        try:
            caption_entities = msg.parse_caption_entities(types=entity_types)
        except Exception:
            caption_entities = {}
        for entity, text in caption_entities.items():
            candidate = entity.url if entity.type == MessageEntityType.TEXT_LINK and getattr(entity, "url", None) else text
            url = (candidate or "").strip()
            if url and url not in seen:
                urls.append(url)
                seen.add(url)

    return urls


def _link_prompt_keyboard(origin_message_id: int) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        [
            [InlineKeyboardButton("\u0421\u043e\u0445\u0440\u0430\u043d\u0438\u0442\u044c \u043a\u043e\u043d\u0442\u0435\u043d\u0442", callback_data=f"link:save:{origin_message_id}")],
            [InlineKeyboardButton("\u041e\u0442\u043c\u0435\u043d\u0430", callback_data=f"link:cancel:{origin_message_id}")],
        ]
    )

def _compose_link_stub(msg: Message, links: List[str], chat_label: str) -> str:
    lines: List[str] = []
    lines.append(f"Chat: {chat_label}")
    lines.append(f"Chat ID: {msg.chat.id}")
    lines.append(f"Message ID: {msg.message_id}")
    msg_dt = getattr(msg, "date", None)
    if msg_dt is None:
        msg_dt = datetime.now(timezone.utc)
    elif msg_dt.tzinfo is None:
        msg_dt = msg_dt.replace(tzinfo=timezone.utc)
    lines.append(f"Date (UTC): {msg_dt.astimezone(timezone.utc).isoformat(timespec='seconds')}")

    text_content = (msg.text or msg.caption or "").strip()
    if text_content:
        lines.append("")
        lines.append("Message:")
        lines.append(text_content)

    if links:
        lines.append("")
        lines.append("Links:")
        lines.extend(links)

    return "\n".join(lines)


async def _process_link_save(
    msg: Message,
    prompt_message: Message,
    ctx: ContextTypes.DEFAULT_TYPE,
    links: List[str],
) -> None:
    chat: Chat = cast(Chat, prompt_message.chat)
    chat_id = chat.id

    bucket = current_bucket(msg.date)
    root_base = bucket_root(bucket)
    hint = _content_hint(msg)
    chat_human = chat.title or chat.username or str(chat_id)
    header = _build_progress_header(chat, hint)

    progress = await reply_silent(msg, format_progress_text(header, 0))
    progress_msg_id = progress.message_id
    try:
        await ctx.bot.edit_message_reply_markup(
            chat_id=chat_id,
            message_id=progress_msg_id,
            reply_markup=kb_for_progress(chat_id, progress_msg_id, bucket),
        )
    except Exception:
        pass

    media_result = await _save_media_content(msg, root_base, ctx, header, progress_msg_id, bucket)
    if media_result:
        dest, category, unique_id = media_result
    else:
        fallback_base = safe(f"{ts_name(msg.date)}__link-{msg.message_id}")
        dest = _prepare_unsorted_path(root_base, _LINK_CATEGORY, None, fallback_base, ".txt")
        content = _compose_link_stub(msg, links, chat_human)
        dest.write_text(content, encoding="utf-8")
        category = _LINK_CATEGORY
        unique_id = None

    await _finalize_saved_content(
        msg,
        dest,
        category,
        unique_id=unique_id,
        ctx=ctx,
        chat_id=chat_id,
        header=header,
        bucket=bucket,
        progress_msg_id=progress_msg_id,
    )




async def _create_item_card(
    msg: Message,
    ctx: ContextTypes.DEFAULT_TYPE,
    *,
    prompt_message_id: Optional[int] = None,
) -> Optional[int]:
    chat: Optional[Chat] = msg.chat if isinstance(msg.chat, Chat) else None
    if not chat:
        log.debug("create_item_card: message %s has no chat, skipping", msg.message_id)
        return None

    record_thread_topic_from_message(msg)

    meta = _extract_media_meta(msg)
    if not meta:
        return None
    kind, _, _, _, _ = meta

    chat_id = chat.id
    bucket = current_bucket(msg.date)

    await _persist_item(msg, chat_id, 0, kind, bucket)

    progress_msg_id = prompt_message_id
    if progress_msg_id is None:
        progress = await reply_silent(msg, "Создаю карточку...")
        progress_msg_id = progress.message_id

    placeholder_path = _pending_media_path(bucket, msg.message_id)
    filemap_set(
        chat_id,
        progress_msg_id,
        str(placeholder_path),
        bucket,
        kind,
        origin_message_id=msg.message_id,
    )

    await render_item_card(
        ctx,
        chat_id=chat_id,
        progress_msg_id=progress_msg_id,
        topic_id=0,
        bucket=bucket,
        origin_message_id=msg.message_id,
    )
    return progress_msg_id

async def _execute_media_save(
    msg: Message,
    ctx: ContextTypes.DEFAULT_TYPE,
    album_index: Optional[int] = None,
    album_total: Optional[int] = None,
) -> None:
    chat: Optional[Chat] = msg.chat if isinstance(msg.chat, Chat) else None
    if not chat:
        log.debug("execute_media_save: message %s has no chat, skipping", msg.message_id)
        return
    record_thread_topic_from_message(msg)

    chat_id = chat.id
    bucket = current_bucket(msg.date)
    root_base = bucket_root(bucket)

    media_group_id = msg.media_group_id
    progress_msg_id: Optional[int] = None
    if media_group_id:
        progress_msg_id = _album_anchor.get((chat_id, media_group_id))

    hint = _content_hint(msg)
    header = _build_progress_header(chat, hint)
    if album_total and album_index:
        header = f"{header}\n[{album_index}/{album_total}]"

    if progress_msg_id is None:
        progress = await reply_silent(msg, format_progress_text(header, 0))
        progress_msg_id = progress.message_id
        try:
            await ctx.bot.edit_message_reply_markup(
                chat_id=chat_id,
                message_id=progress_msg_id,
                reply_markup=kb_for_progress(chat_id, progress_msg_id, bucket),
            )
        except Exception:
            pass
        if media_group_id:
            _album_anchor[(chat_id, media_group_id)] = progress_msg_id

    try:
        media_result = await _save_media_content(msg, root_base, ctx, header, progress_msg_id, bucket)
        if not media_result:
            return
        dest, category, unique_id = media_result

        await _finalize_saved_content(
            msg,
            dest,
            category,
            unique_id=unique_id,
            ctx=ctx,
            chat_id=chat_id,
            header=header,
            bucket=bucket,
            progress_msg_id=progress_msg_id,
        )

    except Exception as exc:
        log.exception("Download failed: %s", exc)
        await add_reaction_error(ctx, chat_id, msg.message_id)
        try:
            await ctx.bot.edit_message_text(
                chat_id=chat_id,
                message_id=progress_msg_id,
                text=f"{header}\nError: {exc}",
                reply_markup=kb_for_progress(chat_id, progress_msg_id, bucket),
            )
        except Exception:
            pass


async def _start_link_prompt(
    msg: Message,
    ctx: ContextTypes.DEFAULT_TYPE,
    *,
    links: List[str],
    has_media: bool,
) -> None:
    pending: Dict[int, Dict[str, object]] = ctx.chat_data.setdefault(_PENDING_LINKS_KEY, {})

    group_key: Optional[str] = None
    group_map: Optional[Dict[str, Dict[str, int]]] = None
    prompt_id: Optional[int] = None
    if has_media and msg.media_group_id:
        raw_map = ctx.chat_data.setdefault(_PENDING_LINKS_GROUPS_KEY, {})
        if not isinstance(raw_map, dict):
            raw_map = ctx.chat_data[_PENDING_LINKS_GROUPS_KEY] = {}
        group_map = cast(Dict[str, Dict[str, int]], raw_map)
        group_key = str(msg.media_group_id)
        existing = group_map.get(group_key)
        if existing:
            prompt_id = existing.get("prompt_id")

    if msg.message_id in pending:
        if prompt_id and not pending[msg.message_id].get("prompt_id"):
            pending[msg.message_id]["prompt_id"] = prompt_id
        return

    prompt_text = "Получен контент. Сохранить?"

    if prompt_id is None:
        prompt = await reply_silent(
            msg,
            prompt_text,
            reply_markup=_link_prompt_keyboard(msg.message_id),
        )
        prompt_id = prompt.message_id
        if group_key and group_map is not None:
            group_map[group_key] = {"prompt_id": prompt_id}

    pending[msg.message_id] = {
        "message": msg,
        "prompt_id": prompt_id,
        "links": links,
        "media_group_id": msg.media_group_id,
        "has_media": has_media,
    }
    if group_key and group_map is not None and group_key not in group_map:
        group_map[group_key] = {"prompt_id": prompt_id or 0}


async def handle_link_message(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    if update.effective_chat and ALLOWED and update.effective_chat.id not in ALLOWED:
        return

    if not update.effective_message or not update.effective_chat:
        return

    msg: Message = cast(Message, update.effective_message)
    if msg.from_user and msg.from_user.is_bot:
        return
    if msg.effective_attachment:
        return

    # Временно игнорируем сообщения, содержащие только ссылки (без вложений).
    return


async def handle_link_decision(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    if not query or not query.message or not query.data:
        return

    await query.answer()

    try:
        _, action, origin_s = query.data.split(":")
    except ValueError:
        return

    try:
        origin_id = int(origin_s)
    except ValueError:
        log.warning("handle_link_decision: invalid origin %s", origin_s)
        return

    pending: Dict[int, Dict[str, object]] = ctx.chat_data.get(_PENDING_LINKS_KEY, {})
    entry = pending.get(origin_id)
    if not entry:
        await query.answer("\u0421\u043e\u043e\u0431\u0449\u0435\u043d\u0438\u0435 \u043d\u0435 \u043d\u0430\u0439\u0434\u0435\u043d\u043e", show_alert=False)
        return

    chat_id = query.message.chat.id
    media_group_id = entry.get("media_group_id")
    prompt_id = entry.get("prompt_id")

    if action == "cancel":
        if prompt_id:
            try:
                await ctx.bot.delete_message(chat_id=chat_id, message_id=int(prompt_id))
            except Exception:
                pass
        pending.pop(origin_id, None)
        if not pending:
            ctx.chat_data.pop(_PENDING_LINKS_KEY, None)
        if media_group_id:
            group_map = ctx.chat_data.get(_PENDING_LINKS_GROUPS_KEY, {})
            if isinstance(group_map, dict):
                group_map.pop(str(media_group_id), None)
                if not group_map:
                    ctx.chat_data.pop(_PENDING_LINKS_GROUPS_KEY, None)
        return

    if action != "save":
        return

    targets: List[Tuple[int, Dict[str, object]]] = []
    if media_group_id:
        for mid, ent in list(pending.items()):
            if ent.get("media_group_id") == media_group_id:
                targets.append((mid, ent))
    else:
        targets.append((origin_id, entry))

    if not targets:
        targets.append((origin_id, entry))

    for mid, _ in targets:
        pending.pop(mid, None)
    if not pending:
        ctx.chat_data.pop(_PENDING_LINKS_KEY, None)

    if media_group_id:
        group_map = ctx.chat_data.get(_PENDING_LINKS_GROUPS_KEY, {})
        if isinstance(group_map, dict):
            group_map.pop(str(media_group_id), None)
            if not group_map:
                ctx.chat_data.pop(_PENDING_LINKS_GROUPS_KEY, None)

    synced_topics = False
    prompt_used = False
    try:
        if media_group_id and targets:
            sorted_targets = sorted(targets, key=lambda x: x[0])
            primary_index = 0
            for idx, (_, ent) in enumerate(sorted_targets):
                msg_obj = ent.get("message")
                if isinstance(msg_obj, Message) and ((msg_obj.caption or msg_obj.text or "").strip()):
                    primary_index = idx
                    break
            primary_mid, primary_ent = sorted_targets[primary_index]
            primary_msg = primary_ent.get("message")
            if not isinstance(primary_msg, Message):
                log.warning("handle_link_decision: stored message missing for %s", primary_mid)
                return

            if isinstance(primary_msg.chat, Chat) and not synced_topics:
                try:
                    sync_topics_from_fs(primary_msg.chat.id, current_bucket(primary_msg.date))
                except Exception:
                    log.exception(
                        "handle_link_decision: failed to sync topics chat=%s", primary_msg.chat.id
                    )
                synced_topics = True

            reuse_prompt_id = None
            for _, ent in sorted_targets:
                prompt_candidate = ent.get("prompt_id")
                if prompt_candidate:
                    reuse_prompt_id = int(prompt_candidate)
                    prompt_used = True
                    break

            progress_msg_id = await _create_item_card(primary_msg, ctx, prompt_message_id=reuse_prompt_id)
            if progress_msg_id is None:
                return

            primary_meta = _extract_media_meta(primary_msg)
            primary_kind = primary_meta[0] if primary_meta else ""
            bucket = current_bucket(primary_msg.date)
            chat_id = primary_msg.chat.id

            for mid, ent in sorted_targets:
                if mid == primary_mid:
                    continue
                original_msg = ent.get("message")
                if not isinstance(original_msg, Message):
                    log.warning("handle_link_decision: stored message missing for %s", mid)
                    continue
                meta = _extract_media_meta(original_msg)
                if not meta:
                    continue
                kind = meta[0]
                await _persist_item(original_msg, chat_id, 0, kind, bucket)
                placeholder_path = _pending_media_path(bucket, original_msg.message_id)
                filemap_set(
                    chat_id,
                    progress_msg_id,
                    str(placeholder_path),
                    bucket,
                    kind,
                    origin_message_id=original_msg.message_id,
                )

            if primary_kind:
                placeholder_path = _pending_media_path(bucket, primary_msg.message_id)
                filemap_set(
                    chat_id,
                    progress_msg_id,
                    str(placeholder_path),
                    bucket,
                    primary_kind,
                    origin_message_id=primary_msg.message_id,
                )
        else:
            for mid, ent in sorted(targets, key=lambda x: x[0]):
                original_msg = ent.get("message")
                links_obj = ent.get("links", [])
                links_list = cast(List[str], links_obj if isinstance(links_obj, list) else [])
                has_media_item = bool(ent.get("has_media"))

                if not isinstance(original_msg, Message):
                    log.warning("handle_link_decision: stored message missing for %s", mid)
                    continue

                if isinstance(original_msg.chat, Chat) and not synced_topics:
                    try:
                        sync_topics_from_fs(original_msg.chat.id, current_bucket(original_msg.date))
                    except Exception:
                        log.exception(
                            "handle_link_decision: failed to sync topics chat=%s", original_msg.chat.id
                        )
                    synced_topics = True

                if has_media_item:
                    reuse_prompt_id = None
                    if not prompt_used:
                        prompt_candidate = ent.get("prompt_id")
                        if prompt_candidate:
                            reuse_prompt_id = int(prompt_candidate)
                            prompt_used = True
                    await _create_item_card(original_msg, ctx, prompt_message_id=reuse_prompt_id)
                else:
                    await _process_link_save(original_msg, query.message, ctx, links_list)

        if prompt_id and not prompt_used:
            try:
                await ctx.bot.delete_message(chat_id=chat_id, message_id=int(prompt_id))
            except Exception:
                pass
    except Exception as exc:
        log.exception("Failed to save link message %s: %s", origin_id, exc)
        try:
            await send_silent_message(
                ctx,
                chat_id,
                f"\u041d\u0435 \u0443\u0434\u0430\u043b\u043e\u0441\u044c \u0441\u043e\u0445\u0440\u0430\u043d\u0438\u0442\u044c \u0441\u043e\u043e\u0431\u0449\u0435\u043d\u0438\u0435: {exc}",
            )
        except Exception:
            pass


async def handle_single(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    if update.effective_chat and ALLOWED and update.effective_chat.id not in ALLOWED:
        return

    if not update.effective_message or not update.effective_chat:
        return

    msg: Message = cast(Message, update.effective_message)
    links_in_message = _extract_links(msg)
    await _start_link_prompt(msg, ctx, links=links_in_message, has_media=True)


async def download_item_content(
    ctx: ContextTypes.DEFAULT_TYPE,
    *,
    item_chat_id: int,
    item_message_id: int,
    card_message_id: int,
    reply_to_message_id: Optional[int] = None,
) -> None:
    item = item_get(item_chat_id, item_message_id)
    if not item:
        await send_silent_message(
            ctx,
            item_chat_id,
            "\u041d\u0435 \u0443\u0434\u0430\u043b\u043e\u0441\u044c \u043d\u0430\u0439\u0442\u0438 \u043a\u0430\u0440\u0442\u043e\u0447\u043a\u0443 \u0434\u043b\u044f \u0441\u043a\u0430\u0447\u0438\u0432\u0430\u043d\u0438\u044f.",
        )
        return

    entries = filemap_entries(item_chat_id, card_message_id)
    origin_ids = [origin_id for origin_id, _, _, _ in entries]
    if item_message_id not in origin_ids:
        origin_ids = [item_message_id] + origin_ids

    items: List[dict] = []
    for origin_id in origin_ids:
        entry = item_get(item_chat_id, int(origin_id))
        if entry:
            items.append(entry)
    if not items:
        items = [item]

    primary_item = next(
        (entry for entry in items if entry.get("message_id") == item_message_id),
        items[0],
    )
    items_with_files = [entry for entry in items if entry.get("file_id")]
    if not items_with_files:
        await send_silent_message(
            ctx,
            item_chat_id,
            "\u041d\u0435 \u0443\u0434\u0430\u043b\u043e\u0441\u044c \u0441\u043a\u0430\u0447\u0430\u0442\u044c \u0444\u0430\u0439\u043b: \u043d\u0435\u0442 file_id.",
        )
        return

    bucket = primary_item.get("bucket") or ""
    topic_id = int(primary_item.get("topic_id") or 0)
    topic_name = None
    if topic_id:
        info = topic_get(topic_id)
        topic_name = info[2] if info else None

    root = bucket_root(bucket)
    folder_label = topic_name or (bucket or root.name)
    total = len(items_with_files)

    progress = await send_silent_message(
        ctx,
        item_chat_id,
        format_download_progress_text(folder_label, 0, index=1, total=total),
        reply_to_message_id=reply_to_message_id,
    )
    progress_msg_id = progress.message_id

    primary_message_id = int(primary_item.get("message_id") or item_message_id)
    primary_kind = primary_item.get("kind") or ""
    primary_dest: Optional[Path] = None

    try:
        for idx, entry in enumerate(items_with_files, start=1):
            file_id = entry.get("file_id")
            if not file_id:
                continue
            created_at = entry.get("created_at") or ""
            fallback_dt = None
            try:
                if created_at:
                    fallback_dt = datetime.fromisoformat(created_at)
            except Exception:
                fallback_dt = None
            entry_message_id = int(entry.get("message_id") or 0)
            fallback_base = safe(
                f"{ts_name(fallback_dt) if fallback_dt else entry_message_id}__{entry.get('file_unique_id') or 'file'}"
            )
            default_suffix = _default_suffix_for_kind(entry.get("kind") or "")
            dest = _prepare_download_path(
                root,
                topic_name,
                entry.get("file_name"),
                fallback_base,
                default_suffix,
            )
            unique_id = entry.get("file_unique_id")
            existing_seen = _find_seen_file_path(
                item_chat_id,
                unique_id or "",
            )
            if existing_seen is not None:
                dest = _materialize_seen_file(existing_seen, dest)
            elif dest.exists():
                log.debug("Skip download existing file for item %s: %s", entry_message_id, dest)
            else:
                tg_file = await get_file_by_id_with_retry(ctx.bot, file_id)
                await _download_to_dest_simple(
                    ctx,
                    item_chat_id,
                    progress_msg_id,
                    folder_label,
                    tg_file,
                    dest,
                    index=idx,
                    total=total,
                )

            if unique_id:
                seen_file_upsert(item_chat_id, unique_id, str(dest))

            filemap_set(
                item_chat_id,
                card_message_id,
                str(dest),
                bucket,
                entry.get("kind") or "",
                inc=True,
                origin_message_id=entry_message_id,
            )
            if entry_message_id == primary_message_id:
                primary_dest = dest
                primary_kind = entry.get("kind") or primary_kind

        if primary_dest is not None:
            filemap_set(
                item_chat_id,
                card_message_id,
                str(primary_dest),
                bucket,
                primary_kind,
                origin_message_id=primary_message_id,
            )
        await schedule_autodelete(ctx, item_chat_id, progress_msg_id, delay_s=300)
    except Exception as exc:
        log.exception("Download failed: %s", exc)
        try:
            await ctx.bot.edit_message_text(
                chat_id=item_chat_id,
                message_id=progress_msg_id,
                text=f"{folder_label}\n\u041e\u0448\u0438\u0431\u043a\u0430: {exc}",
            )
        except Exception:
            pass

