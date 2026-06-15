import { promises as fs, createReadStream, createWriteStream } from "node:fs";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
import { isYtDlpCandidateUrl } from "../VBAUT/backend/src/downloader.js";


// Default Token for @utcontentbot if not specified in env
const DEFAULT_TOKEN = "8668449496:AAGiTFs0j2tR4apeHDk-g0AMek8Ud4ZNjGw";

let rawBaseApi = process.env.TELEGRAM_BASE_API_URL || process.env.BASE_API_URL || "http://127.0.0.1:8081/bot";
if (rawBaseApi.includes("://tgbotapi:")) {
  rawBaseApi = rawBaseApi.replace("://tgbotapi:", "://127.0.0.1:");
}
const BASE_API_URL = rawBaseApi.replace(/\/$/, "");

let rawBaseFile = process.env.TELEGRAM_BASE_FILE_URL || process.env.BASE_FILE_URL || "http://127.0.0.1:8081/file";
if (rawBaseFile.includes("://tgbotapi:")) {
  rawBaseFile = rawBaseFile.replace("://tgbotapi:", "://127.0.0.1:");
}
const BASE_FILE_URL = rawBaseFile.replace(/\/$/, "");

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
      randomMode: false,
      sdvgMaxMode: false, // only show segments starting with /
      shotCtx: null,
      timecodeCtx: null
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
  const url = `${BASE_API_URL}${token}/${method}`;
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

const SCREENSHOT_SCRIPT_PATH = "c:/tgbotapi/VBAUT/screenshot-engine/link-screenshot.js";

/**
 * Sends a local file to Telegram using multipart/form-data
 */
