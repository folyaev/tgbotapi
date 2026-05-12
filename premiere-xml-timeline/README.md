# Premiere XML Timeline Export

This folder contains the portable XML timeline export logic from `VBAUT`.

It generates Premiere-importable `xmeml` / Final Cut Pro XML files:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="4">
  <sequence id="sequence-1">
```

## What To Copy

Copy the whole `premiere-xml-timeline` folder into another bot/project.

Core files:

- `src/xml-export.js` - main timeline XML generator.
- `src/xml-timeline-mirror.js` - optional helper that auto-writes per-topic `_timeline-*.xml` files.
- `src/document-context-hash.js` - optional hash helper used by the mirror service.
- `src/document-job-queue.js` - optional debounce/dedupe queue used by the mirror service.
- `examples/generate-xml.mjs` - standalone adapter/CLI example.
- `examples/sample-project.json` - expected input shape.
- `test/*.test.js` - regression tests copied from the working project.

## Input Model

The generator expects:

- `segments[]` with `segment_id`, `section_id`, `section_title`, `text_quote`, `block_type`.
- `decisions[]` keyed by `segment_id`.
- each decision has `visual_decision.media_file_path` or `visual_decision.media_file_paths`.
- media files must exist under `media_dir`.

Minimal decision:

```json
{
  "segment_id": "seg_1",
  "visual_decision": {
    "media_file_path": "clip-a.mp4",
    "duration_hint_sec": 3,
    "media_start_timecode": "00:00:02:00"
  }
}
```

Multiple files per segment:

```json
{
  "segment_id": "seg_1",
  "visual_decision": {
    "media_file_paths": ["main.mp4", "backup.wav"],
    "media_file_timecodes": {
      "main.mp4": "00:00:04:00"
    },
    "duration_hint_sec": 5
  }
}
```

## Run Example

Create a real media file here:

```text
premiere-xml-timeline/examples/media/clip-a.mp4
```

Then run:

```powershell
cd premiere-xml-timeline
node examples/generate-xml.mjs examples/sample-project.json timeline.xml
```

The output `timeline.xml` can be imported into Premiere Pro.

## Important Env Vars

- `XML_EXPORT_FPS` - default `50`.
- `XML_EXPORT_DEFAULT_DURATION_SEC` - default `5`.
- `XML_SECTION_MARKER_DURATION_SEC` - default `2`.
- `XML_SECTION_GAP_SEC` - default `7`.
- `XML_BACKGROUND_ROOT` - optional folder with `bg_whirl.mov`, `bg_lines.mov`, `bg_ribbon.mov`.
- `MEDIA_FFPROBE_PATH` - optional explicit path to `ffprobe`.

The generator works without backgrounds. If background files exist, wide/portrait clips can get background layers.

## What It Generates

- `xmeml version="4"` XML.
- `1920x960` sequence.
- video and audio tracks.
- sequence markers for sections and segments.
- shared file IDs for video+audio clips so Premiere relink works correctly.
- motion scale/center presets for common source sizes.
- trimmed source in/out from `media_start_timecode` / `media_file_timecodes`.

## Integration In Another Bot

Import the factory:

```js
import { createXmlExportUtils } from "./premiere-xml-timeline/src/xml-export.js";
```

Create utils with project-specific path helpers:

```js
const utils = createXmlExportUtils({
  execFileAsync,
  downloaderTools: {},
  getMediaDir: () => mediaDir,
  normalizeMediaFilePath,
  normalizeSectionTitleForMatch,
  normalizeVisualDecisionInput,
  safeResolveMediaPath
});
```

Then call:

```js
const payload = await utils.buildXmlExportPayload({
  document,
  segments,
  decisionsBySegment,
  mediaDir,
  mediaPathRootOverride: mediaDir,
  fps: 50,
  defaultDurationSec: 5,
  sectionId: "",
  sectionTitle: ""
});

await fs.writeFile("timeline.xml", payload.xml, "utf8");
```

`decisionsBySegment` must be a `Map`:

```js
const decisionsBySegment = new Map(
  decisions.map((decision) => [decision.segment_id, decision])
);
```
