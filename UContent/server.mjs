import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { scrapeNotionPage } from "../VBAUT/HeadlessNotion/notion-scraper.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.UCONTENT_PORT || 5197);
const DATA_DIR = path.join(__dirname, "data", "scrapes");
const PUBLIC_DIR = path.join(__dirname, "public");

const MIME_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
  [".md", "text/markdown; charset=utf-8"]
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
  const match = String(url).match(/[0-9a-f]{32}/i);
  const pageId = match ? match[0].toLowerCase() : Date.now().toString(36);
  return `notion-${pageId}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
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
  const payload = {
    id,
    url,
    title,
    content,
    created_at: new Date().toISOString()
  };
  await fs.writeFile(path.join(DATA_DIR, `${id}.json`), JSON.stringify(payload, null, 2), "utf8");
  await fs.writeFile(path.join(DATA_DIR, `${id}.md`), content, "utf8");
  await fs.writeFile(path.join(DATA_DIR, "latest.json"), JSON.stringify(payload, null, 2), "utf8");
  return payload;
}

async function readScrape(id) {
  const safeId = String(id ?? "").replace(/[^a-z0-9_.-]/gi, "");
  const target = safeId ? path.join(DATA_DIR, `${safeId}.json`) : path.join(DATA_DIR, "latest.json");
  const raw = await fs.readFile(target, "utf8");
  return JSON.parse(raw);
}

function htmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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
      const id = decodeURIComponent(reqUrl.pathname.split("/").pop() || "");
      json(res, 200, { scrape: await readScrape(id) });
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
});