async function callApiMultipart(token, method, fields, fileField, filePath, fileName) {
  const boundary = `----TGBotBoundary${Date.now().toString(16)}`;
  const chunks = [];
  for (const [key, val] of Object.entries(fields)) {
    if (val === undefined || val === null) continue;
    const strVal = typeof val === "object" ? JSON.stringify(val) : String(val);
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${strVal}\r\n`
    ));
  }
  const fileBuffer = await fs.readFile(filePath);
  chunks.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`
  ));
  chunks.push(fileBuffer);
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  const body = Buffer.concat(chunks);
  const url = `${BASE_API_URL}${token}/${method}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body
  });
  const resData = await response.json();
  if (!resData.ok) throw new Error(resData.description || `Telegram API error: ${method}`);
  return resData.result;
}

// --- Screenshot profile helpers (mirrors VBAUT) ---
const SHOT_PRESETS = [
  { key: "standard", label: "2:1",  width: 2560, height: 1280 },
  { key: "square",   label: "1:1",  width: 1280, height: 1280 },
  { key: "wide",     label: "16:9", width: 2560, height: 1440 }
];

function normShotProfile(p = {}) {
  const clamp = (v, def, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def; };
  return {
    width:  clamp(p.width,  2560, 320,  3840),
    height: clamp(p.height, 1280, 240,  5120),
    zoom:   clamp(p.zoom,   400,  50,   800),
    scroll: clamp(p.scroll, 0,    0,    20000)
  };
}

function shotProfileKey(p)  { const n = normShotProfile(p); return `${n.width}x${n.height}@${n.zoom}S${n.scroll}`; }
function shotProfileLabel(p){ const n = normShotProfile(p); return `${n.width}×${n.height} @ ${n.zoom}%${n.scroll ? ` ↓${n.scroll}px` : ""}`; }

function cycleShotFormat(p) {
  const n = normShotProfile(p);
  const ratio = n.height > 0 ? n.width / n.height : 2;
  const current = SHOT_PRESETS
    .map(ps => ({ ...ps, d: Math.abs(ps.width / ps.height - ratio) }))
    .sort((a, b) => a.d - b.d)[0];
  const idx = SHOT_PRESETS.findIndex(ps => ps.key === current.key);
  const next = SHOT_PRESETS[(idx + 1) % SHOT_PRESETS.length];
  return normShotProfile({ ...n, width: next.width, height: next.height });
}

function buildShotKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "🌐",   callback_data: "sdvg:shot:format" },
        { text: "📜⬆️", callback_data: "sdvg:shot:shorter" },
        { text: "📜⬇️", callback_data: "sdvg:shot:taller" },
        { text: "🔎⬆️", callback_data: "sdvg:shot:zoomin" },
        { text: "🔎⬇️", callback_data: "sdvg:shot:zoomout" }
      ],
      [
        { text: "⬆️ Скролл", callback_data: "sdvg:shot:scrollup" },
        { text: "⬇️ Скролл", callback_data: "sdvg:shot:scrolldown" }
      ],
      [
        { text: "+",  callback_data: "sdvg:shot:add" },
        { text: "-",  callback_data: "sdvg:shot:drop" },
        { text: "📸+", callback_data: "sdvg:shot:retry" }
      ]
    ]
  };
}

/**
 * Spawns link-screenshot.js and returns the PNG buffer.
 */
async function captureScreenshot(url, profile) {
  const { width, height, zoom, scroll } = normShotProfile(profile);
  const child = (await import("node:child_process")).spawn(
    process.execPath,
    [SCREENSHOT_SCRIPT_PATH, "--url", url, "--width", String(width), "--height", String(height), "--zoom", String(zoom), "--scroll", String(scroll)],
    { windowsHide: true }
  );
  const chunks = [];
  let stderr = "";
  child.stdout.on("data", c => chunks.push(c));
  child.stderr.on("data", c => { stderr += c.toString(); });
  await new Promise((resolve, reject) => {
    child.on("close", code => code === 0 ? resolve() : reject(new Error(stderr.trim() || `exit ${code}`)));
    child.on("error", reject);
  });
  const buf = Buffer.concat(chunks);
  if (!buf.length) throw new Error("Скриншотер вернул пустой буфер");
  return buf;
}

/**
 * Extracts the first URL from a given string
 */
function extractFirstUrl(text) {
  const match = String(text ?? "").match(/https?:\/\/[^\s]+/i);
  return match ? match[0] : null;
}

function formatMediaItemName(item) {
  const raw = String(item.name || item.path || item.url || "");
  if (raw.startsWith("http://") || raw.startsWith("https://")) {
    try {
      const urlObj = new URL(raw);
      if (/\.[a-z0-9]+$/i.test(urlObj.pathname)) {
        return path.basename(urlObj.pathname.replace(/\\/g, "/"));
      }
      const label = urlObj.hostname + urlObj.pathname;
      return label.length > 30 ? label.slice(0, 27) + "..." : label;
    } catch {
      return raw.length > 30 ? raw.slice(0, 27) + "..." : raw;
    }
  }
  const base = path.basename(raw.replace(/\\/g, "/"));
  return base.length > 35 ? base.slice(0, 32) + "..." : base;
}

/**
 * Formats the HTML content for the segment card in Telegram
 */
function formatCardText(scrape, segment, session) {
  const text = segment.text || "";
  
  const escapeHtml = (val) => String(val ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  let header = "";
  if (session && session.sdvgMaxMode) {
    header = `⚡ <b>[MAX]</b> `;
  }

  let quoteHtml = "";
  const trimmed = text.trim();
  const isDirection = trimmed.startsWith("/");
  const isLink = segment.type === "link" || trimmed.startsWith("http://") || trimmed.startsWith("https://");

  if (isDirection || isLink) {
    const idx = (scrape.segments || []).findIndex((s) => s.id === segment.id);
    let quoteText = null;

    if (idx > 0) {
      // Scan backwards for the nearest non-link, non-direction text segment in the same topic
      for (let i = idx - 1; i >= 0; i--) {
        const s = scrape.segments[i];
        if (s.topic !== segment.topic) {
          break; // Crossed the topic boundary
        }
        const t = (s.text || "").trim();
        if (t && !t.startsWith("/") && !t.startsWith("http://") && !t.startsWith("https://")) {
          quoteText = s.text;
          break;
        }
      }
    }

    if (quoteText) {
      quoteHtml = `<blockquote>${escapeHtml(quoteText)}</blockquote>\n\n`;
    } else if (segment.topic) {
      quoteHtml = `<blockquote><b>${escapeHtml(segment.topic)}</b></blockquote>\n\n`;
    }
  }

  let msg = header + quoteHtml + `${escapeHtml(text)}`;
  
  if (segment.media_items && segment.media_items.length > 0) {
    msg += `\n\n<b>Прикреплено:</b>\n`;
    segment.media_items.forEach((item, index) => {
      msg += `  ${index + 1}. <code>${escapeHtml(formatMediaItemName(item))}</code>\n`;
    });
  }
  
  return msg;
}

async function startScreenshotPreview(token, chatId, scrape, segment, segmentIndex, url) {
  const safeTopic = botContext.sanitizeMediaTopicName(segment.topic || "unsorted");
  const { dir } = await botContext.ensureTopicDir(safeTopic);
  
  // Inform the user
  const statusMsg = await callApi(token, "sendMessage", {
    chat_id: chatId,
    text: `📸 <b>[Скриншот]</b> Анализирую страницу и генерирую скриншот...`,
    parse_mode: "HTML"
  });

  // Try fetching og:image first
  try {
    const previewRes = await fetch(`http://localhost:${botContext.PORT}/api/preview?url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(8000) });
    if (previewRes.ok) {
      const preview = await previewRes.json();
      const ogImage = preview.image;
      if (ogImage && /^https?:\/\//i.test(ogImage)) {
        const imgRes = await fetch(ogImage, { redirect: "follow", signal: AbortSignal.timeout(12000) });
        if (imgRes.ok) {
          const imgBuf = Buffer.from(await imgRes.arrayBuffer());
          const imgExt = ogImage.split("?")[0].match(/\.(png|jpe?g|webp|gif)$/i)?.[1] ?? "jpg";
          const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
          const suffix = Math.random().toString(36).slice(2, 8);
          const thumbName = `thumb_${stamp}_${suffix}.${imgExt}`;
          const thumbPath = path.join(dir, thumbName);
          await fs.writeFile(thumbPath, imgBuf);
          const relPath = `${safeTopic}/${thumbName}`;
          const mediaItem = {
            path: relPath,
            name: thumbName,
            topic: safeTopic,
            size: imgBuf.length,
            updated_at: new Date().toISOString(),
            thumbnail: `/api/media/raw?path=${encodeURIComponent(relPath)}`
          };
          const items = segment.media_items || [];
          if (!items.some(it => it.name === thumbName)) {
            items.push(mediaItem);
            scrape.segments[segmentIndex].media_items = items;
            scrape.segments[segmentIndex].media = items[0] || null;
            scrape.segments[segmentIndex].updated_at = new Date().toISOString();
            await botContext.writeScrape(scrape);

            // Send as document/photo to show it has been successfully downloaded and attached
            await callApiMultipart(token, "sendDocument", {
              chat_id: chatId,
              caption: `📸 <a href="${url}">${new URL(url).hostname}</a>\n🖼 og:image`,
              parse_mode: "HTML"
            }, "document", thumbPath, thumbName);
          }
        }
      }
    }
  } catch (err) {
    console.error("[bot] og:image preview fetch failed:", err.message);
  }

  // Generate the live screenshot immediately using default profile
  const defaultProfile = normShotProfile({});
  const tempPath = path.join(dir, `preview_init_${Date.now()}.png`);
  
  try {
    const buf = await captureScreenshot(url, defaultProfile);
    await fs.writeFile(tempPath, buf);

    const profileLabel = shotProfileLabel(defaultProfile);
    const hostLabel = new URL(url).hostname;
    
    // Delete the status text message to avoid clutter
    await callApi(token, "deleteMessage", { chat_id: chatId, message_id: statusMsg.message_id }).catch(() => null);

    // Send the live screenshot as a photo with keyboard
    const photoMsg = await callApiMultipart(token, "sendPhoto", {
      chat_id: chatId,
      caption: `📸 <b>Скриншот</b>\n<a href="${url}">${hostLabel}</a>\n🖥 ${profileLabel}\n\nНастройте параметры и нажмите <b>+</b> для захвата.`,
      parse_mode: "HTML",
      reply_markup: buildShotKeyboard()
    }, "photo", tempPath, "preview.png");

    currentSession.shotCtx = {
      url,
      scrapeId: currentSession.scrapeId,
      segmentId: segment.id,
      profile: defaultProfile,
      messageId: photoMsg.message_id
    };
    await saveSession(botContext.DATA_DIR, currentSession);
    
    // Also restore/refresh the main segment card to show updated attached media
    await sendOrEditCard(token, currentSession, scrape, segment).catch(() => null);
  } catch (err) {
    await callApi(token, "deleteMessage", { chat_id: chatId, message_id: statusMsg.message_id }).catch(() => null);
    await callApi(token, "sendMessage", {
      chat_id: chatId,
      text: `❌ Не удалось сгенерировать скриншот сайта: ${err.message}\nВы можете настроить / повторить попытку позже.`,
      parse_mode: "HTML"
    });
  } finally {
    await fs.unlink(tempPath).catch(() => null);
  }
}

