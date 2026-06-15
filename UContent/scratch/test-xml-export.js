import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createXmlExportUtils } from "../../VBAUT/backend/src/services/xml-export.js";

const execFileAsync = promisify(execFile);
const PAMPAM_ROOT = "C:\\Users\\Nemifist\\YandexDisk\\PAMPAM";

function normalizeMediaFilePath(value) {
  return String(value ?? "").replace(/\\/g, "/").replace(/^\/+/, "").trim();
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

function normalizeMediaItems(segment) {
  const list = [];
  if (segment.media && (segment.media.path || segment.media.url)) {
    list.push(segment.media);
  }
  if (Array.isArray(segment.media_items)) {
    segment.media_items.forEach((item) => {
      if (item && (item.path || item.url) && !list.some((existing) => existing.path === item.path)) {
        list.push(item);
      }
    });
  }
  return list;
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

function normalizeSectionTitleForMatch(value) {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function stableSectionId(value) {
  return "section-123456";
}

async function run() {
  const latestJsonPath = "c:\\tgbotapi\\UContent\\data\\scrapes\\latest.json";
  const raw = await fs.readFile(latestJsonPath, "utf8");
  const scrape = JSON.parse(raw);
  
  const segments = scrape.segments || [];
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
      section_title: String(segment.topic || "Document").trim(),
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

  const { buildXmlExportPayload } = createXmlExportUtils({
    execFileAsync,
    downloaderTools: { ffmpegLocation: "" },
    getMediaDir: () => PAMPAM_ROOT,
    normalizeMediaFilePath,
    normalizeSectionTitleForMatch,
    normalizeVisualDecisionInput,
    safeResolveMediaPath: safeResolveMediaPathForRoot
  });

  const payload = await buildXmlExportPayload({
    document: {
      id: scrape.id,
      title: scrape.title
    },
    segments: vbautSegments,
    decisionsBySegment,
    timelineAlignment: null,
    timelineAudioAlignment: null
  });

  console.log("Clip Count:", payload.clipCount);
  const matches = payload.xml.match(/<pathurl>.*?<\/pathurl>/g);
  console.log("Path URLs in XML:", matches);
}

run().catch(console.error);
