# UContent

Minimal rewrite experiment for UT content workflow.

Goal: keep the Notion scrape as the source document and render it directly, without VBAUT segmentation, link ownership, card UI, or XML-era assumptions.

## Run

```powershell
cd C:\tgbotapi\UContent
npm run dev
```

Open:

```text
http://localhost:5197/script-text
```

## What Exists Now

- `POST /api/scrape` accepts `{ "url": "<notion url>" }`.
- It calls `../VBAUT/HeadlessNotion/notion-scraper.js`.
- The returned markdown is saved under `data/scrapes`.
- `/script-text` renders that markdown directly in document order.
- Every meaningful paragraph is treated as a segment.
- URL lines and slash lines stay where the scrape placed them.
- Saved scrapes keep a `segments` array with stable `segmentId` values.
- Segments can be added, removed, moved up/down and given attached media metadata from `/script-text`.
- The media picker reads `PAMPAM_ROOT` / `MEDIA_DOWNLOAD_ROOT` or defaults to `C:\Users\Nemifist\YandexDisk\PAMPAM`.
- Opening media for a segment ensures the topic subfolder exists, using the same sanitized topic-name style as VBAUT.
- Media can be selected from the topic folder, selected from all PAMPAM files, or uploaded into the topic folder.
- `POST /api/scrapes/:id/refresh` re-scrapes Notion and reconciles new segments with old segment ids by topic, kind and normalized text.
- XML export uses saved segment ids, segment type and media metadata, so future XML state can survive Notion edits and reordered blocks.

This is intentionally small. The next features should be added only when they preserve the document-as-timeline model.
