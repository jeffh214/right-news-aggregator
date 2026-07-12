const sourceSelect = document.getElementById("sourceSelect");
const limitInput = document.getElementById("limitInput");
const autoRefreshSelect = document.getElementById("autoRefresh");
const searchInput = document.getElementById("searchInput");
const refreshBtn = document.getElementById("refreshBtn");
const themeToggle = document.getElementById("themeToggle");
const newsList = document.getElementById("newsList");
const earlierSection = document.getElementById("earlierSection");
const earlierList = document.getElementById("earlierList");
const layoffSection = document.getElementById("layoffSection");
const layoffList = document.getElementById("layoffList");
const leadStory = document.getElementById("leadStory");
const statusLine = document.getElementById("statusLine");
const infoLine = document.getElementById("infoLine");
const errorsLine = document.getElementById("errorsLine");
const template = document.getElementById("newsCardTemplate");
const API_BASE = window.__NEWS_API_BASE__ || "";

function buildApiUrl(pathWithQuery) {
  return `${API_BASE}${pathWithQuery}`;
}

function resolveImageSrc(url) {
  if (!url) return "";
  if (url.startsWith("/api/image-proxy") || url.startsWith("/")) return buildApiUrl(url);
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return buildApiUrl(`/api/image-proxy?url=${encodeURIComponent(parsed.href)}`);
    }
    return parsed.href;
  } catch (_err) {
    return url;
  }
}

const THUMB_PLACEHOLDER =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='400' height='225' viewBox='0 0 400 225'%3E%3Crect width='400' height='225' fill='%23d6e2ef'/%3E%3Ctext x='50%25' y='50%25' dominant-baseline='middle' text-anchor='middle' fill='%234f6074' font-family='sans-serif' font-size='16'%3ENo image%3C/text%3E%3C/svg%3E";

const VERIZON_LOGO = buildApiUrl("/verizon-logo.svg");

function itemImageSrc(item) {
  if (item?.kind === "forum") return VERIZON_LOGO;
  return resolveImageSrc(item?.image);
}

function bindThumbImage(img, thumbLink) {
  img.addEventListener("error", () => {
    if (img.src !== THUMB_PLACEHOLDER) {
      img.src = THUMB_PLACEHOLDER;
      img.classList.add("thumb-missing");
    }
  });
  if (thumbLink) thumbLink.hidden = false;
}

function humanizeNetworkError(error) {
  if (error && error.name === "TypeError") {
    if (window.location.protocol === "file:") {
      return "Cannot call API from a file:// page. Run `npm start` in right-news-aggregator and open http://localhost:3000";
    }
    return "Could not reach the backend API. Make sure the Node server is running at http://localhost:3000";
  }
  return error.message || "Request failed.";
}

function formatDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Unknown time";
  return d.toLocaleString();
}

function formatRelative(iso) {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "Unknown time";
  const diffSec = Math.round((Date.now() - then) / 1000);
  if (diffSec < 45) return "just now";
  if (diffSec < 90) return "1 min ago";
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHour = Math.round(diffMin / 60);
  if (diffHour < 24) return `${diffHour} h ago`;
  const diffDay = Math.round(diffHour / 24);
  if (diffDay < 7) return `${diffDay} d ago`;
  return formatDate(iso);
}

function cleanSummary(text) {
  return (text || "").replace(/\s+/g, " ").trim().slice(0, 260);
}

// A news item is "breaking" if it was published within the last 3 hours.
const BREAKING_WINDOW_MS = 3 * 60 * 60 * 1000;

function isBreaking(item) {
  if (!item || item.kind === "forum") return false;
  const published = new Date(item.publishedAt).getTime();
  if (Number.isNaN(published)) return false;
  return Date.now() - published <= BREAKING_WINDOW_MS;
}

function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      })[char]
  );
}

