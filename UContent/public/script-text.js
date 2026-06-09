const form = document.querySelector("#scrape-form");
const input = document.querySelector("#notion-url");
const statusEl = document.querySelector("#status");
const documentEl = document.querySelector("#document");
const selectEl = document.querySelector("#scrape-select");

function setStatus(message) {
  statusEl.textContent = message;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isUrlLine(line) {
  return /^https?:\/\/\S+$/i.test(String(line ?? "").trim());
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return url;
  }
}

function blockForLine(line, index) {
  const trimmed = String(line ?? "").trim();
  if (!trimmed) return null;
  if (trimmed === "Оформление видео") return null;
  if (trimmed.startsWith("# ")) {
    return `<h1 class="block heading-1" data-line="${index}">${escapeHtml(trimmed.replace(/^#\s+/, ""))}</h1>`;
  }
  if (trimmed.startsWith("### ")) {
    return `<h2 class="block heading-3" data-line="${index}">${escapeHtml(trimmed.replace(/^###\s+/, ""))}</h2>`;
  }
  if (isUrlLine(trimmed)) {
    const safeUrl = escapeHtml(trimmed);
    const host = escapeHtml(hostOf(trimmed));
    return `
      <div class="block link-line" data-line="${index}">
        <a class="link-url" href="${safeUrl}" target="_blank" rel="noreferrer">${safeUrl}</a>
        <a class="link-preview is-empty" href="${safeUrl}" target="_blank" rel="noreferrer" data-preview-url="${safeUrl}">
          <img alt="" loading="lazy" />
          <span class="link-preview-copy">
            <strong>${host}</strong>
            <span></span>
            <em>${host}</em>
          </span>
        </a>
      </div>
    `;
  }
  const className = trimmed.startsWith("/") ? "direction" : "paragraph";
  return `<p class="block ${className}" data-line="${index}">${escapeHtml(trimmed)}</p>`;
}

function parseDocumentSections(content) {
  const lines = String(content ?? "").split(/\r?\n/);
  const prelude = [];
  const sections = [];
  let current = null;

  lines.forEach((line, index) => {
    const trimmed = String(line ?? "").trim();
    if (trimmed.startsWith("### ")) {
      current = {
        title: trimmed.replace(/^###\s+/, "").trim() || "Без темы",
        lineIndex: index,
        lines: []
      };
      sections.push(current);
      return;
    }
    const item = { line, index };
    if (current) {
      current.lines.push(item);
    } else {
      prelude.push(item);
    }
  });

  return { prelude, sections };
}

function renderLines(items) {
  return items
    .map(({ line, index }) => blockForLine(line, index))
    .filter(Boolean)
    .join("\n");
}

function renderSection(section, sectionIndex) {
  const body = renderLines(section.lines);
  const count = section.lines.filter(({ line }) => String(line ?? "").trim()).length;
  return `
    <details class="topic" open data-line="${section.lineIndex}">
      <summary>
        <span>${escapeHtml(section.title)}</span>
        <em>${count} lines</em>
      </summary>
      <div class="topic-body">
        ${body || '<p class="empty">Empty topic.</p>'}
      </div>
    </details>
  `;
}

function renderMarkdown(content) {
  const { prelude, sections } = parseDocumentSections(content);
  const preludeHtml = renderLines(prelude);
  const sectionsHtml = sections.map(renderSection).join("\n");
  const html = [preludeHtml, sectionsHtml].filter(Boolean).join("\n");
  documentEl.innerHTML = html || '<p class="empty">Empty scrape.</p>';
  loadPreviews();
}

async function loadPreviews() {
  const previews = [...document.querySelectorAll("[data-preview-url]")];
  for (const preview of previews) {
    const url = preview.dataset.previewUrl;
    try {
      const response = await fetch(`/api/link-preview?url=${encodeURIComponent(url)}`);
      if (!response.ok) continue;
      const data = await response.json();
      const title = data.title || hostOf(url);
      const description = data.description || "";
      const siteName = data.siteName || hostOf(url);
      preview.querySelector("strong").textContent = title;
      preview.querySelector("span span").textContent = description;
      preview.querySelector("em").textContent = siteName;
      const img = preview.querySelector("img");
      if (data.image) {
        img.src = data.image;
      } else {
        img.remove();
      }
      preview.classList.remove("is-empty");
    } catch {
      // URL line remains visible even when preview fails.
    }
  }
}

async function loadScrape(id = "") {
  const endpoint = id ? `/api/scrapes/${encodeURIComponent(id)}` : "/api/latest";
  const response = await fetch(endpoint);
  if (!response.ok) throw new Error("No saved scrape yet");
  const data = await response.json();
  const scrape = data.scrape;
  if (!scrape) throw new Error("No saved scrape yet");
  renderMarkdown(scrape.content);
  setStatus(`${scrape.title || scrape.id} · ${String(scrape.content ?? "").split(/\r?\n/).length} lines`);
  input.value = scrape.url || "";
}

async function refreshScrapeList() {
  const response = await fetch("/api/scrapes");
  if (!response.ok) return;
  const data = await response.json();
  const items = Array.isArray(data.scrapes) ? data.scrapes : [];
  selectEl.innerHTML = '<option value="">Latest</option>';
  for (const item of items) {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = `${item.title || item.id} · ${item.created_at || ""}`;
    selectEl.append(option);
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const url = input.value.trim();
  if (!url) return;
  const button = form.querySelector("button");
  button.disabled = true;
  setStatus("scraping Notion...");
  try {
    const response = await fetch("/api/scrape", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Scrape failed");
    renderMarkdown(data.scrape.content);
    setStatus(`${data.scrape.title || data.scrape.id} · scraped`);
    await refreshScrapeList();
    selectEl.value = data.scrape.id;
  } catch (error) {
    setStatus(error.message || "Scrape failed");
  } finally {
    button.disabled = false;
  }
});

selectEl.addEventListener("change", async () => {
  try {
    await loadScrape(selectEl.value);
  } catch (error) {
    setStatus(error.message || "Could not load scrape");
  }
});

await refreshScrapeList();
try {
  await loadScrape("");
} catch {
  setStatus("document-first mode");
}
