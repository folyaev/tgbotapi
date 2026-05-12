import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createDocumentContextHashUtils } from "../src/document-context-hash.js";
import { createDocumentJobQueue } from "../src/document-job-queue.js";
import { createXmlTimelineMirrorService } from "../src/xml-timeline-mirror.js";

function normalizeVisualDecisionInput(value) {
  return value && typeof value === "object" ? { ...value } : {};
}

function createHashUtils(mediaRoot) {
  return createDocumentContextHashUtils({
    getMediaDir: () => mediaRoot,
    normalizeVisualDecisionInput,
    sanitizeMediaTopicName: (value) => String(value ?? "").trim() || "Без темы"
  });
}

test("xml timeline mirror writes once and skips unchanged theme context", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vbaut-xml-mirror-"));
  const mediaRoot = path.join(tempRoot, "PAMPAM");
  const dataRoot = path.join(tempRoot, "data");
  await fs.mkdir(mediaRoot, { recursive: true });
  await fs.mkdir(dataRoot, { recursive: true });
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => null);
  });

  const themeName = "Bieber";
  const themeDir = path.join(mediaRoot, themeName);
  await fs.mkdir(themeDir, { recursive: true });
  await fs.writeFile(path.join(themeDir, "shot.mp4"), "video", "utf8");

  let buildCalls = 0;
  const { buildDocumentContextHash } = createHashUtils(mediaRoot);
  const service = createXmlTimelineMirrorService({
    buildDocumentContextHash,
    buildXmlExportPayload: async ({ document, sectionTitle, segments }) => {
      buildCalls += 1;
      return {
        clipCount: segments.length,
        fileName: `${document?.id ?? "doc"}-${sectionTitle}.xml`,
        xml: `<xml clips="${segments.length}" section="${sectionTitle}" />`
      };
    },
    getDataDir: () => dataRoot,
    getMediaDir: () => mediaRoot,
    sanitizeMediaTopicName: (value) => String(value ?? "").trim() || "Без темы",
    XML_EXPORT_DEFAULT_DURATION_SEC: 4,
    XML_EXPORT_FPS: 25,
    enabled: true
  });

  const docId = "doc_alpha";
  const segments = [
    {
      segment_id: "news_01",
      block_type: "news",
      text_quote: "Bieber story",
      section_title: themeName,
      section_index: 1,
      is_done: false
    }
  ];
  const decisions = [
    {
      segment_id: "news_01",
      visual_decision: {
        type: "video",
        media_file_paths: [`${themeName}/shot.mp4`],
        duration_hint_sec: 5
      }
    }
  ];

  const first = await service.syncDocumentContextNow(docId, segments, decisions, { reason: "test" });
  assert.equal(first.written, 1);
  assert.equal(buildCalls, 1);

  const xmlPath = path.join(themeDir, "_timeline-doc_alpha.xml");
  const writtenXml = await fs.readFile(xmlPath, "utf8");
  assert.match(writtenXml, /section="Bieber"/);

  const second = await service.syncDocumentContextNow(docId, segments, decisions, { reason: "test_repeat" });
  assert.equal(second.skipped, 1);
  assert.equal(buildCalls, 1);

  await fs.writeFile(path.join(themeDir, "shot.mp4"), "video-updated", "utf8");
  const third = await service.syncDocumentContextNow(docId, segments, decisions, { reason: "test_media_changed" });
  assert.equal(third.written, 1);
  assert.equal(buildCalls, 2);
});

test("xml timeline mirror queue dedupes identical document context", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vbaut-xml-mirror-queue-"));
  const mediaRoot = path.join(tempRoot, "PAMPAM");
  const dataRoot = path.join(tempRoot, "data");
  await fs.mkdir(mediaRoot, { recursive: true });
  await fs.mkdir(dataRoot, { recursive: true });
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => null);
  });

  const themeName = "Topic";
  const themeDir = path.join(mediaRoot, themeName);
  await fs.mkdir(themeDir, { recursive: true });
  await fs.writeFile(path.join(themeDir, "clip.mp4"), "video", "utf8");

  let buildCalls = 0;
  const { buildDocumentContextHash } = createHashUtils(mediaRoot);
  const queue = createDocumentJobQueue({ debounceMs: 25, logger: console });
  const service = createXmlTimelineMirrorService({
    buildDocumentContextHash,
    buildXmlExportPayload: async ({ segments }) => {
      buildCalls += 1;
      return {
        clipCount: segments.length,
        xml: `<xml clips="${segments.length}" />`
      };
    },
    documentJobQueue: queue,
    getDataDir: () => dataRoot,
    getMediaDir: () => mediaRoot,
    sanitizeMediaTopicName: (value) => String(value ?? "").trim() || "Без темы",
    XML_EXPORT_DEFAULT_DURATION_SEC: 4,
    XML_EXPORT_FPS: 25,
    enabled: true
  });

  const segments = [
    {
      segment_id: "news_01",
      block_type: "news",
      text_quote: "Story",
      section_title: themeName
    }
  ];
  const decisions = [
    {
      segment_id: "news_01",
      visual_decision: {
        type: "video",
        media_file_paths: [`${themeName}/clip.mp4`]
      }
    }
  ];

  const firstEnqueue = await service.enqueueDocumentContextSync("doc_queue", segments, decisions, { reason: "first" });
  const secondEnqueue = await service.enqueueDocumentContextSync("doc_queue", segments, decisions, { reason: "second" });
  assert.equal(firstEnqueue, true);
  assert.equal(secondEnqueue, false);

  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(buildCalls, 1);
});