function renderLeadStory(item) {
  if (!item) {
    leadStory.classList.remove("visible");
    leadStory.innerHTML = "";
    return;
  }

  // Feed content is untrusted, so every interpolated value is escaped to
  // prevent stored XSS via malicious titles/summaries.
  const safeTitle = escapeHtml(item.title || "Untitled");
  const safeSummary = escapeHtml(cleanSummary(item.summary));
  const safeLink = escapeHtml(item.link || "#");
  const safeSource = escapeHtml(item.source || "Unknown source");
  const safeRelTime = escapeHtml(formatRelative(item.publishedAt));
  const safeAbsTime = escapeHtml(formatDate(item.publishedAt));
  const isForum = item.kind === "forum";
  const label = isForum ? "Latest Layoff Chatter" : "Latest Breaking";
  const linkText = isForum ? "Open discussion" : "Read breaking story";
  const badgeHtml = isForum ? '<span class="badge badge-lead">Forum</span> ' : "";
  const imageSrc = itemImageSrc(item);
  const imageHtml = imageSrc
    ? `<a class="lead-thumb-link" href="${safeLink}" target="_blank" rel="noopener"><img class="lead-thumb${
        isForum ? " thumb-brand" : ""
      }" src="${escapeHtml(imageSrc)}" alt="${
        isForum ? "Verizon" : ""
      }" loading="lazy" /></a>`
    : "";

  leadStory.classList.toggle("lead-forum", isForum);
  leadStory.classList.toggle("breaking", !isForum && isBreaking(item));
  leadStory.innerHTML = `
    ${imageHtml}
    <div class="lead-body">
      <p class="lead-label">${badgeHtml}${label}</p>
      <h2 class="lead-title">${safeTitle}</h2>
      <p class="lead-meta">${safeSource} • <span title="${safeAbsTime}">${safeRelTime}</span></p>
      <p class="lead-summary">${safeSummary}</p>
      <a class="lead-link" href="${safeLink}" target="_blank" rel="noreferrer noopener">${linkText}</a>
    </div>
  `;
  leadStory.classList.add("visible");
  const leadImg = leadStory.querySelector(".lead-thumb");
  const leadThumbLink = leadStory.querySelector(".lead-thumb-link");
  if (leadImg && !isForum) bindThumbImage(leadImg, leadThumbLink);
  else if (leadThumbLink) leadThumbLink.hidden = false;
}

function makeCard(item) {
  const clone = template.content.cloneNode(true);
  const badge = clone.querySelector("[data-badge]");
  if (item.kind === "forum") {
    badge.textContent = "Forum";
    badge.hidden = false;
    clone.querySelector("[data-card]").classList.add("card-forum");
  } else if (isBreaking(item)) {
    badge.textContent = "Breaking";
    badge.hidden = false;
    badge.classList.add("badge-breaking");
    clone.querySelector("[data-card]").classList.add("card-breaking");
  }
  const imageSrc = itemImageSrc(item);
  if (imageSrc) {
    const thumbLink = clone.querySelector("[data-thumb-link]");
    const img = clone.querySelector("[data-image]");
    const isForum = item.kind === "forum";
    if (isForum) {
      img.classList.add("thumb-brand");
      img.alt = "Verizon";
      if (thumbLink) thumbLink.hidden = false;
    } else {
      bindThumbImage(img, thumbLink);
      img.alt = item.title || "";
    }
    img.src = imageSrc;
    thumbLink.href = item.link || "#";
  }
  clone.querySelector("[data-source]").textContent = item.source;
  const timeEl = clone.querySelector("[data-time]");
  timeEl.textContent = formatRelative(item.publishedAt);
  timeEl.title = formatDate(item.publishedAt);
  clone.querySelector("[data-title]").textContent = item.title || "Untitled";
  clone.querySelector("[data-summary]").textContent = cleanSummary(item.summary);
  clone.querySelector("[data-link]").href = item.link || "#";
  return clone;
}

