"""Application bootstrap for UTManager."""

from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime
from typing import Optional

from telegram import InlineKeyboardButton, InlineKeyboardMarkup, Update
from telegram.constants import MessageEntityType
from telegram.request import HTTPXRequest
from telegram.ext import (
    ApplicationBuilder,
    CallbackQueryHandler,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)

from utmanager.config import (
    ALLOWED,
    BASE_API_URL,
    BASE_ROOT,
    BOT_TOKEN,
    OWNER,
    TZ,
    current_bucket,
)
from utmanager.db import filemap_get
from utmanager.handlers.callbacks import (
    cb_browse_close,
    cb_browse_item,
    cb_browse_open,
    cb_browse_page,
    cb_item_action,
    cb_item_edit,
    cb_item_newtopic,
    cb_item_pick,
    cb_item_refresh,
    cb_item_topics_page,
    cb_new,
    cb_newtopic_action,
    cb_noop,
    cb_pick,
    cb_progress_delete,
    cb_reuse_close,
    cb_reuse_newtopic,
    cb_reuse_pick,
    cb_reuse_topics_page,
    cb_reopen,
    cb_tag_view,
    cb_topic_addtags,
    cb_topic_view,
    cb_topics_page,
    text_catcher,
    editcard_cmd,
)
from utmanager.handlers.media import handle_link_decision, handle_link_message, handle_single
from utmanager.telegram_utils import reply_silent
from utmanager.ui import kb_for_progress


