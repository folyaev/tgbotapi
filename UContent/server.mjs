import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { scrapeNotionPage } from "../VBAUT/HeadlessNotion/notion-scraper.js";
import { createXmlExportUtils } from "../VBAUT/backend/src/services/xml-export.js";
import { startTelegramBot, triggerWebBroadcast } from "./telegram-bot.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function loadEnv(dir) {
  try {
    const envPath = path.join(dir, ".env");
    const content = await fs.readFile(envPath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const index = trimmed.indexOf("=");
      if (index > 0) {
        const key = trimmed.slice(0, index).trim();
        const val = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
    }
  } catch {
    // ignore
  }
}

await loadEnv(__dirname);
await loadEnv(path.join(__dirname, ".."));

const PORT = Number(process.env.UCONTENT_PORT || 5197);
const DATA_DIR = path.join(__dirname, "data", "scrapes");
const HISTORY_DIR = path.join(DATA_DIR, "history");
const PUBLIC_DIR = path.join(__dirname, "public");
const PAMPAM_ROOT = process.env.PAMPAM_ROOT || process.env.MEDIA_DOWNLOAD_ROOT || "C:\\Users\\Nemifist\\YandexDisk\\PAMPAM";
const VBAUT_DOWNLOADER_DIR = path.join(__dirname, "..", "VBAUT", "MediaDownloaderQt6-5.4.2");
const MEDIA_JOBS = new Map();
const MEDIA_JOB_LIMIT = 100;
const execFileAsync = promisify(execFile);
const DEFAULT_YTDLP_FORMAT = [
  "bv*[height<=1080][vcodec^=avc1][ext=mp4]+ba[acodec^=mp4a]/",
  "b[height<=1080][vcodec^=avc1][ext=mp4]/",
  "bv*[height<=1080]+ba/",
  "b[height<=1080]/best[height<=1080]/best"
].join("");

const MIME_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
  [".md", "text/markdown; charset=utf-8"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".mp4", "video/mp4"],
  [".mov", "video/quicktime"],
  [".webm", "video/webm"]
]);

function json(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(body);
}

function text(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store"
  });
  res.end(body);
}

function normalizeNotionUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    if (!/notion\.(site|so)$/i.test(parsed.hostname) && !/\.notion\.(site|so)$/i.test(parsed.hostname)) {
      return "";
    }
    return parsed.toString();
  } catch {
    return "";
  }
}

function scrapeIdFromUrl(url) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const suffix = Math.random().toString(36).slice(2, 7).padEnd(5, "x");
  return `doc_${timestamp}_${suffix}`;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

async function listScrapes() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const entries = await fs.readdir(DATA_DIR, { withFileTypes: true });
  const items = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(DATA_DIR, entry.name), "utf8");
      const parsed = JSON.parse(raw);
      items.push({
        id: parsed.id,
        url: parsed.url,
        title: parsed.title,
        created_at: parsed.created_at,
        updated_at: parsed.updated_at,
        segments: Array.isArray(parsed.segments) ? parsed.segments.length : 0,
        lines: String(parsed.content ?? "").split(/\r?\n/).length,
        chars: String(parsed.content ?? "").length
      });
    } catch {
      // Ignore broken local scratch files.
    }
  }
  return items.sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")));
}

async function saveScrape({ id, url, content }) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const title = String(content).split(/\r?\n/).find((line) => line.startsWith("# "))?.replace(/^#\s+/, "").trim() || "Untitled";
  const segmentState = assignSegmentIds(content);
  const payload = {
    id,
    url,
    title,
    content,
    segments: segmentState.segments,
    segment_report: segmentState.report,
    created_at: new Date().toISOString()
  };
  await fs.writeFile(path.join(DATA_DIR, `${id}.json`), JSON.stringify(payload, null, 2), "utf8");
  await fs.writeFile(path.join(DATA_DIR, `${id}.md`), content, "utf8");
  await fs.writeFile(path.join(DATA_DIR, "latest.json"), JSON.stringify(payload, null, 2), "utf8");
  return payload;
}

function safeScrapeId(id) {
  return String(id ?? "").replace(/[^a-z0-9_.-]/gi, "");
}

async function readScrape(id) {
  const safeId = safeScrapeId(id);
  const target = safeId ? path.join(DATA_DIR, `${safeId}.json`) : path.join(DATA_DIR, "latest.json");
  const raw = await fs.readFile(target, "utf8");
  return JSON.parse(raw);
}

async function writeScrape(scrape, { writeMarkdown = true } = {}) {
  if (!scrape?.id) throw new Error("scrape id is required");
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(path.join(DATA_DIR, `${scrape.id}.json`), JSON.stringify(scrape, null, 2), "utf8");
  if (writeMarkdown) {
    await fs.writeFile(path.join(DATA_DIR, `${scrape.id}.md`), String(scrape.content ?? ""), "utf8");
  }
  await fs.writeFile(path.join(DATA_DIR, "latest.json"), JSON.stringify(scrape, null, 2), "utf8");
}