function renderCards(container, items) {
  const fragment = document.createDocumentFragment();
  items.forEach((item) => fragment.appendChild(makeCard(item)));
  container.appendChild(fragment);
}

function renderNews(items) {
  newsList.innerHTML = "";
  earlierList.innerHTML = "";
  earlierSection.hidden = true;
  layoffList.innerHTML = "";
  layoffSection.hidden = true;
  leadStory.innerHTML = "";
  leadStory.classList.remove("visible");

  if (!items.length) {
    newsList.innerHTML = "<p>No articles found for this filter.</p>";
    return;
  }

  const sortedItems = [...items].sort(
    (a, b) => new Date(b.publishedAt) - new Date(a.publishedAt)
  );
  const forumItems = sortedItems.filter((item) => item.kind === "forum");
  const newsItems = sortedItems.filter((item) => item.kind !== "forum");

  // Forum (layoff) posts get their own section below breaking news.
  let forumForSection = forumItems.slice(0, 9);

  if (newsItems.length) {
    const breakingNews = newsItems.filter(isBreaking);
    const olderNews = newsItems.filter((item) => !isBreaking(item));

    if (breakingNews.length) {
      const [latest, ...remainingBreaking] = breakingNews;
      renderLeadStory(latest);
      renderCards(newsList, remainingBreaking);
    } else {
      newsList.innerHTML = "<p>No breaking headlines in the last 3 hours.</p>";
    }

    if (olderNews.length) {
      renderCards(earlierList, olderNews);
      earlierSection.hidden = false;
    }
  } else if (forumItems.length) {
    // Forum-only results (e.g. filtered to "TheLayoff: Verizon").
    renderLeadStory(forumItems[0]);
    forumForSection = forumItems.slice(1);
  }

  if (forumForSection.length) {
    renderCards(layoffList, forumForSection);
    layoffSection.hidden = false;
  }
}

let currentItems = [];
let filteredCount = 0;

function getFilteredItems() {
  const query = searchInput.value.trim().toLowerCase();
  if (!query) return currentItems;
  return currentItems.filter((item) =>
    [item.title, item.summary, item.source]
      .filter(Boolean)
      .some((field) => field.toLowerCase().includes(query))
  );
}

function renderFiltered() {
  const items = getFilteredItems();
  filteredCount = items.length;
  renderNews(items);
}

async function loadSources() {
  const resp = await fetch(buildApiUrl("/api/sources"));
  if (!resp.ok) throw new Error("Could not load sources.");
  const sources = await resp.json();

  sources.forEach((source) => {
    const option = document.createElement("option");
    option.value = source;
    option.textContent = source;
    sourceSelect.appendChild(option);
  });
}

async function loadNews({ fresh = false } = {}) {
  statusLine.textContent = fresh
    ? "Fetching fresh headlines..."
    : "Loading latest headlines...";
  errorsLine.textContent = "";

  const params = new URLSearchParams();
  if (sourceSelect.value) params.set("source", sourceSelect.value);
  params.set("limit", String(limitInput.value || 80));
  if (fresh) params.set("fresh", "1");

  const resp = await fetch(buildApiUrl(`/api/news?${params.toString()}`));
  if (!resp.ok) throw new Error("News feed request failed.");
  const data = await resp.json();

  currentItems = data.items || [];
  renderFiltered();

  const failed = (data.sourceStatus || []).filter((s) => !s.ok && !s.optional);
  const layoffStatus = (data.sourceStatus || []).find((s) => s.source === "TheLayoff: Verizon");
  const forumCount = currentItems.filter((item) => item.kind === "forum").length;
  const statusParts = [`Updated ${formatDate(data.fetchedAt)}. Loaded ${currentItems.length} headlines.`];
  if (forumCount > 0) {
    statusParts.push(`${forumCount} Verizon layoff posts from TheLayoff.com.`);
  } else if (layoffStatus && !layoffStatus.ok) {
    statusParts.push("Verizon layoff board unavailable.");
  }
  statusLine.textContent = statusParts.join(" ");
  errorsLine.textContent = failed.length
    ? `Some sources failed: ${failed.map((f) => `${f.source}${f.error ? ` (${f.error})` : ""}`).join("; ")}`
    : "";

  scheduleNextRefresh();
  refreshInfoLine();
}

