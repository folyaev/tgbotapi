import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { createXmlExportUtils } from "../src/xml-export.js";

const execFileAsync = promisify(execFile);

function normalizeMediaFilePath(value) {
  return String(value ?? "").trim().replaceAll("\\", "/").replace(/^\/+/, "");
}

function normalizeSectionTitleForMatch(value) {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeVisualDecisionInput(value) {
  return value && typeof value === "object" ? { ...value } : {};
}

function safeResolveMediaPath(root, mediaPath) {
  const normalized = normalizeMediaFilePath(mediaPath);
  if (!normalized) return null;
  const rootPath = path.resolve(String(root ?? ""));
  const resolved = path.resolve(rootPath, normalized);
  const relative = path.relative(rootPath, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return resolved;
}

function buildDecisionMap(decisions) {
  return new Map(
    (Array.isArray(decisions) ? decisions : [])
      .map((decision) => [String(decision?.segment_id ?? "").trim(), decision])
      .filter(([segmentId]) => Boolean(segmentId))
  );
}

async function main() {
  const inputPath = path.resolve(process.argv[2] ?? "examples/sample-project.json");
  const outputPath = path.resolve(process.argv[3] ?? "timeline.xml");
  const project = JSON.parse(await fs.readFile(inputPath, "utf8"));
  const mediaDir = path.resolve(path.dirname(inputPath), String(project.media_dir ?? "."));

  const utils = createXmlExportUtils({
    execFileAsync,
    downloaderTools: {},
    getMediaDir: () => mediaDir,
    normalizeMediaFilePath,
    normalizeSectionTitleForMatch,
    normalizeVisualDecisionInput,
    safeResolveMediaPath
  });

  const payload = await utils.buildXmlExportPayload({
    document: project.document ?? { id: "document" },
    segments: Array.isArray(project.segments) ? project.segments : [],
    decisionsBySegment: buildDecisionMap(project.decisions),
    mediaDir,
    mediaPathRootOverride: project.xml_media_root || null,
    fps: project.fps,
    defaultDurationSec: project.default_duration_sec,
    sectionId: project.section_id ?? "",
    sectionTitle: project.section_title ?? ""
  });

  if (!payload.clipCount || !String(payload.xml ?? "").trim()) {
    throw new Error("No timeline clips were generated. Check media_dir and visual_decision.media_file_path.");
  }

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, payload.xml, "utf8");
  console.log(`Wrote ${outputPath}`);
  console.log(`Clips: ${payload.clipCount}`);
}

main().catch((error) => {
  console.error(error?.stack || error?.message || error);
  process.exitCode = 1;
});
