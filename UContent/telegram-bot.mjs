import { promises as fs } from "node:fs";
import * as path from "node:path";

// Default Token for @utcontentbot if not specified in env
const DEFAULT_TOKEN = "8668449496:AAGiTFs0j2tR4apeHDk-g0AMek8Ud4ZNjGw";

let botRunning = false;
let botContext = null;
let currentSession = null;
let offset = 0;

/**
 * Loads the active telegram session from tg-session.json
 */
async function loadSession(dataDir) {
  const target = path.join(dataDir, "tg-session.json");
  try {
    const raw = await fs.readFile(target, "utf8");
    currentSession = JSON.parse(raw);
  } catch {
    currentSession = {
      chatId: null,
      scrapeId: null,
      activeSegmentId: null,
      messageId: null,
      randomMode: false
    };
  }
  return currentSession;
}

/**
 * Saves the active telegram session to tg-session.json
 */
async function saveSession(dataDir, session) {
  const target = path.join(dataDir, "tg-session.json");
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(target, JSON.stringify(session, null, 2), "utf8");
}

/**
 * Helper to call Telegram Bot API methods
 */
async function callApi(token, method, body = {}) {
  const url = `https://api.telegram.org/bot${token}/${method}`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
    const resData = await response.json();
    if (!resData.ok) {
      throw new Error(resData.description || `Telegram API error: ${method}`);
    }
    return resData.result;
  } catch (error) {
    console.error(`[bot-api-error] Method: ${method}, Error:`, error.message);
    throw error;
  }
}

/**
 * Extracts the first URL from a given string
 */
function extractFirstUrl(text) {
  const match = String(text ?? "").match(/https?:\/\/[^\s]+/i);
  return match ? match[0] : null;
}

/**
 * Formats the HTML content for the segment card in Telegram
 */
