import fs from "node:fs/promises";
import path from "node:path";

const EXCLUDED_THEME_FOLDERS = new Set(["unsorted", "archive_projects", "archived", "graphics"]);

function normalizeBlockType(value) {
  return String(value ?? "").trim().toLowerCase();
}

function sanitizeDocFileName(value) {
  const fallback = "document";
  const cleaned = String(value ?? "")
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "_")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "");
  return cleaned || fallback;
}

export function createXmlTimelineMirrorService(deps = {}) {
  const {
    buildDocumentContextHash,
    buildXmlExportPayload,
    documentJobQueue,
    getDataDir,
    getMediaDir,
    sanitizeMediaTopicName,
    XML_EXPORT_DEFAULT_DURATION_SEC,
    XML_EXPORT_FPS,
    enabled = true,
    logger = console
  } = deps;

  const statePath = typeof getDataDir === "function"
    ? path.join(getDataDir(), "_runtime", "xml-timeline-mirror-state.json")
    : "";
  let stateLoaded = false;
  let state = { entries: {} };
  let stateWritePromise = null;

  async function loadState() {
    if (stateLoaded || !statePath) return;
    stateLoaded = true;
    const payload = await fs.readFile(statePath, "utf8").catch(() => "");
    if (!payload) return;
    try {
      const parsed = JSON.parse(payload);
      if (parsed && typeof parsed === "object" && parsed.entries && typeof parsed.entries === "object") {
        state = {
          entries: { ...parsed.entries }
        };
      }
    } catch {
      state = { entries: {} };
    }
  }

  async function persistState() {
    if (!statePath) return;
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    const payload = JSON.stringify(
      {
        entries: state.entries,
        updated_at: new Date().toISOString()
      },
      null,
      2
    );
    await fs.writeFile(statePath, payload, "utf8");
  }

  async function saveState() {
    stateWritePromise = (stateWritePromise ?? Promise.resolve())
      .catch(() => null)
      .then(() => persistState());
    return stateWritePromise;
  }

  function getSectionThemeName(segment) {
    const themeName = sanitizeMediaTopicName(String(segment?.section_title ?? "").trim() || "Без темы");
    const normalized = String(themeName ?? "").trim();
    if (!normalized) return "";
    if (EXCLUDED_THEME_FOLDERS.has(normalized.toLowerCase())) return "";
    return normalized;
  }

  function buildDecisionMap(decisions = []) {
    return new Map(
      (Array.isArray(decisions) ? decisions : [])
        .map((decision) => [String(decision?.segment_id ?? "").trim(), decision])
        .filter(([segmentId]) => Boolean(segmentId))
    );
  }

  function collectThemeGroups(segments = []) {
    const groups = new Map();
    (Array.isArray(segments) ? segments : []).forEach((segment) => {
      if (normalizeBlockType(segment?.block_type) === "links") return;
      const themeName = getSectionThemeName(segment);
      if (!themeName) return;
      const key = themeName.toLowerCase();
      if (!groups.has(key)) {
        groups.set(key, { themeName, segments: [] });
      }
      groups.get(key).segments.push(segment);
    });
    return Array.from(groups.values());
  }

  async function removeManagedXml(entry) {
    const xmlPath = String(entry?.xml_path ?? "").trim();
    if (xmlPath) {
      await fs.unlink(xmlPath).catch(() => null);
    }
  }

  async function syncDocumentContextNow(docId, segments = [], decisions = [], options = {}) {
    if (!enabled || typeof buildXmlExportPayload !== "function" || typeof getMediaDir !== "function") {
      return { skipped: true, reason: "disabled" };
    }
    const normalizedDocId = String(docId ?? "").trim();
    if (!normalizedDocId) {
      return { skipped: true, reason: "missing_doc_id" };
    }

    await loadState();

    const mediaRoot = path.resolve(String(getMediaDir() ?? "").trim());
    if (!mediaRoot) {
      return { skipped: true, reason: "missing_media_root" };
    }
    await fs.mkdir(mediaRoot, { recursive: true });

    const decisionMap = buildDecisionMap(decisions);
    const themeGroups = collectThemeGroups(segments);
    const contextHashInfo =
      options?.contextHashInfo ??
      (typeof buildDocumentContextHash === "function"
        ? await buildDocumentContextHash(normalizedDocId, segments, decisions, { mediaRoot })
        : null);
    const themeHashes = new Map(
      (Array.isArray(contextHashInfo?.themes) ? contextHashInfo.themes : [])
        .map((entry) => [String(entry?.theme_key ?? "").trim(), String(entry?.context_hash ?? "").trim()])
        .filter(([themeKey, contextHash]) => Boolean(themeKey) && Boolean(contextHash))
    );
    const activeKeys = new Set();
    const safeDocPart = sanitizeDocFileName(normalizedDocId);
    let written = 0;
    let skipped = 0;
    let removed = 0;

    for (const group of themeGroups) {
      const themeName = String(group?.themeName ?? "").trim();
      if (!themeName) continue;
      const themeKey = themeName.toLowerCase();
      const stateKey = `${normalizedDocId}::${themeKey}`;
      activeKeys.add(stateKey);
      const topicDir = path.join(mediaRoot, themeName);
      const xmlPath = path.join(topicDir, `_timeline-${safeDocPart}.xml`);
      const themeHash = themeHashes.get(themeKey) || "";
      const previous = state.entries[stateKey] ?? null;
      if (previous?.theme_hash === themeHash && String(previous?.xml_path ?? "").trim() === xmlPath) {
        skipped += 1;
        continue;
      }

      await fs.mkdir(topicDir, { recursive: true });
      const xmlPayload = await buildXmlExportPayload({
        document: options?.document ?? { id: normalizedDocId },
        segments: group.segments,
        decisionsBySegment: decisionMap,
        mediaDir: mediaRoot,
        mediaPathRootOverride: mediaRoot,
        fps: XML_EXPORT_FPS,
        defaultDurationSec: XML_EXPORT_DEFAULT_DURATION_SEC,
        sectionId: "",
        sectionTitle: themeName
      });

      if (!xmlPayload?.clipCount || !String(xmlPayload?.xml ?? "").trim()) {
        await fs.unlink(xmlPath).catch(() => null);
        delete state.entries[stateKey];
        removed += 1;
        continue;
      }

      await fs.writeFile(xmlPath, String(xmlPayload.xml), "utf8");
      state.entries[stateKey] = {
        doc_id: normalizedDocId,
        theme_name: themeName,
        xml_path: xmlPath,
        document_hash: String(contextHashInfo?.context_hash ?? "").trim() || null,
        theme_hash: themeHash || null,
        clip_count: Number(xmlPayload.clipCount ?? 0),
        reason: String(options?.reason ?? "").trim() || null,
        updated_at: new Date().toISOString()
      };
      written += 1;
    }

    const staleKeys = Object.keys(state.entries).filter(
      (key) => key.startsWith(`${normalizedDocId}::`) && !activeKeys.has(key)
    );
    for (const key of staleKeys) {
      await removeManagedXml(state.entries[key]);
      delete state.entries[key];
      removed += 1;
    }

    await saveState();

    if (written > 0 && typeof logger?.info === "function") {
      logger.info(
        `[xml-mirror] synced doc=${normalizedDocId} reason=${String(options?.reason ?? "update")} written=${written} skipped=${skipped} removed=${removed}`
      );
    }

    return {
      ok: true,
      written,
      skipped,
      removed,
      themes: themeGroups.length
    };
  }

  async function enqueueDocumentContextSync(docId, segments = [], decisions = [], options = {}) {
    const normalizedDocId = String(docId ?? "").trim();
    if (!normalizedDocId) return false;
    const contextHashInfo =
      options?.contextHashInfo ??
      (typeof buildDocumentContextHash === "function"
        ? await buildDocumentContextHash(normalizedDocId, segments, decisions, { mediaRoot: getMediaDir?.() })
        : null);
    const runSync = async () => {
      await syncDocumentContextNow(normalizedDocId, segments, decisions, {
        ...options,
        contextHashInfo
      }).catch((error) => {
        if (typeof logger?.warn === "function") {
          logger.warn(`[xml-mirror] sync failed doc=${normalizedDocId}: ${error?.message ?? error}`);
        }
        return null;
      });
    };
    if (documentJobQueue?.enqueue) {
      const dedupeKey = String(contextHashInfo?.context_hash ?? "").trim() || normalizedDocId;
      return documentJobQueue.enqueue({
        docId: normalizedDocId,
        jobType: "xml_sync",
        dedupeKey,
        run: runSync
      });
    }
    void runSync();
    return true;
  }

  return {
    enqueueDocumentContextSync,
    syncDocumentContextNow
  };
}