async function processDownload(token, chatId, scrape, segment, segmentIndex, url) {
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

      const mediaIndex = items.length - 1;
      await callApi(token, "sendMessage", {
        chat_id: chatId,
        text: `📥 Файл <code>${formatMediaItemName(job.output_files[0])}</code> успешно скачан и прикреплен к сегменту!`,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "⏱️ Указать таймкод", callback_data: `sdvg:timecode:${segment.id}:${mediaIndex}` }
            ]
          ]
        }
      });

      // Switch to next segment after a short delay
      setTimeout(async () => {
        const freshScrape = await botContext.readScrape(currentSession.scrapeId);
        const nextSegment = findNextSegment(freshScrape, currentSession.activeSegmentId, currentSession.randomMode, currentSession.sdvgMaxMode);
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
      throw new Error(job.error || "Не удалось загрузить медиа-файл");
    }
  } catch (error) {
    // If downloading failed, fall back to screenshotting!
    await callApi(token, "sendMessage", {
      chat_id: chatId,
      text: `⚠️ Не удалось скачать медиа (неподдерживаемый сайт). Запускаю скриншотер...`,
      parse_mode: "HTML"
    }).catch(() => null);
    await startScreenshotPreview(token, chatId, scrape, segment, segmentIndex, url);
  }
}

/**
 * Builds the inline keyboard reply markup for a segment card
 */
function buildCardMarkup(session, segment, hasLink) {
  const keyboard = [];
  
  // Navigation buttons row
  const navRow = [
    { text: session.randomMode ? "🎲" : "📚", callback_data: "sdvg:toggle_mode" },
    { text: "✅", callback_data: "sdvg:done" },
    { text: "⏭️", callback_data: "sdvg:next" }
  ];
  keyboard.push(navRow);

  // Link actions row
  if (hasLink) {
    const linkRow = [
      { text: "📥", callback_data: "sdvg:download" },
      { text: "📸", callback_data: "sdvg:screenshot" }
    ];
    keyboard.push(linkRow);
  }

  return { inline_keyboard: keyboard };
}

/**
 * Finds the next undone segment in the scrape
 */
