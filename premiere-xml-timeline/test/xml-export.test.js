import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createXmlExportUtils } from "../src/xml-export.js";

function createXmlUtilsForTest({ mediaDir, backgroundRoot, mediaInfoByName }) {
  process.env.XML_BACKGROUND_ROOT = backgroundRoot;

  return createXmlExportUtils({
    execFileAsync: async (_executable, args) => {
      const targetPath = path.basename(String(args?.[args.length - 1] ?? ""));
      const mediaInfo = mediaInfoByName[targetPath];
      if (!mediaInfo) {
        throw new Error(`Unexpected ffprobe target: ${targetPath}`);
      }
      return {
        stdout: JSON.stringify({
          streams: [
            mediaInfo.hasVideo
              ? {
                  codec_type: "video",
                  width: mediaInfo.width,
                  height: mediaInfo.height,
                  duration: mediaInfo.durationSec
                }
              : null,
            mediaInfo.hasAudio
              ? {
                  codec_type: "audio",
                  channels: mediaInfo.audioChannels ?? 2,
                  duration: mediaInfo.durationSec
                }
              : null
          ].filter(Boolean),
          format: {
            duration: mediaInfo.durationSec
          }
        })
      };
    },
    downloaderTools: {},
    getMediaDir: () => mediaDir,
    normalizeMediaFilePath: (value) => String(value ?? "").trim(),
    normalizeSectionTitleForMatch: (value) => String(value ?? "").trim().toLowerCase(),
    normalizeVisualDecisionInput: (value) => ({ ...(value ?? {}) }),
    safeResolveMediaPath: (root, mediaPath) => path.resolve(root, mediaPath)
  });
}

test("xml export keeps full source duration for trimmed video clipitems", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "vbaut-xml-export-"));
  try {
    const mediaDir = path.join(tempDir, "media");
    const backgroundRoot = path.join(tempDir, "backgrounds");
    await fs.mkdir(mediaDir, { recursive: true });
    await fs.mkdir(backgroundRoot, { recursive: true });

    await fs.writeFile(path.join(mediaDir, "clip.mp4"), "");

    const { buildXmlExportPayload } = createXmlUtilsForTest({
      mediaDir,
      backgroundRoot,
      mediaInfoByName: {
        "clip.mp4": {
          hasVideo: true,
          hasAudio: false,
          width: 1920,
          height: 1080,
          durationSec: 8
        }
      }
    });

    const payload = await buildXmlExportPayload({
      document: { id: "doc-test" },
      segments: [
        {
          segment_id: "seg_1",
          section_id: "intro",
          section_title: "Intro",
          text_quote: "Trimmed clip",
          block_type: "segment"
        }
      ],
      decisionsBySegment: new Map([
        [
          "seg_1",
          {
            visual: {
              media_file_path: "clip.mp4",
              duration_hint_sec: 3,
              media_start_timecode: "00:00:02:00"
            }
          }
        ]
      ]),
      mediaDir,
      mediaPathRootOverride: null,
      fps: 50,
      defaultDurationSec: 5,
      sectionId: "",
      sectionTitle: ""
    });

    assert.match(payload.xml, /<duration>400<\/duration>/);
    assert.match(payload.xml, /<in>100<\/in>/);
    assert.match(payload.xml, /<out>250<\/out>/);
  } finally {
    delete process.env.XML_BACKGROUND_ROOT;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("xml export keeps bg_lines loop clips anchored at zero source in", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "vbaut-xml-background-"));
  try {
    const mediaDir = path.join(tempDir, "media");
    const backgroundRoot = path.join(tempDir, "backgrounds");
    await fs.mkdir(mediaDir, { recursive: true });
    await fs.mkdir(backgroundRoot, { recursive: true });

    await Promise.all([
      fs.writeFile(path.join(mediaDir, "clip-a.mp4"), ""),
      fs.writeFile(path.join(mediaDir, "clip-b.mp4"), ""),
      fs.writeFile(path.join(backgroundRoot, "bg_whirl.mov"), ""),
      fs.writeFile(path.join(backgroundRoot, "bg_lines.mov"), "")
    ]);

    const { buildXmlExportPayload } = createXmlUtilsForTest({
      mediaDir,
      backgroundRoot,
      mediaInfoByName: {
        "clip-a.mp4": {
          hasVideo: true,
          hasAudio: false,
          width: 3840,
          height: 1080,
          durationSec: 6
        },
        "clip-b.mp4": {
          hasVideo: true,
          hasAudio: false,
          width: 3840,
          height: 1080,
          durationSec: 6
        },
        "bg_whirl.mov": {
          hasVideo: true,
          hasAudio: false,
          width: 1920,
          height: 1080,
          durationSec: 12
        },
        "bg_lines.mov": {
          hasVideo: true,
          hasAudio: false,
          width: 1920,
          height: 1080,
          durationSec: 12
        }
      }
    });

    const payload = await buildXmlExportPayload({
      document: { id: "doc-test" },
      segments: [
        {
          segment_id: "seg_1",
          section_id: "intro",
          section_title: "Intro",
          text_quote: "Wide clip 1",
          block_type: "segment"
        },
        {
          segment_id: "seg_2",
          section_id: "intro",
          section_title: "Intro",
          text_quote: "Wide clip 2",
          block_type: "segment"
        }
      ],
      decisionsBySegment: new Map([
        [
          "seg_1",
          {
            visual: {
              media_file_path: "clip-a.mp4",
              duration_hint_sec: 3
            }
          }
        ],
        [
          "seg_2",
          {
            visual: {
              media_file_path: "clip-b.mp4",
              duration_hint_sec: 3
            }
          }
        ]
      ]),
      mediaDir,
      mediaPathRootOverride: null,
      fps: 50,
      defaultDurationSec: 5,
      sectionId: "",
      sectionTitle: ""
    });

    const bgLinesBlock = payload.xml.match(/<clipitem id="[^"]+">[\s\S]*?<name>bg_lines\.mov<\/name>[\s\S]*?<\/clipitem>/);
    assert.ok(bgLinesBlock, "bg_lines clipitem missing from xml");
    assert.match(bgLinesBlock[0], /<duration>600<\/duration>/);
    assert.match(bgLinesBlock[0], /<in>0<\/in>/);
    assert.match(bgLinesBlock[0], /<out>150<\/out>/);
  } finally {
    delete process.env.XML_BACKGROUND_ROOT;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