function formatCardText(scrape, segment) {
  const topic = segment.topic || "Без темы";
  const text = segment.text || "";
  const type = segment.type || "text";
  const status = segment.is_done ? "✅ Готово" : "⏳ В работе";
  
  const escapeHtml = (val) => String(val ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  let msg = `<b>Документ:</b> ${escapeHtml(scrape.title)}\n`;
  msg += `<b>Тема:</b> #_${escapeHtml(topic.replace(/[^a-zA-Zа-яА-Я0-9_]/g, "_"))}\n`;
  msg += `<b>Тип:</b> <code>${escapeHtml(type)}</code>\n\n`;
  msg += `${escapeHtml(text)}\n\n`;
  
  if (segment.media_items && segment.media_items.length > 0) {
    msg += `<b>Привязанные медиа:</b>\n`;
    segment.media_items.forEach((item, index) => {
      msg += `  ${index + 1}. <code>${escapeHtml(item.path || item.url)}</code>\n`;
    });
    msg += `\n`;
  }
  
  msg += `<b>Статус:</b> ${status}`;
  return msg;
}

/**
 * Builds the inline keyboard reply markup for a segment card
 */
function buildCardMarkup(session, segment, hasLink) {
  const keyboard = [];
  
  // Navigation buttons row
  const navRow = [
    { text: session.randomMode ? "🎲 Случайно" : "📚 По порядку", callback_data: "sdvg:toggle_mode" },
    { text: "⏭️ Пропустить", callback_data: "sdvg:next" },
    { text: "✅ Готово", callback_data: "sdvg:done" }
  ];
  keyboard.push(navRow);

  // Link actions row
  if (hasLink) {
    const linkRow = [
      { text: "📥 Скачать линк", callback_data: "sdvg:download" },
      { text: "📸 Скриншот", callback_data: "sdvg:screenshot" }
    ];
    keyboard.push(linkRow);
  }

  return { inline_keyboard: keyboard };
}

/**
 * Finds the next undone segment in the scrape
 */
function findNextSegment(scrape, currentSegmentId, randomMode) {
  const segments = scrape.segments || [];
  if (segments.length === 0) return null;

  const undone = segments.filter((s) => !s.is_done);
  if (undone.length === 0) return null;

  if (randomMode) {
    const candidates = undone.filter((s) => s.id !== currentSegmentId);
    if (candidates.length === 0) return undone[0];
    const idx = Math.floor(Math.random() * candidates.length);
    return candidates[idx];
  } else {
    const currentIdx = segments.findIndex((s) => s.id === currentSegmentId);
    if (currentIdx < 0) return undone[0];

    // Find next in order
    for (let i = currentIdx + 1; i < segments.length; i++) {
      if (!segments[i].is_done) return segments[i];
    }
    // Loop back to start
    for (let i = 0; i < currentIdx; i++) {
      if (!segments[i].is_done) return segments[i];
    }
    // Only current one is undone
    if (!segments[currentIdx].is_done) return segments[currentIdx];
    return null;
  }
}

/**
 * Renders and sends or edits the segment card in Telegram
 */
async function sendOrEditCard(token, session, scrape, segment) {
  if (!session.chatId) return;
  const text = formatCardText(scrape, segment);
  const hasLink = segment.type === "link" || !!extractFirstUrl(segment.text);
  const replyMarkup = buildCardMarkup(session, segment, hasLink);

  if (session.messageId) {
    try {
      await callApi(token, "editMessageText", {
        chat_id: session.chatId,
        message_id: session.messageId,
        text: text,
        parse_mode: "HTML",
        reply_markup: replyMarkup
      });
      return;
    } catch (error) {
      console.warn("[bot-card] Failed to edit card, sending a new one:", error.message);
      // Fallback: clear messageId and let it send a new one below
      session.messageId = null;
    }
  }

  const sent = await callApi(token, "sendMessage", {
    chat_id: session.chatId,
    text: text,
    parse_mode: "HTML",
    reply_markup: replyMarkup
  });
  session.messageId = sent.message_id;
}

/**
 * Main command router for text messages
 */
async function handleTextMessage(token, message) {
  const chatId = message.chat.id;
  const text = String(message.text || "").trim();

  // Initialize or pair session
  if (currentSession.chatId !== chatId) {
    currentSession.chatId = chatId;
    currentSession.messageId = null;
    await saveSession(botContext.DATA_DIR, currentSession);
  }

  if (text.startsWith("/start") || text.startsWith("/help")) {
    await callApi(token, "sendMessage", {
      chat_id: chatId,
      text: [
        "<b>Привет! Я бот UContent.</b> 🤖",
        "",
        "Я готов транслировать сценарии Notion прямо сюда.",
        "<b>Команды:</b>",
        "• /sdvg — открыть текущий сценарий",
        "• /sdvg &lt;scrape_id&gt; — открыть конкретный сценарий",
        "• /status — показать текущее состояние сессии",
        "",
        "Также вы можете нажать кнопку <b>TG</b> в веб-интерфейсе UContent, чтобы отправить нужный сценарий сюда."
      ].join("\n"),
      parse_mode: "HTML"
    });
    return;
  }

  if (text.startsWith("/status")) {
    if (!currentSession.scrapeId) {
      await callApi(token, "sendMessage", {
        chat_id: chatId,
        text: "Нет активной сессии сценария. Начните с команды /sdvg или кнопки TG в веб-интерфейсе."
      });
      return;
    }
    try {
      const scrape = await botContext.readScrape(currentSession.scrapeId);
      const undoneCount = (scrape.segments || []).filter((s) => !s.is_done).length;
      await callApi(token, "sendMessage", {
        chat_id: chatId,
        text: [
          `<b>Активный сценарий:</b> ${scrape.title}`,
          `<b>ID:</b> <code>${scrape.id}</code>`,
          `<b>Осталось сегментов:</b> ${undoneCount} из ${(scrape.segments || []).length}`,
          `<b>Режим:</b> ${currentSession.randomMode ? "🎲 Случайно" : "📚 По порядку"}`
        ].join("\n"),
        parse_mode: "HTML"
      });
    } catch {
      await callApi(token, "sendMessage", {
        chat_id: chatId,
        text: "Ошибка при загрузке данных активного сценария."
      });
    }
    return;
  }

  if (text.startsWith("/sdvg")) {
    const args = text.split(/\s+/).slice(1);
    let scrapeId = args[0] || "";
    try {
      const scrape = await botContext.readScrape(scrapeId);
      currentSession.scrapeId = scrape.id;
      currentSession.messageId = null;
      
      const nextSegment = findNextSegment(scrape, currentSession.activeSegmentId, currentSession.randomMode);
      if (!nextSegment) {
        await callApi(token, "sendMessage", {
          chat_id: chatId,
          text: `🎉 Все сегменты в сценарии <b>${scrape.title}</b> выполнены!`,
          parse_mode: "HTML"
        });
        currentSession.activeSegmentId = null;
        await saveSession(botContext.DATA_DIR, currentSession);
        return;
      }
      
      currentSession.activeSegmentId = nextSegment.id;
      await saveSession(botContext.DATA_DIR, currentSession);
      await sendOrEditCard(token, currentSession, scrape, nextSegment);
    } catch (error) {
      await callApi(token, "sendMessage", {
        chat_id: chatId,
        text: `Не удалось загрузить сценарий: ${error.message}`
      });
    }
    return;
  }
}

/**
 * Handles inline button callbacks
 */
async function handleCallbackQuery(token, callbackQuery) {
  const callbackId = callbackQuery.id;
  const data = callbackQuery.data;
  const chatId = callbackQuery.message.chat.id;

  if (currentSession.chatId !== chatId) {
    currentSession.chatId = chatId;
    await saveSession(botContext.DATA_DIR, currentSession);
  }

  // Acknowledge callback query
  await callApi(token, "answerCallbackQuery", { callback_query_id: callbackId }).catch(() => null);

  if (!currentSession.scrapeId || !currentSession.activeSegmentId) {
    await callApi(token, "sendMessage", {
      chat_id: chatId,
      text: "Нет активного сегмента. Используйте команду /sdvg."
    });
    return;
  }

  let scrape, segmentIndex, segment;
  try {
    scrape = await botContext.readScrape(currentSession.scrapeId);
    segmentIndex = (scrape.segments || []).findIndex((s) => s.id === currentSession.activeSegmentId);
    if (segmentIndex < 0) {
      throw new Error("Сегмент не найден");
    }
    segment = scrape.segments[segmentIndex];
  } catch (error) {
    await callApi(token, "sendMessage", {
      chat_id: chatId,
      text: `Ошибка загрузки сегмента: ${error.message}`
    });
    return;
  }

  if (data === "sdvg:toggle_mode") {
    currentSession.randomMode = !currentSession.randomMode;
    await saveSession(botContext.DATA_DIR, currentSession);
    await sendOrEditCard(token, currentSession, scrape, segment);
    return;
  }

  if (data === "sdvg:next") {
    const nextSegment = findNextSegment(scrape, currentSession.activeSegmentId, currentSession.randomMode);
    if (!nextSegment) {
      await callApi(token, "sendMessage", {
        chat_id: chatId,
        text: "Все сегменты выполнены!"
      });
      return;
    }
    currentSession.activeSegmentId = nextSegment.id;
    await saveSession(botContext.DATA_DIR, currentSession);
    await sendOrEditCard(token, currentSession, scrape, nextSegment);
    return;
  }

  if (data === "sdvg:done") {
    // Mark current as done
    scrape.segments[segmentIndex].is_done = true;
    scrape.segments[segmentIndex].updated_at = new Date().toISOString();
    await botContext.writeScrape(scrape);

    const nextSegment = findNextSegment(scrape, currentSession.activeSegmentId, currentSession.randomMode);
    if (!nextSegment) {
      // Edit active card message to show final completed text
      await callApi(token, "editMessageText", {
        chat_id: chatId,
        message_id: currentSession.messageId,
        text: `🎉 Все сегменты сценария <b>${scrape.title}</b> завершены!`,
        parse_mode: "HTML"
      }).catch(() => null);

      currentSession.activeSegmentId = null;
      currentSession.messageId = null;
      await saveSession(botContext.DATA_DIR, currentSession);
      return;
    }

    currentSession.activeSegmentId = nextSegment.id;
    await saveSession(botContext.DATA_DIR, currentSession);
    await sendOrEditCard(token, currentSession, scrape, nextSegment);
    return;
  }

  if (data === "sdvg:download") {
    const url = extractFirstUrl(segment.text);
    if (!url) {
      await callApi(token, "sendMessage", { chat_id: chatId, text: "В тексте сегмента не найдена ссылка для скачивания!" });
      return;
    }

    // Edit message to show downloading state
    await callApi(token, "editMessageText", {
      chat_id: chatId,
      message_id: currentSession.messageId,
      text: `${formatCardText(scrape, segment)}\n\n⏳ <b>[Скачивание]</b> Скачиваю <code>${url}</code>...`,
      parse_mode: "HTML"
    }).catch(() => null);

    const safeTopic = botContext.sanitizeMediaTopicName(segment.topic || "unsorted");
    const { dir } = await botContext.ensureTopicDir(safeTopic);

    const job = {
      id: `bot_${Date.now()}`,
      url,
      topic: safeTopic,
      segment_id: segment.id,
      state: "queued",
      progress: 0,
      output_files: [],
      error: "",
      log: "",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    try {
      await botContext.executeMediaDownload(job);
      if (job.state === "completed" && job.output_files && job.output_files.length > 0) {
        // Attach download files
        const items = segment.media_items || [];
        job.output_files.forEach((file) => {
          if (!items.some((item) => item.path === file.path)) {
            items.push(file);
          }
        });
        
        scrape.segments[segmentIndex].media_items = items;
        scrape.segments[segmentIndex].media = items[0] || null;
        scrape.segments[segmentIndex].is_done = true;
        scrape.segments[segmentIndex].updated_at = new Date().toISOString();
        await botContext.writeScrape(scrape);

        await callApi(token, "sendMessage", {
          chat_id: chatId,
          text: `📥 Файл <code>${job.output_files[0].name}</code> успешно скачан и прикреплен к сегменту!`,
          parse_mode: "HTML"
        });

        // Switch to next segment after a short delay
        setTimeout(async () => {
          const freshScrape = await botContext.readScrape(currentSession.scrapeId);
          const nextSegment = findNextSegment(freshScrape, currentSession.activeSegmentId, currentSession.randomMode);
          if (!nextSegment) {
            await callApi(token, "sendMessage", {
              chat_id: chatId,
              text: `🎉 Все сегменты сценария <b>${scrape.title}</b> завершены!`,
              parse_mode: "HTML"
            });
            currentSession.activeSegmentId = null;
            currentSession.messageId = null;
            await saveSession(botContext.DATA_DIR, currentSession);
            return;
          }
          currentSession.activeSegmentId = nextSegment.id;
          await saveSession(botContext.DATA_DIR, currentSession);
          await sendOrEditCard(token, currentSession, freshScrape, nextSegment);
        }, 1200);

      } else {
        throw new Error(job.error || "Скачивание завершилось неудачно");
      }
    } catch (error) {
      await callApi(token, "sendMessage", {
        chat_id: chatId,
        text: `❌ Ошибка скачивания: ${error.message}`
      });
      // Restore normal card view on error
      await sendOrEditCard(token, currentSession, scrape, segment).catch(() => null);
    }
    return;
  }

  if (data === "sdvg:screenshot") {
    const url = extractFirstUrl(segment.text);
    if (!url) {
      await callApi(token, "sendMessage", { chat_id: chatId, text: "В тексте сегмента не найдена ссылка для скриншота!" });
      return;
    }

    // Edit message to show screenshotting state
    await callApi(token, "editMessageText", {
      chat_id: chatId,
      message_id: currentSession.messageId,
      text: `${formatCardText(scrape, segment)}\n\n📸 <b>[Скриншот]</b> Генерирую скриншот для <code>${url}</code>...`,
      parse_mode: "HTML"
    }).catch(() => null);

    const safeTopic = botContext.sanitizeMediaTopicName(segment.topic || "unsorted");
    const { dir } = await botContext.ensureTopicDir(safeTopic);
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
    const suffix = Math.random().toString(36).slice(2, 8);
    const fileName = `shot_${stamp}_${suffix}.png`;
    const targetPath = path.join(dir, fileName);
    const scriptPath = path.resolve(botContext.DATA_DIR, "../../VBAUT/screenshot-engine/link-screenshot.js");

    try {
      const child = botContext.spawn(process.execPath, [
        scriptPath,
        "--url", url,
        "--width", "1280",
        "--height", "720",
        "--zoom", "100"
      ], { windowsHide: true });

      const stdoutChunks = [];
      let stderrText = "";

      child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
      child.stderr.on("data", (chunk) => { stderrText += chunk.toString(); });

      await new Promise((resolve, reject) => {
        child.on("close", (code) => {
          if (code !== 0) {
            reject(new Error(stderrText.trim() || `Скриншотер завершился с кодом ${code}`));
          } else {
            resolve();
          }
        });
        child.on("error", reject);
      });

      const buffer = Buffer.concat(stdoutChunks);
      if (!buffer.length) {
        throw new Error("Скриншотер вернул пустой буфер");
      }
      await fs.writeFile(targetPath, buffer);

      const relPath = `${safeTopic}/${fileName}`;
      const stats = await fs.stat(targetPath);
      const mediaItem = {
        path: relPath,
        name: fileName,
        topic: safeTopic,
        size: stats.size,
        updated_at: new Date().toISOString(),
        thumbnail: `/api/media/raw?path=${encodeURIComponent(relPath)}`
      };

      const items = segment.media_items || [];
      items.push(mediaItem);
      scrape.segments[segmentIndex].media_items = items;
      scrape.segments[segmentIndex].media = items[0] || null;
      scrape.segments[segmentIndex].is_done = true;
      scrape.segments[segmentIndex].updated_at = new Date().toISOString();
      await botContext.writeScrape(scrape);

      // Send the screenshot as a photo to confirm visually
      await callApi(token, "sendPhoto", {
        chat_id: chatId,
        photo: `http://localhost:${botContext.PORT}/api/media/raw?path=${encodeURIComponent(relPath)}`,
        caption: `📸 Скриншот успешно сгенерирован и сохранен в PAMPAM!`,
      }).catch(async (e) => {
        // Fallback if photo send fails
        await callApi(token, "sendMessage", {
          chat_id: chatId,
          text: `📸 Скриншот успешно сгенерирован как <code>${fileName}</code> и прикреплен к сегменту!`,
          parse_mode: "HTML"
        });
      });

      // Switch to next segment after a short delay
      setTimeout(async () => {
        const freshScrape = await botContext.readScrape(currentSession.scrapeId);
        const nextSegment = findNextSegment(freshScrape, currentSession.activeSegmentId, currentSession.randomMode);
        if (!nextSegment) {
          await callApi(token, "sendMessage", {
            chat_id: chatId,
            text: `🎉 Все сегменты сценария <b>${scrape.title}</b> завершены!`,
            parse_mode: "HTML"
          });
          currentSession.activeSegmentId = null;
          currentSession.messageId = null;
          await saveSession(botContext.DATA_DIR, currentSession);
          return;
        }
        currentSession.activeSegmentId = nextSegment.id;
        await saveSession(botContext.DATA_DIR, currentSession);
        await sendOrEditCard(token, currentSession, freshScrape, nextSegment);
      }, 1200);

    } catch (error) {
      await callApi(token, "sendMessage", {
        chat_id: chatId,
        text: `❌ Ошибка генерации скриншота: ${error.message}`
      });
      // Restore normal card view on error
      await sendOrEditCard(token, currentSession, scrape, segment).catch(() => null);
    }
    return;
  }
}

/**
 * Public function to trigger broad casting from web UI click
 */
export async function triggerWebBroadcast(scrapeId) {
  if (!botRunning || !botContext) {
    throw new Error("Telegram Bot не запущен");
  }
  const token = process.env.UCONTENT_BOT_TOKEN || DEFAULT_TOKEN;
  if (!currentSession.chatId) {
    throw new Error("Нет привязанного чата. Сначала отправьте боту в Telegram команду /start");
  }

  const scrape = await botContext.readScrape(scrapeId);
  currentSession.scrapeId = scrape.id;
  currentSession.messageId = null;
  
  const nextSegment = findNextSegment(scrape, currentSession.activeSegmentId, currentSession.randomMode);
  if (!nextSegment) {
    await callApi(token, "sendMessage", {
      chat_id: currentSession.chatId,
      text: `🎉 Все сегменты в сценарии <b>${scrape.title}</b> выполнены!`,
      parse_mode: "HTML"
    });
    currentSession.activeSegmentId = null;
    await saveSession(botContext.DATA_DIR, currentSession);
    return { status: "completed", message: "Все сегменты уже выполнены" };
  }

  currentSession.activeSegmentId = nextSegment.id;
  await saveSession(botContext.DATA_DIR, currentSession);
  await sendOrEditCard(token, currentSession, scrape, nextSegment);
  return { status: "sent", message: `Транслирую сценарий ${scrape.title} в Telegram!` };
}

/**
 * Initializes and starts the Telegram bot long polling loop
 */
export async function startTelegramBot(context) {
  if (botRunning) return;
  botContext = context;
  botRunning = true;

  const token = process.env.UCONTENT_BOT_TOKEN || DEFAULT_TOKEN;
  await loadSession(context.DATA_DIR);

  console.log(`[bot] Starting Telegram Bot with token: ${token.slice(0, 12)}...`);

  // Start polling in background
  (async () => {
    while (botRunning) {
      try {
        const updates = await callApi(token, "getUpdates", {
          offset,
          timeout: 25
        });

        for (const update of updates) {
          offset = update.update_id + 1;
          
          if (update.message && update.message.text) {
            await handleTextMessage(token, update.message);
          } else if (update.callback_query) {
            await handleCallbackQuery(token, update.callback_query);
          }
        }
      } catch (error) {
        console.error("[bot-polling] Error during getUpdates polling:", error.message);
        // Wait 4 seconds on error before retrying to prevent rapid loops
        await new Promise((resolve) => setTimeout(resolve, 4000));
      }
    }
  })();
}

export async function stopTelegramBot() {
  botRunning = false;
  console.log("[bot] Telegram Bot stopped");
}