async function snapshotScrape(scrape, reason = "snapshot") {
  if (!scrape?.id) return null;
  const safeId = safeScrapeId(scrape.id);
  if (!safeId) return null;
  const dir = path.join(HISTORY_DIR, safeId);
  await fs.mkdir(dir, { recursive: true });
  const createdAt = new Date().toISOString();
  const snapshot = {
    id: `${createdAt.replace(/[:.]/g, "-")}-${reason}`,
    reason,
    created_at: createdAt,
    scrape
  };
  const fileName = `${snapshot.id}.json`;
  await fs.writeFile(path.join(dir, fileName), JSON.stringify(snapshot, null, 2), "utf8");
  const entries = (await fs.readdir(dir, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  await Promise.all(entries.slice(10).map((entry) => fs.unlink(path.join(dir, entry)).catch(() => null)));
  return { ...snapshot, file: fileName };
}

async function latestScrapeSnapshot(id) {
  const safeId = safeScrapeId(id);
  if (!safeId) return null;
  const dir = path.join(HISTORY_DIR, safeId);
  const entries = (await fs.readdir(dir, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const entry of entries) {
    try {
      const raw = await fs.readFile(path.join(dir, entry), "utf8");
      const parsed = JSON.parse(raw);
      if (parsed?.scrape?.id) return { ...parsed, file: entry };
    } catch {
      // Ignore broken history snapshots.
    }
  }
  return null;
}

function htmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function xmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function normalizeMediaFilePath(value) {
  return String(value ?? "").replace(/\\/g, "/").replace(/^\/+/, "").trim();
}

function normalizeSectionTitleForMatch(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function stableSectionId(value) {
  const normalized = normalizeSectionTitleForMatch(value || "document");
  if (!normalized) return "document";
  return `section-${createHash("sha1").update(normalized).digest("hex").slice(0, 12)}`;
}

function normalizeVisualDecisionInput(raw) {
  if (!raw || typeof raw !== "object") {
    return {
      media_file_path: "",
      media_file_paths: [],
      media_file_timecodes: {},
      duration_hint_sec: null,
      format_hint: ""
    };
  }
  const paths = Array.isArray(raw.media_file_paths)
    ? raw.media_file_paths.map(normalizeMediaFilePath).filter(Boolean)
    : normalizeMediaFilePath(raw.media_file_path)
      ? [normalizeMediaFilePath(raw.media_file_path)]
      : [];
  return {
    ...raw,
    media_file_path: paths[0] || "",
    media_file_paths: paths,
    media_file_timecodes: raw.media_file_timecodes && typeof raw.media_file_timecodes === "object" ? raw.media_file_timecodes : {},
    duration_hint_sec: raw.duration_hint_sec ?? null,
    format_hint: String(raw.format_hint || "").trim()
  };
}

function safeResolveMediaPathForRoot(mediaRoot, relativePath) {
  const clean = normalizeMediaFilePath(relativePath);
  if (!clean) return "";
  const base = path.resolve(mediaRoot || PAMPAM_ROOT);
  const target = path.resolve(base, clean);
  if (target === base) return "";
  if (!target.startsWith(`${base}${path.sep}`)) return "";
  return target;
}

function titleFromContent(content) {
  return String(content).split(/\r?\n/).find((line) => line.startsWith("# "))?.replace(/^#\s+/, "").trim() || "Untitled";
}

function sanitizeMediaTopicName(rawTitle) {
  const fallbackTopic = "Без темы";
  const value = String(rawTitle ?? "").trim();
  if (!value) return fallbackTopic;
  const replaced = value
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, " ")
    .replace(/\(\s*\d+\s*\)\s*$/g, " ")
    .replace(/\(\s*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");
  const normalized = replaced || fallbackTopic;
  const clipped = normalized.length > 96 ? normalized.slice(0, 96).trim() : normalized;
  if (!clipped) return fallbackTopic;
  const reserved = new Set(["CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"]);
  return reserved.has(clipped.toUpperCase()) ? `_${clipped}` : clipped;
}

function sanitizeFileName(value, fallback = "file") {
  const parsed = path.parse(String(value ?? "").trim());
  const ext = parsed.ext.replace(/[^.\p{L}\p{N}_-]/gu, "").slice(0, 16);
  const stem = (parsed.name || fallback)
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "")
    .slice(0, 140)
    .trim();
  return `${stem || fallback}${ext || ""}`;
}

function makeFileNameUnique(fileName) {
  const parsed = path.parse(fileName);
  const genericPatterns = [
    /^image/i,
    /^img/i,
    /^file/i,
    /^clipboard/i,
    /^photo/i,
    /^screenshot/i
  ];
  const isGeneric = genericPatterns.some((pat) => pat.test(parsed.name));
  if (isGeneric) {
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
    const suffix = Math.random().toString(36).slice(2, 8);
    return `${parsed.name}_${stamp}_${suffix}${parsed.ext}`;
  }
  return fileName;
}

function safeResolveMediaPath(relativePath) {
  const clean = String(relativePath ?? "").replace(/^[/\\]+/, "");
  if (!clean) return "";
  const root = path.resolve(PAMPAM_ROOT);
  const target = path.resolve(PAMPAM_ROOT, clean);
  if (target === root) return "";
  if (!target.startsWith(`${root}${path.sep}`)) return "";
  return target;
}

function shouldHideMediaFile(fileName) {
  const normalized = String(fileName ?? "").trim().toLowerCase();
  if (!normalized) return true;
  if (normalized.includes("newfile")) return true;
  return [".txt", ".xml", ".db", ".py", ".sqlite", ".sqlite-shm", ".sqlite-wal"].some((ext) => normalized.endsWith(ext));
}

function isImageFile(filePath) {
  return [".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(path.extname(filePath).toLowerCase());
}

function isPreviewableMediaFile(filePath) {
  return [".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp4", ".mov", ".webm"].includes(path.extname(filePath).toLowerCase());
}

async function ensureTopicDir(topic) {
  const safeTopic = sanitizeMediaTopicName(topic);
  const dir = path.join(PAMPAM_ROOT, safeTopic);
  await fs.mkdir(dir, { recursive: true });
  return { safeTopic, dir };
}

async function listMediaFiles(maxFiles = 800) {
  await fs.mkdir(PAMPAM_ROOT, { recursive: true });
  const ignoredRootFolders = new Set(["unsorted", "archive_projects", "graphics"]);
  const files = [];
  const stack = [""];
  while (stack.length && files.length < maxFiles) {
    const currentRel = stack.pop();
    const currentDir = currentRel ? path.join(PAMPAM_ROOT, currentRel) : PAMPAM_ROOT;
    const entries = await fs.readdir(currentDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      const relPath = currentRel ? path.join(currentRel, entry.name) : entry.name;
      if (entry.isDirectory()) {
        if (!currentRel && ignoredRootFolders.has(entry.name.trim().toLowerCase())) continue;
        stack.push(relPath);
        continue;
      }
      if (!entry.isFile() || shouldHideMediaFile(entry.name)) continue;
      const absolutePath = path.join(PAMPAM_ROOT, relPath);
      const stats = await fs.stat(absolutePath).catch(() => null);
      if (!stats?.isFile()) continue;
      const normalizedRel = relPath.split(path.sep).join("/");
      files.push({
        path: normalizedRel,
        name: entry.name,
        topic: normalizedRel.split("/")[0] || "",
        size: stats.size,
        updated_at: stats.mtime?.toISOString?.() ?? null,
        thumbnail: isImageFile(normalizedRel) ? `/api/media/raw?path=${encodeURIComponent(normalizedRel)}` : ""
      });
    }
  }
  return files.sort((a, b) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")));
}

async function pathExists(targetPath) {
  if (!targetPath) return false;
  return fs.access(targetPath).then(() => true).catch(() => false);
}

async function resolveFirstExisting(candidates) {
  for (const candidate of candidates.filter(Boolean)) {
    if (await pathExists(candidate)) return candidate;
  }
  return "";
}

async function resolveDownloaderTools() {
  const isWindows = process.platform === "win32";
  const ytDlp = await resolveFirstExisting([
    process.env.MEDIA_YTDLP_PATH,
    process.env.YTDLP_PATH,
    path.join(VBAUT_DOWNLOADER_DIR, "local", "bin", isWindows ? "yt-dlp.exe" : "yt-dlp"),
    path.join(VBAUT_DOWNLOADER_DIR, "3rdParty", "ytdlp", isWindows ? "yt-dlp_x86.exe" : "yt-dlp")
  ]);
  const ffmpeg = await resolveFirstExisting([
    process.env.FFMPEG_PATH,
    process.env.MEDIA_FFMPEG_PATH,
    path.join(VBAUT_DOWNLOADER_DIR, "local", "bin", isWindows ? "ffmpeg.exe" : "ffmpeg"),
    path.join(VBAUT_DOWNLOADER_DIR, "local", "ffmpeg", isWindows ? "ffmpeg.exe" : "ffmpeg"),
    path.join(VBAUT_DOWNLOADER_DIR, "3rdParty", "ffmpeg", "bin", isWindows ? "ffmpeg.exe" : "ffmpeg")
  ]);
  const galleryDl = await resolveFirstExisting([
    process.env.MEDIA_GALLERYDL_PATH,
    process.env.GALLERYDL_PATH,
    path.join(VBAUT_DOWNLOADER_DIR, "local", "bin", isWindows ? "gallery-dl.exe" : "gallery-dl")
  ]);
  return {
    yt_dlp_path: ytDlp,
    ffmpeg_path: ffmpeg,
    gallery_dl_path: galleryDl,
    available: Boolean(ytDlp || galleryDl)
  };
}

function normalizeHttpUrl(rawUrl) {
  const value = String(rawUrl ?? "").trim();
  if (!value) return "";
  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol)) return "";
    return parsed.toString();
  } catch {
    return "";
  }
}

function isXOrTwitter(urlStr) {
  try {
    const parsed = new URL(urlStr);
    const host = parsed.hostname.toLowerCase();
    return host === "x.com" || host === "twitter.com" || host.endsWith(".x.com") || host.endsWith(".twitter.com");
  } catch {
    return false;
  }
}

function makeJobId() {
  return `job_${Date.now().toString(36)}_${createHash("sha1").update(`${Date.now()}_${Math.random()}`).digest("hex").slice(0, 8)}`;
}

async function listImmediateFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const absolutePath = path.join(dir, entry.name);
    const stats = await fs.stat(absolutePath).catch(() => null);
    if (!stats?.isFile()) continue;
    files.push({ name: entry.name, size: stats.size, mtime: stats.mtimeMs });
  }
  return files;
}

async function listNewOutputFiles(topic, dir, beforeFiles) {
  const before = new Map(beforeFiles.map((file) => [file.name, `${file.size}:${file.mtime}`]));
  const after = await listImmediateFiles(dir);
  return after
    .filter((file) => before.get(file.name) !== `${file.size}:${file.mtime}`)
    .filter((file) => isPreviewableMediaFile(file.name))
    .sort((a, b) => b.mtime - a.mtime)
    .map((file) => {
      const relPath = path.join(topic, file.name).split(path.sep).join("/");
      return {
        path: relPath,
        name: file.name,
        topic,
        size: file.size,
        updated_at: new Date(file.mtime).toISOString(),
        thumbnail: isImageFile(relPath) ? `/api/media/raw?path=${encodeURIComponent(relPath)}` : ""
      };
    });
}

function trimMediaJobs() {
  const jobs = [...MEDIA_JOBS.values()].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  for (const job of jobs.slice(MEDIA_JOB_LIMIT)) MEDIA_JOBS.delete(job.id);
}

function updateJob(job, patch) {
  Object.assign(job, patch, { updated_at: new Date().toISOString() });
  MEDIA_JOBS.set(job.id, job);
  trimMediaJobs();
  return job;
}

function parseDownloadProgress(textChunk) {
  const textValue = String(textChunk ?? "");
  const percentMatch = textValue.match(/(\d{1,3}(?:\.\d+)?)%/);
  if (percentMatch) {
    const progress = Math.max(0, Math.min(100, Number(percentMatch[1])));
    if (Number.isFinite(progress)) return Math.round(progress);
  }
  return null;
}

function runCommand(job, command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      windowsHide: true
    });
    job.process = child;
    let output = "";
    const onData = (chunk) => {
      const textChunk = chunk.toString("utf8");
      output += textChunk;
      output = output.slice(-12000);
      const progress = parseDownloadProgress(textChunk);
      if (progress !== null) updateJob(job, { progress, log: output.slice(-2000) });
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      if (code === 0) {
        resolve(output);
      } else {
        const error = new Error(output.trim() || `Downloader exited with code ${code}`);
        error.code = code;
        reject(error);
      }
    });
  });
}

