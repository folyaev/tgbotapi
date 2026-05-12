import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

function stableObject(value) {
  if (Array.isArray(value)) {
    return value.map((item) => stableObject(item));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.keys(value)
    .sort()
    .reduce((acc, key) => {
      acc[key] = stableObject(value[key]);
      return acc;
    }, {});
}

function hashPayload(value) {
  return createHash("sha1").update(JSON.stringify(stableObject(value))).digest("hex");
}

function normalizeRelativeMediaPath(value) {
  return String(value ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
}

function normalizeBlockType(value) {
  return String(value ?? "").trim().toLowerCase();
}

export function createDocumentContextHashUtils(deps = {}) {
  const {
    getMediaDir,
    normalizeVisualDecisionInput,
    sanitizeMediaTopicName
  } = deps;

  function getSectionThemeName(segment) {
    if (typeof sanitizeMediaTopicName !== "function") return "";
    const themeName = sanitizeMediaTopicName(String(segment?.section_title ?? "").trim() || "Без темы");
    return String(themeName ?? "").trim();
  }

  function buildDecisionMap(decisions = []) {
    return new Map(
      (Array.isArray(decisions) ? decisions : [])
        .map((decision) => [String(decision?.segment_id ?? "").trim(), decision])
        .filter(([segmentId]) => Boolean(segmentId))
    );
  }

  async function collectMediaStats(mediaRoot, mediaPaths = []) {
    const result = [];
    for (const mediaPath of mediaPaths) {
      const normalizedPath = normalizeRelativeMediaPath(mediaPath);
      if (!normalizedPath) continue;
      const absolutePath = path.resolve(mediaRoot, normalizedPath.replace(/\//g, path.sep));
      const insideRoot = absolutePath === mediaRoot || absolutePath.startsWith(`${mediaRoot}${path.sep}`);
      if (!insideRoot) {
        result.push({ path: normalizedPath, exists: false, outside_root: true });
        continue;
      }
      const stats = await fs.stat(absolutePath).catch(() => null);
      result.push(
        stats && stats.isFile()
          ? {
              path: normalizedPath,
              exists: true,
              size: Number(stats.size ?? 0),
              mtime_ms: Number(stats.mtimeMs ?? 0)
            }
          : {
              path: normalizedPath,
              exists: false
            }
      );
    }
    return result.sort((left, right) => String(left.path ?? "").localeCompare(String(right.path ?? "")));
  }

  async function buildDocumentContextHash(docId, segments = [], decisions = [], options = {}) {
    const normalizedDocId = String(docId ?? "").trim();
    const mediaRootRaw = String(options?.mediaRoot ?? (typeof getMediaDir === "function" ? getMediaDir() : "") ?? "").trim();
    const mediaRoot = mediaRootRaw ? path.resolve(mediaRootRaw) : "";
    const decisionMap = buildDecisionMap(decisions);
    const themeMap = new Map();

    for (const segment of Array.isArray(segments) ? segments : []) {
      if (normalizeBlockType(segment?.block_type) === "links") continue;
      const segmentId = String(segment?.segment_id ?? "").trim();
      const themeName = getSectionThemeName(segment);
      const visual = typeof normalizeVisualDecisionInput === "function"
        ? normalizeVisualDecisionInput(decisionMap.get(segmentId)?.visual_decision)
        : decisionMap.get(segmentId)?.visual_decision ?? {};
      const mediaPathCandidates = [];
      if (Array.isArray(visual?.media_file_paths)) {
        mediaPathCandidates.push(...visual.media_file_paths);
      } else if (visual?.media_file_paths != null) {
        mediaPathCandidates.push(visual.media_file_paths);
      }
      if (visual?.media_file_path != null) {
        mediaPathCandidates.push(visual.media_file_path);
      }
      const normalizedMediaPaths = [...new Set(mediaPathCandidates.map((item) => normalizeRelativeMediaPath(item)).filter(Boolean))];
      const segmentPayload = {
        segment_id: segmentId,
        block_type: String(segment?.block_type ?? ""),
        text_quote: String(segment?.text_quote ?? ""),
        section_id: segment?.section_id ? String(segment.section_id) : null,
        section_title: segment?.section_title ? String(segment.section_title) : null,
        section_index: Number.isFinite(Number(segment?.section_index)) ? Number(segment.section_index) : null,
        is_done: Boolean(segment?.is_done),
        visual: {
          type: String(visual?.type ?? ""),
          description: String(visual?.description ?? ""),
          format_hint: visual?.format_hint ?? null,
          priority: visual?.priority ?? null,
          duration_hint_sec: visual?.duration_hint_sec ?? null,
          media_file_paths: normalizedMediaPaths,
          media_file_path: normalizeRelativeMediaPath(visual?.media_file_path ?? ""),
          media_start_timecode: visual?.media_start_timecode ?? null,
          media_file_timecodes: stableObject(visual?.media_file_timecodes ?? {})
        }
      };

      const themeKey = themeName.toLowerCase();
      if (!themeMap.has(themeKey)) {
        themeMap.set(themeKey, {
          theme_name: themeName,
          theme_key: themeKey,
          segments: [],
          media_paths: new Set()
        });
      }
      const bucket = themeMap.get(themeKey);
      bucket.segments.push(segmentPayload);
      normalizedMediaPaths.forEach((item) => bucket.media_paths.add(item));
    }

    const themeEntries = [];
    for (const bucket of themeMap.values()) {
      const mediaStats = mediaRoot ? await collectMediaStats(mediaRoot, Array.from(bucket.media_paths)) : [];
      const themeHash = hashPayload({
        doc_id: normalizedDocId,
        theme_name: bucket.theme_name,
        segments: bucket.segments,
        media_stats: mediaStats
      });
      themeEntries.push({
        theme_name: bucket.theme_name,
        theme_key: bucket.theme_key,
        segment_count: bucket.segments.length,
        media_paths: Array.from(bucket.media_paths).sort((left, right) => left.localeCompare(right)),
        media_stats: mediaStats,
        context_hash: themeHash
      });
    }

    themeEntries.sort((left, right) => left.theme_key.localeCompare(right.theme_key));
    const contextHash = hashPayload({
      doc_id: normalizedDocId,
      themes: themeEntries.map((entry) => ({
        theme_key: entry.theme_key,
        context_hash: entry.context_hash,
        media_paths: entry.media_paths
      }))
    });

    return {
      doc_id: normalizedDocId,
      context_hash: contextHash,
      theme_count: themeEntries.length,
      generated_at: new Date().toISOString(),
      themes: themeEntries
    };
  }

  return {
    buildDocumentContextHash
  };
}
