import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createTelegramSdvgBotService } from "../VBAUT/backend/src/services/telegram-sdvg-bot.js";
import { createMediaFilesUtils } from "../VBAUT/backend/src/services/media-files.js";

function jsonResponse(result) {
  return { ok: true, text: async () => JSON.stringify({ ok: true, result }) };
}
async function waitFor(predicate, timeoutMs = 10000, intervalMs = 50) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await delay(intervalMs);
  }
  throw new Error('waitFor timeout');
}

const RUSSIA_THEME = "\u0420\u041E\u0421\u0421\u0418\u042F";
const RUSSIA_THEME_LOWER = "\u0440\u043E\u0441\u0441\u0438\u044F";
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vbaut-theme-smoke-'));
const mediaRoot = path.join(tempDir, 'PAMPAM');
const unsortedDir = path.join(mediaRoot, 'UNSORTED');
const existingThemeDir = path.join(mediaRoot, RUSSIA_THEME);
const sourceFile = path.join(unsortedDir, 'sample.mp4');
const targetFile = path.join(existingThemeDir, 'sample.mp4');
await fs.mkdir(unsortedDir, { recursive: true });
await fs.mkdir(existingThemeDir, { recursive: true });
await fs.writeFile(sourceFile, 'sample-video', 'utf8');

const mediaUtils = createMediaFilesUtils({ mediaRoot, mediaMaxFilesList: 100 });
const createdAssets = new Map();
const botSessions = new Map();
const sentMessages = [];
const deletedMessages = [];
let nextMessageId = 100;
let getUpdatesStage = 0;
let assetCounter = 0;
const originalEnv = {
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_SDVG_ENABLED: process.env.TELEGRAM_SDVG_ENABLED,
  TELEGRAM_SDVG_POLL_TIMEOUT_SEC: process.env.TELEGRAM_SDVG_POLL_TIMEOUT_SEC
};
const originalFetch = global.fetch;
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_SDVG_ENABLED = '1';
process.env.TELEGRAM_SDVG_POLL_TIMEOUT_SEC = '1';

const mediaDownloader = {
  isAvailable() { return true; },
  enqueue() { return { id: 'job_1' }; },
  getJob(jobId) {
    if (jobId !== 'job_1') return null;
    return {
      id: 'job_1', status: 'completed', progress: '100%', output_files: ['sample.mp4'],
      meta_title: 'Smoke Theme Video', meta_uploader: 'Smoke Uploader', meta_uploader_url: 'https://example.com/uploader',
      meta_webpage_url: 'https://example.com/video', meta_format_note: '720p', meta_resolution: '1280x720'
    };
  }
};

const deps = {
  appendLinkDecisionsOverride: () => [], appendEvent: async () => null, attachAsset: async () => ({}),
  canonicalizeLinkUrl: (value) => String(value ?? '').trim(),
  collapseDuplicateLinkOnlyTopics: (segments) => ({ segments }),
  createAsset: async (input = {}) => { assetCounter += 1; const asset = { id: `asset_${assetCounter}`, ...input }; createdAssets.set(asset.id, asset); return asset; },
  ensureMediaDir: mediaUtils.ensureMediaDir, getDocumentMediaDownloads: async () => ({}), getDocumentState: async () => null,
  getDocDir: () => tempDir, getMediaDir: mediaUtils.getMediaDir, getSourceMemory: async () => ({}), getSourceProfiles: async () => ({}),
  generateSegmentResearchQueries: async () => [], isHttpUrl: (value) => /^https?:\/\//i.test(String(value ?? '')),
  isMediaAlreadyDownloaded: () => false, isYtDlpCandidateUrl: (value) => /^https?:\/\//i.test(String(value ?? '')),
  listBotSessions: async () => [{ chat_id: '1', user_id: '', pending_payload_json: { selected_download_theme: RUSSIA_THEME } }],
  listDocDecisions: async () => [], listDocuments: async () => [], listDocSegments: async () => [], listRunsForSegment: async () => [],
  listBotSessionsIndexed: async () => [], mediaDownloader, mergeResearchScores: () => [], mergeLinkSegmentsBySection: (l = [], r = []) => [...l, ...r],
  normalizeDocumentMediaDownloads: (value) => value ?? {}, normalizeLinkSegmentsInput: (value) => value ?? [], normalizeLinkUrl: (value) => String(value ?? '').trim(),
  rankSegmentResearchResults: async () => [], readOptionalJson: async () => null, sanitizeMediaTopicName: mediaUtils.sanitizeMediaTopicName, saveVersioned: async () => 1,
  searchQueries: async () => [], splitSegmentsAndDecisions: (segments, decisions) => ({ segmentsData: segments, decisionsData: decisions }), syncDocumentContext: async () => null,
  updateAsset: async (assetId, input = {}) => { const existing = createdAssets.get(assetId); const updated = { ...(existing ?? { id: assetId }), ...input }; createdAssets.set(assetId, updated); return updated; },
  updateSourceProfiles: async () => ({}), upsertBotSession: async (input = {}) => { botSessions.set(`${input.chat_id}:${input.user_id ?? ''}`, input); return input; }
};