LOGLEVEL = os.environ.get("LOGLEVEL", "DEBUG").upper()
logging.basicConfig(
    level=getattr(logging, LOGLEVEL, logging.INFO),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logging.captureWarnings(True)
log = logging.getLogger(__name__)
log.info("Logging configured at %s level", LOGLEVEL)


# ---- commands -----------------------------------------------------------------


async def ping(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    if update.message:
        await reply_silent(update.message, "pong ok")


async def id_cmd(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    if update.message and update.effective_chat and update.effective_user:
        await reply_silent(
            update.message,
            f"Chat ID: {update.effective_chat.id}\nUser ID: {update.effective_user.id}",
        )


async def where(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    if not update.message:
        return

    from utmanager.config import USE_DATE_BUCKETS, ut_bucket

    now = datetime.now(TZ) if TZ else datetime.now()
    if USE_DATE_BUCKETS:
        bucket_name = ut_bucket(now)
        root_txt = f"{BASE_ROOT} (bucket: {bucket_name})"
        scheme = "BASE_ROOT/<UTDDMMYY>/<Topic>"
    else:
        root_txt = str(BASE_ROOT)
        scheme = "BASE_ROOT/<Topic>"

    await reply_silent(
        update.message,
        "\n".join(
            [
                f"Root: {root_txt}",
                f"Structure: {scheme}",
                "Files are saved to /UNSORTED/<Category> first and moved into the chosen topic afterwards.",
                "Topic folders do not create category subfolders upfront.",
            ]
        ),
    )


async def help_cmd(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    msg = update.message
    if not msg:
        return
    lines = [
        "/editcard <t.me/c/...> — показать карточку по ссылке",
        "/newtopic — управление темами (создать/обновить списки)",
        "/id — показать chat/user id",
        "/where — схема хранения файлов",
        "Кнопки карточки: Topic/Tags/Author/Title/Date/Save/Download — редактирование полей.",
    ]
    await reply_silent(msg, "\n".join(lines))


async def newtopic_cmd(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    message = update.message
    if not message:
        return

    if message.reply_to_message:
        progress_msg = message.reply_to_message
        from_user = progress_msg.from_user
        if from_user and from_user.is_bot and ctx.bot and from_user.id == ctx.bot.id:
            chat_id = progress_msg.chat.id
            progress_msg_id = progress_msg.message_id
            record = filemap_get(chat_id, progress_msg_id)
            if record:
                bucket = record[1] or current_bucket(message.date)
                try:
                    await ctx.bot.edit_message_reply_markup(
                        chat_id=chat_id,
                        message_id=progress_msg_id,
                        reply_markup=kb_for_progress(chat_id, progress_msg_id, bucket),
                    )
                except Exception:
                    pass
                return

    bucket = current_bucket(message.date)
    token = bucket or "-"
    keyboard = InlineKeyboardMarkup(
        [
            [InlineKeyboardButton("Create topic", callback_data=f"newtopic:create:{token}")],
            [InlineKeyboardButton("Refresh folders", callback_data=f"newtopic:resync:{token}")],
        ]
    )
    text = "Topic actions"
    if bucket:
        text += f" for bucket {bucket}"
    await reply_silent(message, text + ".", reply_markup=keyboard)


# ---- lifecycle -----------------------------------------------------------------


async def _on_start(app) -> None:
    try:
        await app.bot.set_my_commands(
            [
                ("ping", "healthcheck"),
                ("id", "show chat & user id"),
                ("where", "show storage layout"),
                ("help", "available commands"),
                ("editcard", "show content card by message link"),
                ("newtopic", "topic tools (create / refresh)"),
            ]
        )
    except Exception:
        pass

    BASE_ROOT.mkdir(parents=True, exist_ok=True)
    log.info("=== utmanager entrypoint ===")
    log.info("Base root: %s", BASE_ROOT.resolve())
    log.info("Allowed chats: %s", ", ".join(map(str, ALLOWED)) if ALLOWED else "ALL")
    if OWNER:
        log.info("Owner user id: %s", OWNER)


def build_app():
    if not BOT_TOKEN:
        raise SystemExit("BOT_TOKEN is not set")

    request = HTTPXRequest(
        connect_timeout=30.0,
        read_timeout=180.0,
        write_timeout=180.0,
        pool_timeout=60.0,
    )

    application = (
        ApplicationBuilder()
        .token(BOT_TOKEN)
        .base_url(BASE_API_URL)
        .request(request)
        .post_init(_on_start)
        .build()
    )

    link_filter = (
        filters.TEXT
        & ~filters.COMMAND
        & (filters.Entity(MessageEntityType.URL) | filters.Entity(MessageEntityType.TEXT_LINK))
    )
    application.add_handler(MessageHandler(link_filter, handle_link_message, block=True))

    media_filter = (
        filters.Document.ALL
        | filters.PHOTO
        | filters.VIDEO
        | filters.ANIMATION
        | filters.AUDIO
        | filters.VOICE
        | filters.VIDEO_NOTE
    )
    application.add_handler(MessageHandler(media_filter, handle_single))

    application.add_handler(CallbackQueryHandler(handle_link_decision, pattern=r"^link:(save|cancel):\d+$"))
    application.add_handler(CallbackQueryHandler(cb_pick, pattern=r"^pick:\d+:\d+$"))
    application.add_handler(CallbackQueryHandler(cb_item_pick, pattern=r"^itempick:\d+:-?\d+:\d+:\d+$"))
    application.add_handler(CallbackQueryHandler(cb_item_topics_page, pattern=r"^itemtopics:\d+:-?\d+:\d+:\d+$"))
    application.add_handler(CallbackQueryHandler(cb_item_newtopic, pattern=r"^itemnew:\d+:-?\d+:\d+$"))
    application.add_handler(CallbackQueryHandler(cb_new, pattern=r"^new:\d+$"))
    application.add_handler(CallbackQueryHandler(cb_newtopic_action, pattern=r"^newtopic:(create|resync):.+$"))
    application.add_handler(CallbackQueryHandler(cb_topic_addtags, pattern=r"^topic:addtags:\d+:.+$"))
    application.add_handler(CallbackQueryHandler(cb_topic_view, pattern=r"^topic:view:\d+:.+$"))
    application.add_handler(CallbackQueryHandler(cb_tag_view, pattern=r"^tag:view:\d+:\d+:\d+$"))
    application.add_handler(
        CallbackQueryHandler(
            cb_item_action,
            pattern=r"^item:(topic|tags|tagsadd|tagsrewrite|author|title|date|delete|save|download):-?\d+:\d+$",
        )
    )
    application.add_handler(CallbackQueryHandler(cb_item_edit, pattern=r"^item:edit:-?\d+:\d+$"))
    application.add_handler(CallbackQueryHandler(cb_item_refresh, pattern=r"^item:refresh:-?\d+:\d+$"))
    application.add_handler(CallbackQueryHandler(cb_reopen, pattern=r"^reopen:\d+$"))
    application.add_handler(CallbackQueryHandler(cb_topics_page, pattern=r"^topics:\d+:\d+$"))
    application.add_handler(CallbackQueryHandler(cb_progress_delete, pattern=r"^progress:delete$"))
    application.add_handler(CallbackQueryHandler(cb_browse_open, pattern=r"^browse:(topic|date|author|tag):-?\d+:-?\d+(?::\d+)?$"))
    application.add_handler(CallbackQueryHandler(cb_browse_page, pattern=r"^browsepage:-?\d+$"))
    application.add_handler(CallbackQueryHandler(cb_browse_item, pattern=r"^browseitem:-?\d+:-?\d+$"))
    application.add_handler(CallbackQueryHandler(cb_reuse_topics_page, pattern=r"^reusetopics:\d+:\d+$"))
    application.add_handler(CallbackQueryHandler(cb_reuse_pick, pattern=r"^reusepick:\d+:\d+$"))
    application.add_handler(CallbackQueryHandler(cb_reuse_newtopic, pattern=r"^reusenew:\d+$"))
    application.add_handler(CallbackQueryHandler(cb_reuse_close, pattern=r"^reuseclose:\d+$"))
    application.add_handler(CallbackQueryHandler(cb_browse_close, pattern=r"^browseclose$"))
    application.add_handler(CallbackQueryHandler(cb_noop, pattern=r"^noop$"))

    application.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, text_catcher))

    application.add_handler(CommandHandler("ping", ping))
    application.add_handler(CommandHandler("id", id_cmd))
    application.add_handler(CommandHandler("where", where))
    application.add_handler(CommandHandler("help", help_cmd))
    application.add_handler(CommandHandler("editcard", editcard_cmd))
    application.add_handler(CommandHandler("newtopic", newtopic_cmd))

    return application


async def preflight_check() -> None:
    import aiohttp
    from aiohttp import ClientTimeout

    if not BOT_TOKEN:
        raise SystemExit("BOT_TOKEN is not set in .env")

    test_url = f"{BASE_API_URL}{BOT_TOKEN}/getMe"
    try:
        timeout = ClientTimeout(total=10)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(test_url) as response:
                text = await response.text()
                if response.status == 401 and "invalid api-id/api-hash" in text:
                    raise SystemExit("Bot API reported invalid api-id/api-hash (401).")
                if response.status != 200:
                    log.warning("Preflight getMe returned %s: %s", response.status, text[:200])
    except SystemExit:
        raise
    except Exception as exc:
        log.warning("Preflight check failed: %s", exc)


def _ensure_loop_if_needed() -> Optional[asyncio.AbstractEventLoop]:
    try:
        return asyncio.get_running_loop()
    except RuntimeError:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        return loop


def run() -> None:
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    try:
        loop.run_until_complete(preflight_check())
        app = build_app()
        app.run_polling(allowed_updates=Update.ALL_TYPES, drop_pending_updates=True)
    finally:
        try:
            loop.stop()
        except Exception:
            pass
        loop.close()