function findNextSegment(scrape, currentSegmentId, randomMode, sdvgMaxMode) {
  let segments = scrape.segments || [];
  if (segments.length === 0) return null;

  if (sdvgMaxMode) {
    segments = segments.filter((s) => (s.text || "").trim().startsWith("/"));
  }
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
  const text = formatCardText(scrape, segment, session);
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

function extractMessageMedia(message) {
  if (message.video) {
    return {
      type: "video",
      fileId: message.video.file_id,
      fileUniqueId: message.video.file_unique_id,
      fileName: message.video.file_name || `video_${Date.now()}.mp4`,
      fileSize: message.video.file_size
    };
  }
  if (message.document) {
    return {
      type: "document",
      fileId: message.document.file_id,
      fileUniqueId: message.document.file_unique_id,
      fileName: message.document.file_name || `document_${Date.now()}`,
      fileSize: message.document.file_size
    };
  }
  if (message.photo && Array.isArray(message.photo) && message.photo.length > 0) {
    const photo = message.photo[message.photo.length - 1];
    return {
      type: "photo",
      fileId: photo.file_id,
      fileUniqueId: photo.file_unique_id,
      fileName: `photo_${Date.now()}.jpg`,
      fileSize: photo.file_size
    };
  }
  if (message.animation) {
    return {
      type: "animation",
      fileId: message.animation.file_id,
      fileUniqueId: message.animation.file_unique_id,
      fileName: message.animation.file_name || `animation_${Date.now()}.mp4`,
      fileSize: message.animation.file_size
    };
  }
  if (message.audio) {
    return {
      type: "audio",
      fileId: message.audio.file_id,
      fileUniqueId: message.audio.file_unique_id,
      fileName: message.audio.file_name || `audio_${Date.now()}.mp3`,
      fileSize: message.audio.file_size
    };
  }
  if (message.voice) {
    return {
      type: "voice",
      fileId: message.voice.file_id,
      fileUniqueId: message.voice.file_unique_id,
      fileName: `voice_${Date.now()}.ogg`,
      fileSize: message.voice.file_size
    };
  }
  if (message.video_note) {
    return {
      type: "video_note",
      fileId: message.video_note.file_id,
      fileUniqueId: message.video_note.file_unique_id,
      fileName: `video_note_${Date.now()}.mp4`,
      fileSize: message.video_note.file_size
    };
  }
  return null;
}

function isImageFile(filename) {
  return /\.(jpg|jpeg|png|webp|gif|bmp)$/i.test(filename);
}

async function handleMediaMessage(token, message, media) {
  const chatId = message.chat.id;
  if (!currentSession.scrapeId || !currentSession.activeSegmentId) {
    await callApi(token, "sendMessage", {
      chat_id: chatId,
      text: "⚠️ Нет активного сегмента для прикрепления медиа-файла. Откройте сегмент с помощью команды /sdvg."
    });
    return;
  }

  // Get active segment
  const freshScrape = await botContext.readScrape(currentSession.scrapeId);
  const segIdx = (freshScrape.segments || []).findIndex(s => s.id === currentSession.activeSegmentId);
  if (segIdx < 0) {
    await callApi(token, "sendMessage", {
      chat_id: chatId,
      text: "⚠️ Активный сегмент не найден в текущем сценарии."
    });
    return;
  }

  const seg = freshScrape.segments[segIdx];
  const topic = botContext.sanitizeMediaTopicName(seg.topic || "unsorted");
  const { dir: topicDir } = await botContext.ensureTopicDir(topic);

  // Send status message to user: downloading file
  const statusMsg = await callApi(token, "sendMessage", {
    chat_id: chatId,
    text: `📥 <b>Скачиваю файл:</b> <code>${media.fileName}</code>...`,
    parse_mode: "HTML"
  });

  try {
    // 1. Get file_path from telegram
    const fileResult = await callApi(token, "getFile", { file_id: media.fileId });
    const rawFilePath = String(fileResult?.file_path ?? "").trim();
    if (!rawFilePath) {
      throw new Error("Telegram не вернул file_path");
    }

    // 2. Determine target file path
    const cleanName = media.fileName.replace(/[\\/:*?"<>|]/g, "_");
    let targetPath = path.join(topicDir, cleanName);
    
    // Check uniqueness
    let counter = 1;
    const ext = path.extname(cleanName);
    const base = path.basename(cleanName, ext);
    while (true) {
      try {
        await fs.access(targetPath);
        targetPath = path.join(topicDir, `${base}_${counter}${ext}`);
        counter++;
      } catch {
        break;
      }
    }
    const finalName = path.basename(targetPath);

    // 3. Download from local Bot API or official API
    const raw = String(rawFilePath ?? "").trim().replace(/\\/g, "/");
    const normalizedPrefix = "/var/lib/telegram-bot-api";
    const prefixWithSlash = `${normalizedPrefix}/`;
    let filePath = raw;
    if (raw.startsWith(prefixWithSlash)) {
      filePath = raw.slice(prefixWithSlash.length);
    }
    filePath = filePath.replace(/^\/+/, "");

    const candidates = [];
    const isRemote = BASE_FILE_URL.includes("api.telegram.org");

    if (isRemote) {
      candidates.push(`${BASE_FILE_URL}/bot${token}/${filePath}`);
      if (raw !== filePath) {
        candidates.push(`${BASE_FILE_URL}/bot${token}/${raw}`);
      }
    } else {
      // Local Bot API Candidates
      candidates.push(`${BASE_FILE_URL}/${filePath}`);
      candidates.push(`${BASE_FILE_URL}/bot${token}/${filePath}`);
      if (raw !== filePath) {
        candidates.push(`${BASE_FILE_URL}/${raw}`);
        candidates.push(`${BASE_FILE_URL}/bot${token}/${raw}`);
      }
    }

    let res = null;
    let lastError = "";
    for (const url of candidates) {
      try {
        console.log(`[bot] Trying to download file from URL candidate: ${url}`);
        res = await fetch(url);
        if (res.ok && res.body) {
          break;
        }
        lastError = `HTTP ${res.status}: ${res.statusText}`;
      } catch (err) {
        lastError = err.message;
      }
    }

    let downloaded = false;
    if (res && res.ok && res.body) {
      const fileStream = createWriteStream(targetPath);
      await pipeline(Readable.fromWeb(res.body), fileStream);
      downloaded = true;
    } else {
      // Docker cp fallback
      const dockerContainerName = process.env.TELEGRAM_DOCKER_CONTAINER_NAME || "tgbotapi";
      const hasDockerLocalPath = raw.startsWith(normalizedPrefix);
      if (hasDockerLocalPath) {
        try {
          console.log(`[bot] HTTP failed (${lastError}). Trying docker cp fallback: docker cp ${dockerContainerName}:${raw} ${targetPath}`);
          await execFileAsync("docker", ["cp", `${dockerContainerName}:${raw}`, targetPath], {
            windowsHide: true
          });
          downloaded = true;
        } catch (dockerErr) {
          console.error("[bot] docker cp fallback failed:", dockerErr.message);
          lastError = `HTTP download failed (${lastError}) and docker cp failed (${dockerErr.message})`;
        }
      }
    }

    if (!downloaded) {
      throw new Error(`Не удалось скачать файл. Last error: ${lastError}`);
    }

    // 4. Attach to segment
    const relPath = `${topic}/${finalName}`;
    const stats = await fs.stat(targetPath);
    const mediaItem = {
      path: relPath,
      name: finalName,
      topic,
      size: stats.size,
      updated_at: new Date().toISOString(),
      thumbnail: isImageFile(finalName) ? `/api/media/raw?path=${encodeURIComponent(relPath)}` : ""
    };

    const items = seg.media_items || [];
    items.push(mediaItem);
    freshScrape.segments[segIdx].media_items = items;
    freshScrape.segments[segIdx].media = freshScrape.segments[segIdx].media || items[0];
    freshScrape.segments[segIdx].is_done = true; // Mark segment as done once file is attached
    freshScrape.segments[segIdx].updated_at = new Date().toISOString();
    await botContext.writeScrape(freshScrape);

    const mediaIndex = items.length - 1;
    // 5. Update status message
    await callApi(token, "editMessageText", {
      chat_id: chatId,
      message_id: statusMsg.message_id,
      text: `✅ <b>Файл успешно сохранен!</b>\n📁 <code>${relPath}</code>\nПрикреплен к сегменту <b>${seg.id}</b>.`,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "⏱️ Указать таймкод", callback_data: `sdvg:timecode:${seg.id}:${mediaIndex}` }
          ]
        ]
      }
    });

    // 6. Refresh the segment card to show the attached file
    await sendOrEditCard(token, currentSession, freshScrape, freshScrape.segments[segIdx]);

  } catch (error) {
    console.error("[bot] error downloading media file:", error);
    await callApi(token, "editMessageText", {
      chat_id: chatId,
      message_id: statusMsg.message_id,
      text: `❌ <b>Ошибка при скачивании файла:</b> ${error.message}`,
      parse_mode: "HTML"
    });
  }
}