async function downloadDirectFile(job, url, topic, dir) {
  const response = await fetch(url, { redirect: "follow", headers: { "user-agent": "UContent/0.1 media downloader" } });
  if (!response.ok) throw new Error(`Direct download failed: HTTP ${response.status}`);
  const parsed = new URL(url);
  const baseName = sanitizeFileName(decodeURIComponent(path.basename(parsed.pathname || "")), "download");
  const ext = path.extname(baseName) || ".bin";
  const rawFileName = sanitizeFileName(`${path.parse(baseName).name || "download"}${ext}`, "download");
  const fileName = makeFileNameUnique(rawFileName);
  const target = path.join(dir, fileName);
  const body = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(target, body);
  const relPath = path.join(topic, fileName).split(path.sep).join("/");
  updateJob(job, { progress: 100 });
  return [{
    path: relPath,
    name: fileName,
    topic,
    size: body.length,
    updated_at: new Date().toISOString(),
    thumbnail: isImageFile(relPath) ? `/api/media/raw?path=${encodeURIComponent(relPath)}` : ""
  }];
}

function isDirectDownloadUrl(url) {
  try {
    const parsed = new URL(url);
    return /\.(mp4|m4v|mov|webm|mkv|mp3|m4a|wav|jpg|jpeg|png|webp|gif)(?:$|[?#])/i.test(parsed.pathname + parsed.search);
  } catch {
    return false;
  }
}

async function runYtDlpDownload(job, tools, url, dir) {
  if (!tools.yt_dlp_path) throw new Error("yt-dlp is not available");
  const outputTemplate = path.join(dir, "%(title).120B [%(id)s].%(ext)s");
  const args = [
    "--newline",
    "--no-mtime",
    "--windows-filenames",
    "--restrict-filenames",
    "--format",
    DEFAULT_YTDLP_FORMAT,
    "--merge-output-format",
    "mp4",
    "--output",
    outputTemplate,
    url
  ];
  if (tools.ffmpeg_path) {
    args.splice(args.length - 1, 0, "--ffmpeg-location", path.dirname(tools.ffmpeg_path));
  }
  await runCommand(job, tools.yt_dlp_path, args, { cwd: dir });
}

async function runGalleryDlDownload(job, tools, url, dir) {
  if (!tools.gallery_dl_path) throw new Error("gallery-dl is not available");
  await runCommand(job, tools.gallery_dl_path, ["-D", dir, url], { cwd: dir });
}

async function executeMediaDownload(job) {
  try {
    updateJob(job, { state: "running", progress: 0 });
    const { safeTopic, dir } = await ensureTopicDir(job.topic);
    job.topic = safeTopic;
    job.output_dir = dir;
    const before = await listImmediateFiles(dir);
    const tools = await resolveDownloaderTools();
    updateJob(job, { tools });
    if (isDirectDownloadUrl(job.url)) {
      const outputFiles = await downloadDirectFile(job, job.url, safeTopic, dir);
      updateJob(job, { state: "completed", progress: 100, output_files: outputFiles });
      return;
    }
    let downloadSucceeded = false;
    let ytDlpError = null;

    try {
      await runYtDlpDownload(job, tools, job.url, dir);
      const afterYt = await listNewOutputFiles(safeTopic, dir, before);
      if (afterYt.length > 0) {
        downloadSucceeded = true;
      } else {
        ytDlpError = new Error("yt-dlp completed but produced no output files");
      }
    } catch (error) {
      ytDlpError = error;
    }

    if (!downloadSucceeded && tools.gallery_dl_path) {
      const reason = ytDlpError ? ytDlpError.message : "no files produced";
      updateJob(job, { log: `${job.log || ""}\nyt-dlp failed or got no media (${reason}), trying gallery-dl fallback...`.slice(-2000) });
      try {
        await runGalleryDlDownload(job, tools, job.url, dir);
        downloadSucceeded = true;
      } catch (error) {
        throw new Error(ytDlpError ? `${ytDlpError.message} | gallery-dl: ${error.message}` : error.message);
      }
    } else if (!downloadSucceeded) {
      if (ytDlpError) throw ytDlpError;
      throw new Error("No media downloader tools succeeded");
    }

    const outputFiles = await listNewOutputFiles(safeTopic, dir, before);
    if (!outputFiles.length) throw new Error("Download finished, but no media output files were found");
    updateJob(job, { state: "completed", progress: 100, output_files: outputFiles });
  } catch (error) {
    updateJob(job, { state: "failed", error: error?.message || "Download failed" });
  } finally {
    delete job.process;
  }
}

async function handleMediaDownload(req, res) {
  const body = await readBody(req);
  const url = normalizeHttpUrl(body.url);
  if (!url) {
    json(res, 400, { error: "url must be http(s)" });
    return;
  }
  const topic = String(body.topic || "").trim();
  const job = {
    id: makeJobId(),
    url,
    topic,
    segment_id: String(body.segmentId || body.segment_id || "").trim(),
    state: "queued",
    progress: 0,
    output_files: [],
    error: "",
    log: "",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  MEDIA_JOBS.set(job.id, job);
  setTimeout(() => void executeMediaDownload(job), 0);
  json(res, 200, { job });
}

function handleMediaDownloadJob(reqUrl, res) {
  const id = decodeURIComponent(reqUrl.pathname.split("/").filter(Boolean)[2] || "");
  const job = MEDIA_JOBS.get(id);
  if (!job) {
    json(res, 404, { error: "job not found" });
    return;
  }
  json(res, 200, { job });
}

function segmentKind(text) {
  const trimmed = String(text ?? "").trim();
  if (/^https?:\/\/\S+$/i.test(trimmed) && !trimmed.includes("\n")) return "link";
  if (trimmed.startsWith("/")) return "direction";
  return trimmed ? "text" : "";
}

function shouldIgnoreContentLine(line) {
  return String(line ?? "").trim() === "Оформление видео";
}

function normalizeSegmentText(text) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeTextForMatch(text) {
  return normalizeSegmentText(text)
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeForMatch(text) {
  const normalized = normalizeTextForMatch(text);
  if (!normalized) return [];
  return normalized.split(" ").filter((token) => token.length > 1);
}

function jaccardSimilarity(tokensA, tokensB) {
  if (!tokensA.length || !tokensB.length) return 0;
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

function countTokenIntersection(tokensA, tokensB) {
  if (!tokensA.length || !tokensB.length) return 0;
  const left = new Set(tokensA);
  let count = 0;
  for (const token of new Set(tokensB)) {
    if (left.has(token)) count += 1;
  }
  return count;
}

function hasMeaningfulTokenOverlap(tokensA = [], tokensB = []) {
  if (!Array.isArray(tokensA) || !Array.isArray(tokensB) || !tokensA.length || !tokensB.length) return false;
  const right = new Set(tokensB);
  let overlap = 0;
  let significantOverlap = 0;
  for (const token of new Set(tokensA)) {
    if (!right.has(token)) continue;
    overlap += 1;
    if (String(token).length >= 6) significantOverlap += 1;
  }
  return overlap >= 2 || significantOverlap >= 1;
}

function segmentMatchKey(segment, includeTopic = true) {
  const topic = includeTopic ? normalizeSegmentText(segment.topic) : "";
  return [topic, segment.kind, normalizeSegmentText(segment.text)].join("\u001f");
}

function sectionMatchKey(segment) {
  return normalizeTextForMatch(segment?.topic || "");
}

function segmentIdSeed(segment, index) {
  const hash = createHash("sha1")
    .update([segment.kind, segment.topic, segment.text].join("\u001f"))
    .digest("hex")
    .slice(0, 12);
  return `seg_${hash}_${index + 1}`;
}

function uniqueSegmentId(seed, usedIds) {
  let id = seed;
  let suffix = 2;
  while (usedIds.has(id)) {
    id = `${seed}_${suffix}`;
    suffix += 1;
  }
  usedIds.add(id);
  return id;
}

function parseContentSegments(content) {
  const segments = [];
  let topic = "";
  let current = null;

  function flush() {
    if (!current) return;
    const text = current.lines.join("\n").trim();
    const kind = segmentKind(text);
    if (text && kind) {
      segments.push({ start: current.start, end: current.end, topic, kind, text });
    }
    current = null;
  }

  String(content ?? "").split(/\r?\n/).forEach((line, index) => {
    const trimmed = String(line ?? "").trim();
    if (trimmed.startsWith("### ")) {
      flush();
      topic = trimmed.replace(/^###\s+/, "").trim();
      return;
    }
    if (!trimmed || trimmed.startsWith("# ") || shouldIgnoreContentLine(trimmed)) {
      flush();
      return;
    }
    if (!current) current = { start: index, lines: [] };
    current.end = index;
    current.lines.push(line);
  });
  flush();
  return segments;
}

function buildSegmentIndexes(previousSegments) {
  const byTopic = new Map();
  const byText = new Map();
  const meta = [];
  for (const [index, segment] of (previousSegments || []).entries()) {
    if (!segment?.id) continue;
    const topicKey = segmentMatchKey(segment, true);
    const textKey = segmentMatchKey(segment, false);
    if (!byTopic.has(topicKey)) byTopic.set(topicKey, []);
    if (!byText.has(textKey)) byText.set(textKey, []);
    byTopic.get(topicKey).push(segment);
    byText.get(textKey).push(segment);
    meta.push({
      segment,
      index,
      normalized: normalizeTextForMatch(segment.text),
      tokens: tokenizeForMatch(segment.text),
      sectionKey: sectionMatchKey(segment)
    });
  }
  const bySection = new Map();
  for (const item of meta) {
    if (!item.sectionKey) continue;
    if (!bySection.has(item.sectionKey)) bySection.set(item.sectionKey, []);
    bySection.get(item.sectionKey).push(item);
  }
  return { byTopic, byText, bySection, meta };
}

function takeFirstUnused(queue, usedIds) {
  if (!queue) return null;
  while (queue.length) {
    const candidate = queue.shift();
    if (candidate?.id && !usedIds.has(candidate.id)) return candidate;
  }
  return null;
}

function findBestFuzzySegment({
  segment,
  normalized,
  tokens,
  sectionKey,
  candidates,
  usedIds,
  minScore,
  targetIndex
}) {
  if (!normalized || normalized.length < 35 || tokens.length < 4) return null;
  let best = null;
  let bestScore = 0;
  for (const item of candidates || []) {
    const candidate = item.segment;
    if (!candidate?.id || usedIds.has(candidate.id)) continue;
    if (segment.kind && candidate.kind && segment.kind !== candidate.kind) continue;
    if (!item.tokens.length) continue;
    if (sectionKey && item.sectionKey && sectionKey !== item.sectionKey) continue;
    const overlap = countTokenIntersection(tokens, item.tokens);
    if (overlap < 3) continue;
    const similarity = jaccardSimilarity(tokens, item.tokens);
    if (similarity <= 0) continue;
    const sectionBonus = sectionKey && item.sectionKey && sectionKey === item.sectionKey ? 0.12 : 0;
    const kindBonus = segment.kind === candidate.kind ? 0.08 : 0;
    const lengthRatio = Math.min(normalized.length, item.normalized.length) / Math.max(normalized.length, item.normalized.length);
    const lengthBonus = Number.isFinite(lengthRatio) ? lengthRatio * 0.08 : 0;
    const indexPenalty = Math.min(0.24, Math.abs(Number(item.index || 0) - Number(targetIndex || 0)) * 0.02);
    const score = similarity + sectionBonus + kindBonus + lengthBonus - indexPenalty;
    if (score > bestScore) {
      best = item;
      bestScore = score;
    }
  }
  return best && bestScore >= minScore ? { ...best, score: Number(bestScore.toFixed(4)) } : null;
}

function pickSectionSlotFallback({ segment, sectionKey, newIndex, newMeta, oldBySection, usedIds }) {
  if (!sectionKey) return null;
  const newSectionItems = newMeta.filter((item) => item.sectionKey === sectionKey && item.segment.kind === segment.kind);
  const oldSectionItems = (oldBySection.get(sectionKey) || []).filter((item) => item.segment.kind === segment.kind);
  if (!newSectionItems.length || !oldSectionItems.length) return null;
  if (newSectionItems.length !== oldSectionItems.length) return null;
  const slotIndex = newSectionItems.findIndex((item) => item.index === newIndex);
  if (slotIndex < 0) return null;
  const candidate = oldSectionItems[slotIndex];
  if (!candidate?.segment?.id || usedIds.has(candidate.segment.id)) return null;
  const newItem = newSectionItems[slotIndex];
  if (!hasMeaningfulTokenOverlap(candidate.tokens, newItem.tokens)) return null;
  return candidate;
}

function cloneSegmentState(source) {
  const mediaItems = normalizeMediaItems(source);
  return {
    media: mediaItems[0] || null,
    media_items: mediaItems,
    is_done: Boolean(source?.is_done)
  };
}

function normalizeMediaItem(raw) {
  if (!raw || typeof raw !== "object") return null;
  const item = {
    url: String(raw.url || "").trim(),
    path: String(raw.path || "").trim(),
    thumbnail: String(raw.thumbnail || "").trim(),
    timecode: String(raw.timecode || raw.start_timecode || raw.media_start_timecode || "").trim()
  };
  return item.url || item.path || item.thumbnail ? item : null;
}

function normalizeMediaItems(segmentOrItems) {
  const rawItems = Array.isArray(segmentOrItems)
    ? segmentOrItems
    : Array.isArray(segmentOrItems?.media_items)
      ? segmentOrItems.media_items
      : [];
  const items = rawItems.map(normalizeMediaItem).filter(Boolean);
  const legacy = Array.isArray(segmentOrItems) ? null : normalizeMediaItem(segmentOrItems?.media);
  if (legacy && !items.some((item) => item.url === legacy.url && item.path === legacy.path && item.thumbnail === legacy.thumbnail)) {
    items.unshift(legacy);
  }
  return items.slice(0, 50);
}

function assignSegmentIds(content, previousSegments = []) {
  const parsed = parseContentSegments(content);
  const indexes = buildSegmentIndexes(previousSegments);
  const usedIds = new Set();
  let reused = 0;
  let created = 0;
  let changed = 0;
  let moved = 0;
  const syncDebug = [];
  const newMeta = parsed.map((segment, index) => ({
    segment,
    index,
    normalized: normalizeTextForMatch(segment.text),
    tokens: tokenizeForMatch(segment.text),
    sectionKey: sectionMatchKey(segment)
  }));
  const segments = parsed.map((segment, index) => {
    const exactTopic = takeFirstUnused(indexes.byTopic.get(segmentMatchKey(segment, true)), usedIds);
    const exactText = exactTopic || takeFirstUnused(indexes.byText.get(segmentMatchKey(segment, false)), usedIds);
    const sectionKey = sectionMatchKey(segment);
    const normalized = normalizeTextForMatch(segment.text);
    const tokens = tokenizeForMatch(segment.text);
    let matched = exactText;
    let status = exactTopic ? "same" : exactText ? "moved" : "";
    let matchMethod = exactTopic ? "exact_topic" : exactText ? "exact_text" : "";
    let matchScore = exactTopic || exactText ? 1 : null;

    if (!matched) {
      const sectionFuzzy = findBestFuzzySegment({
        segment,
        normalized,
        tokens,
        sectionKey,
        candidates: indexes.bySection.get(sectionKey) || [],
        usedIds,
        minScore: 0.62,
        targetIndex: index
      });
      const globalFuzzy = sectionFuzzy || findBestFuzzySegment({
        segment,
        normalized,
        tokens,
        sectionKey,
        candidates: indexes.meta,
        usedIds,
        minScore: 0.78,
        targetIndex: index
      });
      if (globalFuzzy) {
        matched = globalFuzzy.segment;
        status = "changed";
        matchMethod = sectionFuzzy ? "fuzzy_section" : "fuzzy_global";
        matchScore = globalFuzzy.score ?? null;
      }
    }

    if (!matched) {
      const slotFallback = pickSectionSlotFallback({
        segment,
        sectionKey,
        newIndex: index,
        newMeta,
        oldBySection: indexes.bySection,
        usedIds
      });
      if (slotFallback) {
        matched = slotFallback.segment;
        status = "changed";
        matchMethod = "slot_fallback";
        matchScore = null;
      }
    }

    if (matched) {
      usedIds.add(matched.id);
      reused += 1;
      if (status === "changed") changed += 1;
      if (status === "moved") moved += 1;
      syncDebug.push({
        id: matched.id,
        new_index: index,
        old_index: indexes.meta.find((item) => item.segment.id === matched.id)?.index ?? null,
        status,
        match_method: matchMethod,
        match_score: matchScore,
        topic: segment.topic || "",
        text: segment.text.slice(0, 160)
      });
      return {
        ...segment,
        id: matched.id,
        type: segment.kind,
        ...cloneSegmentState(matched),
        status,
        sync_debug: {
          matched_from: matched.id,
          match_method: matchMethod,
          match_score: matchScore
        }
      };
    }
    created += 1;
    syncDebug.push({
      id: null,
      new_index: index,
      old_index: null,
      status: "new",
      match_method: "new",
      match_score: null,
      topic: segment.topic || "",
      text: segment.text.slice(0, 160)
    });
    return {
      ...segment,
      id: uniqueSegmentId(segmentIdSeed(segment, index), usedIds),
      type: segment.kind,
      media: null,
      media_items: [],
      is_done: false,
      status: "new",
      sync_debug: {
        matched_from: "",
        match_method: "new",
        match_score: null
      }
    };
  });
  const previousCount = Array.isArray(previousSegments) ? previousSegments.length : 0;
  return {
    segments,
    report: {
      total: segments.length,
      reused,
      created,
      changed,
      moved,
      same: Math.max(0, reused - changed - moved),
      removed: Math.max(0, previousCount - reused),
      debug: syncDebug
    }
  };
}

function buildXmlForScrape(scrape) {
  const title = titleFromContent(scrape?.content ?? "");
  const segments = Array.isArray(scrape?.segments) && scrape.segments.length
    ? scrape.segments
    : assignSegmentIds(scrape?.content ?? "").segments;
  const markers = segments
    .map((segment, index) => {
      const start = index * 150;
      const end = start + 150;
      const markerName = segment.text;
      return [
        "    <marker>",
        "      <comment></comment>",
        `      <name>${xmlEscape(markerName)}</name>`,
        `      <in>${start}</in>`,
        `      <out>${end}</out>`,
        "      <pproColor>MarkerColor.1</pproColor>",
        `      <comment>${xmlEscape(segment.text)}</comment>`,
        "    </marker>"
      ].join("\n");
    })
    .join("\n");

  const duration = Math.max(150, segments.length * 150);

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<!DOCTYPE xmeml>",
    '<xmeml version="4">',
    '  <sequence id="sequence-1">',
    "    <uuid>00000000-0000-0000-0000-000000000000</uuid>",
    `    <name>${xmlEscape(title)}</name>`,
    `    <duration>${duration}</duration>`,
    "    <rate>",
    "      <timebase>50</timebase>",
    "      <ntsc>FALSE</ntsc>",
    "    </rate>",
    "    <media>",
    "      <video>",
    "        <format>",
    "          <samplecharacteristics>",
    "            <rate>",
    "              <timebase>50</timebase>",
    "              <ntsc>FALSE</ntsc>",
    "            </rate>",
    "            <width>1920</width>",
    "            <height>1080</height>",
    "            <anamorphic>FALSE</anamorphic>",
    "            <pixelaspectratio>square</pixelaspectratio>",
    "            <fielddominance>none</fielddominance>",
    "            <colordepth>24</colordepth>",
    "          </samplecharacteristics>",
    "        </format>",
    "        <track>",
    "          <enabled>TRUE</enabled>",
    "          <locked>FALSE</locked>",
    "        </track>",
    "      </video>",
    "      <audio>",
    "        <numOutputChannels>2</numOutputChannels>",
    "        <format>",
    "          <samplecharacteristics>",
    "            <depth>16</depth>",
    "            <samplerate>48000</samplerate>",
    "          </samplecharacteristics>",
    "        </format>",
    "        <outputs>",
    "          <group>",
    "            <index>1</index>",
    "            <numchannels>1</numchannels>",
    "            <downmix>0</downmix>",
    "            <channel>",
    "              <index>1</index>",
    "            </channel>",
    "          </group>",
    "          <group>",
    "            <index>2</index>",
    "            <numchannels>1</numchannels>",
    "            <downmix>0</downmix>",
    "            <channel>",
    "              <index>2</index>",
    "            </channel>",
    "          </group>",
    "        </outputs>",
    "        <track>",
    "          <enabled>TRUE</enabled>",
    "          <locked>FALSE</locked>",
    "          <outputchannelindex>1</outputchannelindex>",
    "        </track>",
    "        <track>",
    "          <enabled>TRUE</enabled>",
    "          <locked>FALSE</locked>",
    "          <outputchannelindex>2</outputchannelindex>",
    "        </track>",
    "      </audio>",
    "    </media>",
    markers,
    "    <timecode>",
    "      <rate>",
    "        <timebase>50</timebase>",
    "        <ntsc>FALSE</ntsc>",
    "      </rate>",
    "      <string>00:00:00:00</string>",
    "      <frame>0</frame>",
    "      <displayformat>NDF</displayformat>",
    "    </timecode>",
    "  </sequence>",
    "</xmeml>"
  ].filter(Boolean).join("\n");
}

async function buildVbautXmlForScrape(scrape) {
  const segments = Array.isArray(scrape?.segments) && scrape.segments.length
    ? scrape.segments
    : assignSegmentIds(scrape?.content ?? "").segments;
  const vbautSegments = [];
  const decisionsBySegment = new Map();

  for (const segment of segments) {
    const mediaItems = normalizeMediaItems(segment);
    const mediaPaths = [];
    const mediaTimecodes = [];
    for (const item of mediaItems) {
      const mediaPath = normalizeMediaFilePath(item.path);
      if (!mediaPath) continue;
      const absolutePath = safeResolveMediaPathForRoot(PAMPAM_ROOT, mediaPath);
      if (!absolutePath) continue;
      const stats = await fs.stat(absolutePath).catch(() => null);
      if (!stats?.isFile()) continue;
      mediaPaths.push(mediaPath);
      mediaTimecodes.push(String(item.timecode || "").trim());
    }
    const segmentId = String(segment.id || "").trim();
    if (!segmentId) continue;
    vbautSegments.push({
      segment_id: segmentId,
      section_id: stableSectionId(segment.topic || "document"),
      section_title: String(segment.topic || titleFromContent(scrape?.content ?? "") || "Document").trim(),
      text_quote: String(segment.text || "").trim(),
      block_type: "segment",
      is_done: Boolean(segment.is_done)
    });
    decisionsBySegment.set(segmentId, {
      visual: {
        media_file_path: mediaPaths[0] || "",
        media_file_paths: mediaPaths,
        media_file_timecodes_list: mediaTimecodes,
        duration_hint_sec: null,
        format_hint: "",
        media_file_timecodes: Object.fromEntries(
          mediaPaths.map((mediaPath, index) => [mediaPath, mediaTimecodes[index] || ""]).filter((entry) => entry[1])
        )
      }
    });
  }

  const tools = await resolveDownloaderTools();
  const ffmpegLocation = tools.ffmpeg_path ? path.dirname(tools.ffmpeg_path) : "";
  const { buildXmlExportPayload } = createXmlExportUtils({
    execFileAsync,
    downloaderTools: { ffmpegLocation },
    getMediaDir: () => PAMPAM_ROOT,
    normalizeMediaFilePath,
    normalizeSectionTitleForMatch,
    normalizeVisualDecisionInput,
    safeResolveMediaPath: safeResolveMediaPathForRoot
  });

  return buildXmlExportPayload({
    document: {
      id: scrape?.id || "ucontent",
      title: scrape?.title || titleFromContent(scrape?.content ?? "")
    },
    segments: vbautSegments,
    decisionsBySegment,
    timelineAlignment: null,
    mediaDir: PAMPAM_ROOT,
    mediaPathRootOverride: null,
    fps: 50,
    defaultDurationSec: 5,
    sectionId: "",
    sectionTitle: ""
  });
}

function parseMeta(html, property) {
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${property}["'][^>]*>`, "i"),
    new RegExp(`<meta[^>]+name=["']${property}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${property}["'][^>]*>`, "i")
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return htmlEscape(match[1]);
  }
  return "";
}

async function handlePreview(reqUrl, res) {
  const target = String(reqUrl.searchParams.get("url") ?? "").trim();
  if (!/^https?:\/\//i.test(target)) {
    json(res, 400, { error: "url is required" });
    return;
  }
  try {
    const response = await fetch(target, {
      redirect: "follow",
      headers: {
        "user-agent": "UContent/0.1 link preview"
      }
    });
    const html = await response.text();
    const title =
      parseMeta(html, "og:title") ||
      htmlEscape(html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] ?? "");
    json(res, 200, {
      title,
      description: parseMeta(html, "og:description") || parseMeta(html, "description"),
      image: parseMeta(html, "og:image"),
      siteName: parseMeta(html, "og:site_name")
    });
  } catch (error) {
    json(res, 502, { error: error?.message ?? "preview failed" });
  }
}

async function handleMediaLibrary(reqUrl, res) {
  const topic = String(reqUrl.searchParams.get("topic") || "").trim();
  const { safeTopic, dir } = await ensureTopicDir(topic);
  const files = await listMediaFiles();
  json(res, 200, {
    root: PAMPAM_ROOT,
    topic: safeTopic,
    topic_dir: dir,
    topic_files: files.filter((file) => file.topic.toLowerCase() === safeTopic.toLowerCase()),
    files
  });
}

async function handleMediaUpload(req, res) {
  const body = await readBody(req);
  const topic = String(body.topic || "").trim();
  const rawFileName = sanitizeFileName(body.fileName, "upload");
  const fileName = makeFileNameUnique(rawFileName);
  const dataBase64 = String(body.dataBase64 || "");
  if (!dataBase64) {
    json(res, 400, { error: "dataBase64 is required" });
    return;
  }
  const { safeTopic, dir } = await ensureTopicDir(topic);
  const target = path.join(dir, fileName);
  await fs.writeFile(target, Buffer.from(dataBase64, "base64"));
  const relPath = path.join(safeTopic, fileName).split(path.sep).join("/");
  const stats = await fs.stat(target).catch(() => null);
  json(res, 200, {
    file: {
      path: relPath,
      name: fileName,
      topic: safeTopic,
      size: stats?.size ?? 0,
      updated_at: stats?.mtime?.toISOString?.() ?? null,
      thumbnail: isImageFile(relPath) ? `/api/media/raw?path=${encodeURIComponent(relPath)}` : ""
    }
  });
}

async function handleCheckGraphics(reqUrl, res) {
  const fileName = sanitizeFileName(reqUrl.searchParams.get("name") || "", "file");
  if (!fileName || fileName === "file") {
    json(res, 200, { exists: false });
    return;
  }
  const target = path.join(PAMPAM_ROOT, "graphics", fileName);
  try {
    const stats = await fs.stat(target);
    const relPath = `graphics/${fileName}`;
    json(res, 200, {
      exists: true,
      file: {
        path: relPath,
        name: fileName,
        topic: "graphics",
        size: stats.size,
        updated_at: stats.mtime.toISOString(),
        thumbnail: isImageFile(relPath) ? `/api/media/raw?path=${encodeURIComponent(relPath)}` : ""
      }
    });
  } catch {
    json(res, 200, { exists: false });
  }
}

async function handleMediaRaw(reqUrl, res) {
  const relPath = String(reqUrl.searchParams.get("path") || "");
  const target = safeResolveMediaPath(relPath);
  if (!target) {
    text(res, 403, "Forbidden");
    return;
  }
  try {
    const body = await fs.readFile(target);
    const contentType = MIME_TYPES.get(path.extname(target).toLowerCase()) || "application/octet-stream";
    res.writeHead(200, { "content-type": contentType, "cache-control": "no-store" });
    res.end(body);
  } catch {
    text(res, 404, "Not found");
  }
}

async function serveStatic(reqUrl, res) {
  const pathname = reqUrl.pathname === "/" ? "/script-text" : reqUrl.pathname;
  const fileName = pathname === "/script-text" ? "script-text.html" : pathname.replace(/^\/+/, "");
  const targetPath = path.resolve(PUBLIC_DIR, fileName);
  if (!targetPath.startsWith(PUBLIC_DIR)) {
    text(res, 403, "Forbidden");
    return;
  }
  try {
    const body = await fs.readFile(targetPath);
    const contentType = MIME_TYPES.get(path.extname(targetPath).toLowerCase()) || "application/octet-stream";
    res.writeHead(200, { "content-type": contentType });
    res.end(body);
  } catch {
    text(res, 404, "Not found");
  }
}

async function handleRequest(req, res) {
  const reqUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  try {
    if (req.method === "GET" && reqUrl.pathname === "/api/scrapes") {
      json(res, 200, { scrapes: await listScrapes() });
      return;
    }
    if (req.method === "GET" && reqUrl.pathname.startsWith("/api/scrapes/")) {
      const parts = reqUrl.pathname.split("/").filter(Boolean);
      const id = decodeURIComponent(parts[2] || "");
      if (parts[3] === "export.xml") {
        const scrape = await readScrape(id);
        const xmlPayload = await buildVbautXmlForScrape(scrape);
        const tools = await resolveDownloaderTools();
        const ffmpegLocation = tools.ffmpeg_path ? path.dirname(tools.ffmpeg_path) : "";
        const { buildContentDisposition } = createXmlExportUtils({
          execFileAsync,
          downloaderTools: { ffmpegLocation },
          getMediaDir: () => PAMPAM_ROOT,
          normalizeMediaFilePath,
          normalizeSectionTitleForMatch,
          normalizeVisualDecisionInput,
          safeResolveMediaPath: safeResolveMediaPathForRoot
        });
        const fileName = `${scrape.id}.xml`;
        res.writeHead(200, {
          "content-type": "application/xml; charset=utf-8",
          "content-disposition": buildContentDisposition(fileName),
          "cache-control": "no-store"
        });
        res.end(xmlPayload?.clipCount > 0 ? xmlPayload.xml : buildXmlForScrape(scrape));
        return;
      }
      json(res, 200, { scrape: await readScrape(id) });
      return;
    }
    if (req.method === "POST" && reqUrl.pathname.startsWith("/api/scrapes/")) {
      const parts = reqUrl.pathname.split("/").filter(Boolean);
      const id = decodeURIComponent(parts[2] || "");
      if (parts[3] === "refresh") {
        const existing = await readScrape(id);
        const url = normalizeNotionUrl(existing.url);
        if (!url) {
          json(res, 400, { error: "Saved scrape has no valid Notion URL" });
          return;
        }
        const progress = [];
        const content = await scrapeNotionPage(url, (message) => {
          progress.push(String(message ?? ""));
          console.log(`[notion-refresh] ${message}`);
        });
        const snapshot = await snapshotScrape(existing, "refresh");
        const segmentState = assignSegmentIds(content, existing.segments || []);
        const updated = {
          ...existing,
          title: titleFromContent(content),
          content,
          segments: segmentState.segments,
          segment_report: segmentState.report,
          last_snapshot: snapshot ? { id: snapshot.id, reason: snapshot.reason, created_at: snapshot.created_at, file: snapshot.file } : null,
          updated_at: new Date().toISOString()
        };
        await writeScrape(updated);
        json(res, 200, { scrape: updated, progress, report: segmentState.report });
        return;
      }
      if (parts[3] === "send-to-tg") {
        try {
          const result = await triggerWebBroadcast(id);
          json(res, 200, result);
        } catch (error) {
          json(res, 500, { error: error.message });
        }
        return;
      }
      if (parts[3] === "restore-latest") {
        const existing = await readScrape(id);
        const snapshot = await latestScrapeSnapshot(existing.id);
        if (!snapshot?.scrape) {
          json(res, 404, { error: "No refresh snapshot found" });
          return;
        }
        await snapshotScrape(existing, "restore");
        const restored = {
          ...snapshot.scrape,
          restored_from: {
            id: snapshot.id,
            reason: snapshot.reason,
            created_at: snapshot.created_at,
            file: snapshot.file
          },
          updated_at: new Date().toISOString()
        };
        await writeScrape(restored);
        json(res, 200, { scrape: restored, restored_from: restored.restored_from });
        return;
      }
      text(res, 404, "Not found");
      return;
    }
    if (req.method === "PATCH" && reqUrl.pathname.startsWith("/api/scrapes/")) {
      const parts = reqUrl.pathname.split("/").filter(Boolean);
      const id = decodeURIComponent(parts[2] || "");
      const segmentId = decodeURIComponent(parts[4] || "");
      if (parts[3] !== "segments" || !segmentId) {
        text(res, 404, "Not found");
        return;
      }
      const existing = await readScrape(id);
      const body = await readBody(req);
      const segments = Array.isArray(existing.segments) ? existing.segments : assignSegmentIds(existing.content || "").segments;
      const index = segments.findIndex((segment) => segment.id === segmentId);
      if (index < 0) {
        json(res, 404, { error: "segment not found" });
        return;
      }
      const current = segments[index];
      let mediaItems = normalizeMediaItems(current);
      if (Array.isArray(body.media_items)) {
        mediaItems = normalizeMediaItems(body.media_items);
      } else if (body.media === null) {
        mediaItems = [];
      } else if (body.media !== undefined) {
        mediaItems = normalizeMediaItems([body.media]);
      }
      if (body.add_media !== undefined) {
        const nextItem = normalizeMediaItem(body.add_media);
        if (nextItem) mediaItems = [...mediaItems, nextItem].slice(0, 50);
      }
      if (Number.isInteger(body.update_media_index) && body.media_item && typeof body.media_item === "object") {
        const nextItem = normalizeMediaItem(body.media_item);
        if (nextItem) {
          mediaItems = mediaItems.map((item, itemIndex) => itemIndex === body.update_media_index ? nextItem : item);
        }
      }
      if (Number.isInteger(body.remove_media_index)) {
        mediaItems = mediaItems.filter((_, itemIndex) => itemIndex !== body.remove_media_index);
      }
      segments[index] = {
        ...current,
        type: String(body.type || current.type || current.kind || "text").trim(),
        is_done: typeof body.is_done === "boolean" ? body.is_done : Boolean(current.is_done),
        media: mediaItems[0] || null,
        media_items: mediaItems,
        updated_at: new Date().toISOString()
      };
      const updated = {
        ...existing,
        segments,
        updated_at: new Date().toISOString()
      };
      await fs.writeFile(path.join(DATA_DIR, `${existing.id}.json`), JSON.stringify(updated, null, 2), "utf8");
      await fs.writeFile(path.join(DATA_DIR, "latest.json"), JSON.stringify(updated, null, 2), "utf8");
      json(res, 200, { scrape: updated, segment: segments[index] });
      return;
    }
    if (req.method === "PUT" && reqUrl.pathname.startsWith("/api/scrapes/")) {
      const id = decodeURIComponent(reqUrl.pathname.split("/").filter(Boolean)[2] || "");
      const existing = await readScrape(id);
      const body = await readBody(req);
      const content = String(body.content ?? "");
      if (!content.trim()) {
        json(res, 400, { error: "content is required" });
        return;
      }
      const segmentState = assignSegmentIds(content, existing.segments || []);
      const updated = {
        ...existing,
        title: titleFromContent(content),
        content,
        segments: segmentState.segments,
        segment_report: segmentState.report,
        updated_at: new Date().toISOString()
      };
      await fs.writeFile(path.join(DATA_DIR, `${existing.id}.json`), JSON.stringify(updated, null, 2), "utf8");
      await fs.writeFile(path.join(DATA_DIR, `${existing.id}.md`), content, "utf8");
      await fs.writeFile(path.join(DATA_DIR, "latest.json"), JSON.stringify(updated, null, 2), "utf8");
      json(res, 200, { scrape: updated });
      return;
    }
    if (req.method === "GET" && reqUrl.pathname === "/api/latest") {
      json(res, 200, { scrape: await readScrape("") });
      return;
    }
    if (req.method === "GET" && reqUrl.pathname === "/api/link-preview") {
      await handlePreview(reqUrl, res);
      return;
    }
    if (req.method === "GET" && reqUrl.pathname === "/api/media") {
      await handleMediaLibrary(reqUrl, res);
      return;
    }
    if (req.method === "POST" && reqUrl.pathname === "/api/media-download") {
      await handleMediaDownload(req, res);
      return;
    }
    if (req.method === "GET" && reqUrl.pathname.startsWith("/api/media-download/")) {
      handleMediaDownloadJob(reqUrl, res);
      return;
    }
    if (req.method === "GET" && reqUrl.pathname === "/api/media/raw") {
      await handleMediaRaw(reqUrl, res);
      return;
    }
    if (req.method === "GET" && reqUrl.pathname === "/api/media/check-graphics") {
      await handleCheckGraphics(reqUrl, res);
      return;
    }
    if (req.method === "POST" && reqUrl.pathname === "/api/media/upload") {
      await handleMediaUpload(req, res);
      return;
    }
    if (req.method === "POST" && reqUrl.pathname === "/api/scrape") {
      const body = await readBody(req);
      const url = normalizeNotionUrl(body.url);
      if (!url) {
        json(res, 400, { error: "Valid Notion URL is required" });
        return;
      }
      const progress = [];
      const content = await scrapeNotionPage(url, (message) => {
        progress.push(String(message ?? ""));
        console.log(`[notion] ${message}`);
      });
      const saved = await saveScrape({ id: scrapeIdFromUrl(url), url, content });
      json(res, 200, { scrape: saved, progress });
      return;
    }
    if (req.method === "GET" || req.method === "HEAD") {
      await serveStatic(reqUrl, res);
      return;
    }
    text(res, 405, "Method not allowed");
  } catch (error) {
    json(res, 500, { error: error?.message ?? "Internal error" });
  }
}

const server = createServer((req, res) => {
  void handleRequest(req, res);
});

server.on("error", (error) => {
  if (error?.code === "EADDRINUSE") {
    console.error(`UContent port ${PORT} is already in use.`);
    console.error(`Open http://localhost:${PORT}/script-text if it is already running, or start another port:`);
    console.error(`  $env:UCONTENT_PORT=5198; npm run dev`);
    process.exit(1);
  }
  throw error;
});

server.listen(PORT, () => {
  console.log(`UContent: http://localhost:${PORT}/script-text`);
  startTelegramBot({
    PORT,
    readScrape,
    writeScrape,
    executeMediaDownload,
    PAMPAM_ROOT,
    DATA_DIR,
    sanitizeMediaTopicName,
    ensureTopicDir,
    resolveDownloaderTools,
    spawn
  }).catch((err) => {
    console.error("Failed to start Telegram Bot:", err);
  });
});