let autoRefreshTimer = null;
let nextRefreshAt = 0;

function currentIntervalSeconds() {
  return Number.parseInt(autoRefreshSelect.value, 10) || 0;
}

function formatCountdown(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function scheduleNextRefresh() {
  const seconds = currentIntervalSeconds();
  nextRefreshAt = seconds > 0 ? Date.now() + seconds * 1000 : 0;
}

// Updates the secondary line with the search match count and a live countdown.
function refreshInfoLine() {
  const parts = [];
  const query = searchInput.value.trim();
  if (query) {
    parts.push(`Showing ${filteredCount} of ${currentItems.length} for "${query}".`);
  }
  if (currentIntervalSeconds() > 0 && nextRefreshAt) {
    const remaining = Math.max(0, Math.round((nextRefreshAt - Date.now()) / 1000));
    parts.push(`Next refresh in ${formatCountdown(remaining)}.`);
  }
  infoLine.textContent = parts.join(" ");
}

function runAutoRefresh() {
  // Skip background ticks; refresh again when the tab is visible.
  if (document.hidden) return;
  loadNews({ fresh: true }).catch((error) => {
    statusLine.textContent = "";
    errorsLine.textContent = humanizeNetworkError(error);
  });
}

function setupAutoRefresh() {
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
  if (currentIntervalSeconds() > 0) {
    autoRefreshTimer = setInterval(runAutoRefresh, currentIntervalSeconds() * 1000);
  }
  scheduleNextRefresh();
  refreshInfoLine();
}

setInterval(refreshInfoLine, 1000);

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  themeToggle.textContent = theme === "dark" ? "Light" : "Dark";
}

applyTheme(document.documentElement.dataset.theme || "light");

themeToggle.addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  try {
    localStorage.setItem("theme", next);
  } catch (_e) {
    /* storage unavailable; theme still applies for this session */
  }
  applyTheme(next);
});

refreshBtn.addEventListener("click", () => {
  loadNews({ fresh: true }).catch((error) => {
    statusLine.textContent = "";
    errorsLine.textContent = humanizeNetworkError(error);
  });
});

sourceSelect.addEventListener("change", () => {
  loadNews().catch((error) => {
    statusLine.textContent = "";
    errorsLine.textContent = humanizeNetworkError(error);
  });
});

limitInput.addEventListener("change", () => {
  loadNews().catch((error) => {
    statusLine.textContent = "";
    errorsLine.textContent = humanizeNetworkError(error);
  });
});

autoRefreshSelect.addEventListener("change", () => {
  try {
    localStorage.setItem("autoRefresh", autoRefreshSelect.value);
  } catch (_e) {
    /* storage unavailable; setting still applies for this session */
  }
  setupAutoRefresh();
  loadNews().catch((error) => {
    statusLine.textContent = "";
    errorsLine.textContent = humanizeNetworkError(error);
  });
});

searchInput.addEventListener("input", () => {
  renderFiltered();
  refreshInfoLine();
});

function restoreAutoRefresh() {
  let saved = null;
  try {
    saved = localStorage.getItem("autoRefresh");
  } catch (_e) {
    /* storage unavailable */
  }
  if (saved !== null && [...autoRefreshSelect.options].some((o) => o.value === saved)) {
    autoRefreshSelect.value = saved;
  }
  setupAutoRefresh();
}

async function init() {
  restoreAutoRefresh();
  try {
    await loadSources();
    await loadNews();
  } catch (error) {
    statusLine.textContent = "";
    errorsLine.textContent = humanizeNetworkError(error);
  }
}

init();