/**
 * Main command router for text messages
 */
async function handleTextMessage(token, message) {
  const chatId = message.chat.id;
  const text = String(message.text || message.caption || "").trim();

  // Initialize or pair session
  if (currentSession.chatId !== chatId) {
    currentSession.chatId = chatId;
    currentSession.messageId = null;
    await saveSession(botContext.DATA_DIR, currentSession);
  }

  if (currentSession.timecodeCtx && !text.startsWith("/")) {
    const ctx = currentSession.timecodeCtx;
    currentSession.timecodeCtx = null;
    await saveSession(botContext.DATA_DIR, currentSession);

    if (text.toLowerCase() === "отмена" || text.toLowerCase() === "cancel") {
      await callApi(token, "sendMessage", {
        chat_id: chatId,
        text: `❌ Установка таймкода отменена.`
      });
      return;
    }

    try {
      const freshScrape = await botContext.readScrape(currentSession.scrapeId);
      const segIdx = freshScrape.segments.findIndex(s => s.id === ctx.segmentId);
      if (segIdx !== -1) {
        const seg = freshScrape.segments[segIdx];
        const mediaItem = seg.media_items[ctx.mediaIndex];
        if (mediaItem) {
          mediaItem.timecode = text;
          mediaItem.updated_at = new Date().toISOString();
          
          if (seg.media && seg.media.path === mediaItem.path) {
            seg.media.timecode = text;
          }
          
          await botContext.writeScrape(freshScrape);
          
          await callApi(token, "sendMessage", {
            chat_id: chatId,
            text: `✅ Таймкод <code>${text}</code> успешно установлен для файла <code>${mediaItem.name}</code>!`,
            parse_mode: "HTML"
          });

          // Refresh the card if it's the active one
          if (ctx.segmentId === currentSession.activeSegmentId) {
            await sendOrEditCard(token, currentSession, freshScrape, seg);
          }
          return;
        }
      }
    } catch (err) {
      console.error("[bot] failed to save timecode:", err.message);
      await callApi(token, "sendMessage", {
        chat_id: chatId,
        text: `❌ Не удалось сохранить таймкод: ${err.message}`
      });
    }
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
        "• /sdvgmax — режим только /указаний (сегменты со слэшем)",
        "• /status — показать текущее состояние сессии",
        "",
        "💡 Текстовое сообщение при активном сегменте создаёт новый сегмент-указание.",
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

  if (text.startsWith("/sdvgmax") || text.startsWith("/sdvg")) {
    const isMax = text.startsWith("/sdvgmax");
    const args = text.split(/\s+/).slice(1);
    let scrapeId = args[0] || "";
    try {
      const scrape = await botContext.readScrape(scrapeId);
      currentSession.scrapeId = scrape.id;
      currentSession.messageId = null;
      currentSession.sdvgMaxMode = isMax;
      
      const nextSegment = findNextSegment(scrape, currentSession.activeSegmentId, currentSession.randomMode, isMax);
      if (!nextSegment) {
        const modeLabel = isMax ? " со слэшем" : "";
        await callApi(token, "sendMessage", {
          chat_id: chatId,
          text: `🎉 Все сегменты${modeLabel} в сценарии <b>${scrape.title}</b> выполнены!`,
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

  // If a segment is active, and the message contains a URL, try downloading or screenshotting it
  const url = extractFirstUrl(text);
  if (url && currentSession.scrapeId && currentSession.activeSegmentId) {
    try {
      const scrape = await botContext.readScrape(currentSession.scrapeId);
      const segmentIndex = (scrape.segments || []).findIndex((s) => s.id === currentSession.activeSegmentId);
      if (segmentIndex >= 0) {
        const segment = scrape.segments[segmentIndex];
        if (isYtDlpCandidateUrl(url)) {
          await processDownload(token, chatId, scrape, segment, segmentIndex, url);
        } else {
          await startScreenshotPreview(token, chatId, scrape, segment, segmentIndex, url);
        }
      }
    } catch (error) {
      console.error("[bot] error processing text link:", error.message);
    }
    return;
  }

  // If a segment is active, and the message is plain text, create a new segment starting with /
  if (currentSession.scrapeId && currentSession.activeSegmentId) {
    try {
      const scrape = await botContext.readScrape(currentSession.scrapeId);
      const segmentIndex = (scrape.segments || []).findIndex((s) => s.id === currentSession.activeSegmentId);
      if (segmentIndex >= 0) {
        const segment = scrape.segments[segmentIndex];
        
        let directionText = text;
        if (!directionText.startsWith("/")) {
          directionText = `/${directionText}`;
        }
        
        const newSegment = {
          id: `seg_${Math.random().toString(36).slice(2, 9)}_${Date.now().toString(36)}`,
          text: directionText,
          topic: segment.topic || "unsorted",
          is_done: false,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        };
        
        scrape.segments.splice(segmentIndex + 1, 0, newSegment);
        await botContext.writeScrape(scrape);
        
        currentSession.activeSegmentId = newSegment.id;
        await saveSession(botContext.DATA_DIR, currentSession);
        
        await callApi(token, "sendMessage", {
          chat_id: chatId,
          text: `➕ Добавлен сегмент в тему <b>${segment.topic || "unsorted"}</b>:`,
          parse_mode: "HTML"
        });
        
        await sendOrEditCard(token, currentSession, scrape, newSegment);
        return;
      }
    } catch (error) {
      console.error("[bot] error creating direction segment:", error.message);
    }
  }
}

/**
 * Handles inline button callbacks
 */
async function handleCallbackQuery(token, callbackQuery) {
  const callbackQueryId = callbackQuery.id;
  const callbackId = callbackQueryId; // alias
  const data = callbackQuery.data;
  const chatId = callbackQuery.message.chat.id;
  const callbackMessageId = callbackQuery.message.message_id;

  if (currentSession.chatId !== chatId) {
    currentSession.chatId = chatId;
    await saveSession(botContext.DATA_DIR, currentSession);
  }

  // Acknowledge callback query (skipped for sdvg:shot:* which answer themselves)
  if (!data.startsWith("sdvg:shot:")) {
    await callApi(token, "answerCallbackQuery", { callback_query_id: callbackId }).catch(() => null);
  }

  if (data.startsWith("sdvg:timecode:")) {
    const parts = data.split(":");
    const segmentId = parts[2];
    const mediaIndex = parseInt(parts[3] || "0", 10);

    currentSession.timecodeCtx = {
      segmentId,
      mediaIndex
    };
    await saveSession(botContext.DATA_DIR, currentSession);

    let mediaName = "файла";
    try {
      const freshScrape = await botContext.readScrape(currentSession.scrapeId);
      const seg = freshScrape.segments.find(s => s.id === segmentId);
      if (seg && seg.media_items && seg.media_items[mediaIndex]) {
        mediaName = `"${seg.media_items[mediaIndex].name}"`;
      }
    } catch {}

    await callApi(token, "sendMessage", {
      chat_id: chatId,
      text: `⏱️ <b>Установка таймкода</b>\n\nВведите таймкод для ${mediaName} (например, <code>01:23</code> или диапазон <code>01:20-01:35</code>):\n\nОтправьте <code>отмена</code> для выхода.`,
      parse_mode: "HTML"
    });
    return;
  }

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
    const nextSegment = findNextSegment(scrape, currentSession.activeSegmentId, currentSession.randomMode, currentSession.sdvgMaxMode);
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

    const nextSegment = findNextSegment(scrape, currentSession.activeSegmentId, currentSession.randomMode, currentSession.sdvgMaxMode);
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
    await processDownload(token, chatId, scrape, segment, segmentIndex, url);
    return;
  }

  if (data === "sdvg:screenshot") {
    const url = extractFirstUrl(segment.text);
    if (!url) {
      await callApi(token, "sendMessage", { chat_id: chatId, text: "В тексте сегмента не найдена ссылка для скриншота!" });
      return;
    }
    await startScreenshotPreview(token, chatId, scrape, segment, segmentIndex, url);
    return;
  }

  // --- Screenshot adjustment callbacks ---
  if (data.startsWith("sdvg:shot:")) {
    const action = data.slice("sdvg:shot:".length);
    const ctx = currentSession.shotCtx;
    if (!ctx) {
      await callApi(token, "answerCallbackQuery", { callback_query_id: callbackQueryId, text: "Контекст скриншота устарел.", show_alert: true }).catch(() => null);
      return;
    }

    const freshScrape = await botContext.readScrape(ctx.scrapeId);
    const seg = freshScrape.segments.find(s => s.id === ctx.segmentId);
    const safeTopic = botContext.sanitizeMediaTopicName((seg?.topic) || "unsorted");
    const { dir } = await botContext.ensureTopicDir(safeTopic);

    if (action === "drop") {
      currentSession.shotCtx = null;
      await saveSession(botContext.DATA_DIR, currentSession);
      await callApi(token, "deleteMessage", { chat_id: chatId, message_id: callbackMessageId }).catch(() => null);
      await callApi(token, "answerCallbackQuery", { callback_query_id: callbackQueryId }).catch(() => null);
      return;
    }

    // Profile mutations
    if (["format", "taller", "shorter", "zoomin", "zoomout", "scrolldown", "scrollup"].includes(action)) {
      const p = ctx.profile;
      const next =
        action === "format"  ? cycleShotFormat(p) :
        action === "taller"  ? normShotProfile({ ...p, height: Math.min(5120, p.height + 640) }) :
        action === "shorter" ? normShotProfile({ ...p, height: Math.max(240,  p.height - 640) }) :
        action === "zoomin"  ? normShotProfile({ ...p, zoom:   Math.min(800,  p.zoom   + 50)  }) :
        action === "zoomout" ? normShotProfile({ ...p, zoom:   Math.max(50,   p.zoom   - 50)  }) :
        action === "scrolldown" ? normShotProfile({ ...p, scroll: Math.min(20000, p.scroll + 400) }) :
                               normShotProfile({ ...p, scroll: Math.max(0,     p.scroll - 400) });
      if (shotProfileKey(next) === shotProfileKey(p)) {
        const tip =
          action === "taller" ? "Уже максимальная высота." :
          action === "shorter" ? "Уже минимальная высота." :
          action === "zoomin" ? "Макс. масштаб." :
          action === "zoomout" ? "Мин. масштаб." :
          action === "scrolldown" ? "Дальше прокрутить нельзя." :
          action === "scrollup" ? "Мы уже в самом верху." :
          "Форматы закончились.";
        await callApi(token, "answerCallbackQuery", { callback_query_id: callbackQueryId, text: tip, show_alert: true }).catch(() => null);
        return;
      }

      // Update caption of the photo to show loading state
      await callApi(token, "editMessageCaption", {
        chat_id: chatId,
        message_id: callbackMessageId,
        caption: `📸 <b>Снимаю скриншот...</b>\n🖥 ${shotProfileLabel(next)}`,
        parse_mode: "HTML"
      }).catch(() => null);

      ctx.profile = next;
      await saveSession(botContext.DATA_DIR, currentSession);

      const tempPath = path.join(dir, `preview_adjust_${Date.now()}.png`);

      try {
        const buf = await captureScreenshot(ctx.url, next);
        await fs.writeFile(tempPath, buf);

        // Edit the photo and caption of the message live!
        await callApiMultipart(token, "editMessageMedia", {
          chat_id: chatId,
          message_id: callbackMessageId,
          media: {
            type: "photo",
            media: "attach://photo",
            caption: `📸 <b>Скриншот</b>\n<a href="${ctx.url}">${new URL(ctx.url).hostname}</a>\n🖥 ${shotProfileLabel(next)}\n\nНастройте параметры и нажмите <b>+</b> для захвата.`,
            parse_mode: "HTML"
          },
          reply_markup: buildShotKeyboard()
        }, "photo", tempPath, "photo.png");

      } catch (err) {
        await callApi(token, "editMessageCaption", {
          chat_id: chatId,
          message_id: callbackMessageId,
          caption: `❌ Ошибка: ${err.message}\n🖥 ${shotProfileLabel(next)}`,
          parse_mode: "HTML",
          reply_markup: buildShotKeyboard()
        }).catch(() => null);
      } finally {
        await fs.unlink(tempPath).catch(() => null);
      }

      await callApi(token, "answerCallbackQuery", { callback_query_id: callbackQueryId }).catch(() => null);
      return;
    }

    // Capture screenshot (+ or retry)
    if (action === "add" || action === "retry") {
      await callApi(token, "editMessageCaption", {
        chat_id: chatId,
        message_id: callbackMessageId,
        caption: `📸 <b>Сохраняю скриншот...</b>\n🖥 ${shotProfileLabel(ctx.profile)}`,
        parse_mode: "HTML"
      }).catch(() => null);
      
      try {
        const buf = await captureScreenshot(ctx.url, ctx.profile);
        const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
        const sfx   = Math.random().toString(36).slice(2, 8);
        const freshScrape = await botContext.readScrape(ctx.scrapeId);
        const segIdx = freshScrape.segments.findIndex(s => s.id === ctx.segmentId);
        
        if (segIdx !== -1) {
          const seg = freshScrape.segments[segIdx];
          const topic = botContext.sanitizeMediaTopicName((seg.topic) || "unsorted");
          const { dir: shotDir } = await botContext.ensureTopicDir(topic);
          const shotName = `shot_${stamp}_${sfx}.png`;
          const shotPath = path.join(shotDir, shotName);
          await fs.writeFile(shotPath, buf);
          const relPath = `${topic}/${shotName}`;
          const stats = await fs.stat(shotPath);
          const mediaItem = {
            path: relPath, name: shotName, topic,
            size: stats.size, updated_at: new Date().toISOString(),
            thumbnail: `/api/media/raw?path=${encodeURIComponent(relPath)}`
          };
          const items = seg.media_items || [];
          items.push(mediaItem);
          freshScrape.segments[segIdx].media_items = items;
          freshScrape.segments[segIdx].media = freshScrape.segments[segIdx].media || items[0];
          
          if (action === "add") {
            freshScrape.segments[segIdx].is_done = true;
          }
          freshScrape.segments[segIdx].updated_at = new Date().toISOString();
          await botContext.writeScrape(freshScrape);
          
          // Send final document to chat
          await callApiMultipart(token, "sendDocument", {
            chat_id: chatId,
            caption: `📸 <a href="${ctx.url}">${new URL(ctx.url).hostname}</a>\n🖥 ${shotProfileLabel(ctx.profile)}`,
            parse_mode: "HTML"
          }, "document", shotPath, shotName);
        }

        if (action === "add") {
          currentSession.shotCtx = null;
          await saveSession(botContext.DATA_DIR, currentSession);
          await callApi(token, "deleteMessage", { chat_id: chatId, message_id: callbackMessageId }).catch(() => null);
          
          // Switch to next segment after a short delay
          setTimeout(async () => {
            const freshScrape2 = await botContext.readScrape(currentSession.scrapeId);
            const nextSegment = findNextSegment(freshScrape2, currentSession.activeSegmentId, currentSession.randomMode, currentSession.sdvgMaxMode);
            if (!nextSegment) {
              await callApi(token, "sendMessage", {
                chat_id: chatId,
                text: `🎉 Все сегменты сценария <b>${freshScrape2.title}</b> завершены!`,
                parse_mode: "HTML"
              });
              currentSession.activeSegmentId = null;
              currentSession.messageId = null;
              await saveSession(botContext.DATA_DIR, currentSession);
              return;
            }
            currentSession.activeSegmentId = nextSegment.id;
            await saveSession(botContext.DATA_DIR, currentSession);
            await sendOrEditCard(token, currentSession, freshScrape2, nextSegment);
          }, 1200);
        } else {
          // retry — keep keyboard, restore panel caption
          await callApi(token, "editMessageCaption", {
            chat_id: chatId,
            message_id: callbackMessageId,
            caption: `📸 <b>Скриншот</b>\n<a href="${ctx.url}">${new URL(ctx.url).hostname}</a>\n🖥 ${shotProfileLabel(ctx.profile)}\n\nНастройте параметры и нажмите <b>+</b> для захвата.`,
            parse_mode: "HTML",
            reply_markup: buildShotKeyboard()
          }).catch(() => null);
        }
      } catch (err) {
        await callApi(token, "editMessageCaption", {
          chat_id: chatId,
          message_id: callbackMessageId,
          caption: `❌ Ошибка: ${err.message}\n🖥 ${shotProfileLabel(ctx.profile)}`,
          parse_mode: "HTML",
          reply_markup: buildShotKeyboard()
        }).catch(() => null);
      }
      await callApi(token, "answerCallbackQuery", { callback_query_id: callbackQueryId }).catch(() => null);
      return;
    }

    await callApi(token, "answerCallbackQuery", { callback_query_id: callbackQueryId }).catch(() => null);
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
  const token = process.env.UCONTENT_BOT_TOKEN || process.env.BOT_TOKEN || DEFAULT_TOKEN;
  if (!currentSession.chatId) {
    throw new Error("Нет привязанного чата. Сначала отправьте боту в Telegram команду /start");
  }

  const scrape = await botContext.readScrape(scrapeId);
  currentSession.scrapeId = scrape.id;
  currentSession.messageId = null;
  
  const nextSegment = findNextSegment(scrape, currentSession.activeSegmentId, currentSession.randomMode, currentSession.sdvgMaxMode);
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

  const token = process.env.UCONTENT_BOT_TOKEN || process.env.BOT_TOKEN || DEFAULT_TOKEN;
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
          console.log(`[bot] Received update_id ${update.update_id}, type: ${update.message ? "message" : update.callback_query ? "callback" : "other"}`);
          
          if (update.message) {
            const chatId = update.message.chat.id;
            if (currentSession.chatId !== chatId) {
              currentSession.chatId = chatId;
              currentSession.messageId = null;
              await saveSession(botContext.DATA_DIR, currentSession);
            }

            const media = extractMessageMedia(update.message);
            if (media) {
              await handleMediaMessage(token, update.message, media);
            } else if (update.message.text || update.message.caption) {
              await handleTextMessage(token, update.message);
            }
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
