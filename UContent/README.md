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
- URL lines stay where the scrape placed them.
- Slash lines stay as plain gray stage directions.

This is intentionally small. The next features should be added only when they preserve the document-as-timeline model.