function currentControlMessageId() {
  const control = sentMessages.find((item) => JSON.stringify(item.reply_markup ?? {}).includes('sdvg_theme:apply') || JSON.stringify(item.reply_markup ?? {}).includes('sdvg_theme:open'));
  return control?.message_id ?? null;
}

global.fetch = async (url, init = {}) => {
  const methodName = String(url).split('/').pop();
  if (methodName === 'getMe') return jsonResponse({ username: 'utsearchbot' });
  if (methodName === 'getUpdates') {
    if (getUpdatesStage === 0) { getUpdatesStage = 1; return jsonResponse([{ update_id: 1, message: { message_id: 1, chat: { id: 1 }, from: { id: 11 }, text: '/download' } }]); }
    if (getUpdatesStage === 1) { getUpdatesStage = 2; return jsonResponse([{ update_id: 2, message: { message_id: 2, chat: { id: 1 }, from: { id: 11 }, text: 'https://example.com/video' } }]); }
    if (getUpdatesStage === 2) {
      const controlMessageId = currentControlMessageId();
      if (controlMessageId) { getUpdatesStage = 3; return jsonResponse([{ update_id: 3, callback_query: { id: 'cb_new', data: 'sdvg_theme:new', from: { id: 11 }, message: { message_id: controlMessageId, chat: { id: 1 } } } }]); }
      return jsonResponse([]);
    }
    if (getUpdatesStage === 3) {
      if (sentMessages.length >= 4) { getUpdatesStage = 4; return jsonResponse([{ update_id: 4, message: { message_id: 300, chat: { id: 1 }, from: { id: 11 }, text: RUSSIA_THEME_LOWER } }]); }
      return jsonResponse([]);
    }
    if (getUpdatesStage === 4) {
      const controlMessageId = currentControlMessageId();
      if (controlMessageId && deletedMessages.includes(300)) { getUpdatesStage = 5; return jsonResponse([{ update_id: 5, callback_query: { id: 'cb_sel', data: 'sdvg_theme:sel:0', from: { id: 11 }, message: { message_id: controlMessageId, chat: { id: 1 } } } }]); }
      return jsonResponse([]);
    }
    return jsonResponse([]);
  }
  if (methodName === 'sendMessage') { const payload = JSON.parse(String(init.body ?? '{}')); const message = { message_id: nextMessageId++, text: payload.text, reply_markup: payload.reply_markup ?? null }; sentMessages.push(message); return jsonResponse(message); }
  if (methodName === 'editMessageText' || methodName === 'editMessageReplyMarkup') { const payload = JSON.parse(String(init.body ?? '{}')); return jsonResponse({ message_id: Number(payload.message_id) }); }
  if (methodName === 'deleteMessage') { const payload = JSON.parse(String(init.body ?? '{}')); deletedMessages.push(Number(payload.message_id)); return jsonResponse(true); }
  if (methodName === 'answerCallbackQuery') return jsonResponse(true);
  if (methodName === 'sendVideo' || methodName === 'sendDocument') return jsonResponse({ message_id: nextMessageId++ });
  throw new Error(`Unhandled Telegram method: ${methodName}`);
};

const service = createTelegramSdvgBotService(deps);
try {
  service.start();
  await waitFor(async () => { try { await fs.access(targetFile); return true; } catch { return false; } }, 12000, 80);
  await delay(1800);
  const mediaRootEntries = await fs.readdir(mediaRoot, { withFileTypes: true });
  const russianThemes = mediaRootEntries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).filter((name) => name.toLowerCase() === RUSSIA_THEME_LOWER);
  assert.equal(russianThemes.length, 1);
  await assert.rejects(() => fs.access(sourceFile));
  await fs.access(targetFile);
  const sessionState = Array.from(botSessions.values()).at(-1);
  assert.equal(sessionState?.pending_payload_json?.selected_download_theme, RUSSIA_THEME);
  const movedAsset = Array.from(createdAssets.values()).find((item) => String(item.local_path ?? '').includes(`${RUSSIA_THEME}/`));
  assert.ok(movedAsset);
  const result = {
    ok: true,
    target_file: targetFile,
    deleted_messages: deletedMessages,
    selected_download_theme: sessionState?.pending_payload_json?.selected_download_theme ?? null,
    sent_message_count: sentMessages.length
  };
  console.log(JSON.stringify(result, null, 2));
} finally {
  service.stop();
  global.fetch = originalFetch;
  if (originalEnv.TELEGRAM_BOT_TOKEN == null) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = originalEnv.TELEGRAM_BOT_TOKEN;
  if (originalEnv.TELEGRAM_SDVG_ENABLED == null) delete process.env.TELEGRAM_SDVG_ENABLED; else process.env.TELEGRAM_SDVG_ENABLED = originalEnv.TELEGRAM_SDVG_ENABLED;
  if (originalEnv.TELEGRAM_SDVG_POLL_TIMEOUT_SEC == null) delete process.env.TELEGRAM_SDVG_POLL_TIMEOUT_SEC; else process.env.TELEGRAM_SDVG_POLL_TIMEOUT_SEC = originalEnv.TELEGRAM_SDVG_POLL_TIMEOUT_SEC;
  await fs.rm(tempDir, { recursive: true, force: true });
}
process.exit(0);
