const path = require("path");
const { execFile } = require("child_process");
const express = require("express");
const Parser = require("rss-parser");
const cheerio = require("cheerio");

const app = express();
const PORT = process.env.PORT || 3000;

// Many sites (e.g. thelayoff.com) reject obvious bot user-agents with 403,
// so we present a normal desktop browser UA for every outbound request.
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const parser = new Parser({
  timeout: 12000,
  headers: { "User-Agent": BROWSER_UA },
  customFields: {
    item: [
      ["media:content", "mediaContent", { keepArray: true }],
      ["media:thumbnail", "mediaThumbnail"],
      ["content:encoded", "contentEncoded"]
    ]
  }
});

const SOURCES = [
  { name: "Breitbart", url: "https://www.breitbart.com/feed/" },
  { name: "Fox News", url: "https://moxie.foxnews.com/google-publisher/latest.xml" },
  { name: "ZeroHedge", url: "https://feeds.feedburner.com/zerohedge/feed" },
  { name: "Gateway Pundit", url: "https://www.thegatewaypundit.com/feed/" },
  {
    name: "Daily Caller",
    urls: [
      "https://feeds.feedburner.com/dailycaller",
      "https://dailycaller.com/feed/"
    ]
  },
  { name: "Washington Examiner", url: "https://www.washingtonexaminer.com/feed/" },
  {
    name: "American Thinker",
    optional: true,
    urls: [
      "https://www.americanthinker.com/rss.xml",
      "https://www.americanthinker.com/feed/",
      "https://www.americanthinker.com/feeds/articles.xml"
    ]
  },
  {
    name: "TheLayoff: Verizon",
    type: "scrape",
    scrape: "layoff",
    maxItems: 9,
    url: "https://www.thelayoff.com/verizon-communications"
  }
];

// Cache successful source fetches so repeated /api/news calls don't hammer
// every upstream feed on each page load.
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map();
const IMAGE_CACHE_TTL_MS = 60 * 60 * 1000;
const IMAGE_CACHE_MAX = 250;
const imageCache = new Map();
const OG_IMAGE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const ogImageCache = new Map();
const IMAGE_PROXY_MAX_CONCURRENT = 4;
let imageProxyActive = 0;
const imageProxyWaiters = [];

function runQueuedImageProxy(task) {
  return new Promise((resolve, reject) => {
    const run = async () => {
      imageProxyActive += 1;
      try {
        resolve(await task());
      } catch (error) {
        reject(error);
      } finally {
        imageProxyActive -= 1;
        const next = imageProxyWaiters.shift();
        if (next) next();
      }
    };

    if (imageProxyActive < IMAGE_PROXY_MAX_CONCURRENT) {
      run();
    } else {
      imageProxyWaiters.push(run);
    }
  });
}

function readImageCache(key) {
  const entry = imageCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > IMAGE_CACHE_TTL_MS) {
    imageCache.delete(key);
    return null;
  }
  return entry;
}

function writeImageCache(key, contentType, buffer) {
  if (imageCache.size >= IMAGE_CACHE_MAX) {
    const oldestKey = imageCache.keys().next().value;
    if (oldestKey) imageCache.delete(oldestKey);
  }
  imageCache.set(key, { ts: Date.now(), contentType, buffer });
}

function firstImageFromHtml(html) {
  if (!html) return "";
  const imgMatch = /<img\b[^>]+>/i.exec(html);
  if (!imgMatch) return "";
  const tag = imgMatch[0];
  for (const attr of ["src", "data-src", "data-lazy-src", "data-original"]) {
    const m = new RegExp(`${attr}=["']([^"']+)["']`, "i").exec(tag);
    if (m && m[1] && !m[1].startsWith("data:")) return m[1];
  }
  const srcsetMatch = /srcset=["']([^"']+)["']/i.exec(tag);
  if (srcsetMatch) {
    const first = srcsetMatch[1].split(",")[0].trim().split(/\s+/)[0];
    if (first && !first.startsWith("data:")) return first;
  }
  return "";
}

function absolutizeImageUrl(url, baseUrl) {
  if (!url) return "";
  const trimmed = url.trim();
  if (!trimmed || trimmed.startsWith("data:")) return "";
  try {
    if (trimmed.startsWith("//")) return `https:${trimmed}`;
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    if (baseUrl) return new URL(trimmed, baseUrl).href;
  } catch (_err) {
    return "";
  }
  return trimmed;
}

// Hotlinked images from many outlets fail in the browser; proxy them server-side.
function shouldProxyImageUrl(url) {
  if (!url || url.startsWith("/")) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch (_err) {
    return false;
  }
}

function refererForImageUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.includes("foxnews.com")) return "https://www.foxnews.com/";
    if (host.includes("breitbart.com")) return "https://www.breitbart.com/";
    if (host.includes("dailycaller.com")) return "https://dailycaller.com/";
    if (host.includes("thegatewaypundit.com")) return "https://www.thegatewaypundit.com/";
    if (host.includes("washingtonexaminer.com")) return "https://www.washingtonexaminer.com/";
    if (host.includes("zerohedge.com")) return "https://www.zerohedge.com/";
    return new URL(url).origin + "/";
  } catch (_err) {
    return "";
  }
}

function isAllowedImageUrl(url) {
  return shouldProxyImageUrl(url);
}

function proxyImageUrl(url) {
  if (!shouldProxyImageUrl(url)) return url || "";
  return `/api/image-proxy?url=${encodeURIComponent(url)}`;
}

// Pull a representative image out of an RSS item, checking the common places
// feeds put them: enclosures, media:thumbnail, media:content, then inline HTML.
function extractImage(item) {
  const base = item.link || "";
  const enclosure = item.enclosure;
  if (enclosure && enclosure.url && (!enclosure.type || enclosure.type.startsWith("image"))) {
    return absolutizeImageUrl(enclosure.url, base);
  }

  const thumb = item.mediaThumbnail;
  if (thumb) {
    let url = "";
    if (thumb.$ && thumb.$.url) {
      url = thumb.$.url;
    } else if (typeof thumb === "string") {
      url = thumb;
    }
    if (url) return absolutizeImageUrl(url, base);
  }

  const media = item.mediaContent;
  if (media) {
    const list = Array.isArray(media) ? media : [media];
    for (const entry of list) {
      const attrs = entry && entry.$;
      if (!attrs || !attrs.url) continue;
      const isImage =
        !attrs.type || attrs.type.startsWith("image") || attrs.medium === "image";
      if (isImage) return absolutizeImageUrl(attrs.url, base);
    }
  }

  const raw = firstImageFromHtml(item.contentEncoded || item.content || item.summary || "");
  return absolutizeImageUrl(raw, base);
}

function normalizeItem(item, sourceName) {
  const title = item.title || "Untitled";
  const link = item.link || "";
  const publishedRaw =
    item.isoDate ||
    item.pubDate ||
    item.published ||
    item.created ||
    new Date(0).toISOString();
  const publishedAt = new Date(publishedRaw).toISOString();
  const summary = item.contentSnippet || item.content || item.summary || "";

  return {
    title,
    link,
    publishedAt,
    source: sourceName,
    summary,
    image: proxyImageUrl(extractImage(item)),
    kind: "news"
  };
}

async function fetchRssSource(source) {
  const candidateUrls = source.urls && source.urls.length ? source.urls : [source.url];
  let lastError = "No feed URL configured.";

  for (const url of candidateUrls) {
    try {
      const feed = await parser.parseURL(url);
      let items = (feed.items || []).map((item) => normalizeItem(item, source.name));
      if (source.name === "Breitbart" || source.name === "Daily Caller") {
        items = await enrichMissingImages(items, 10);
      }
      if (source.name === "Gateway Pundit" || source.name === "Washington Examiner") {
        items = await enrichMissingImages(items, 6);
      }
      return { source: source.name, ok: true, optional: !!source.optional, items };
    } catch (error) {
      lastError = error.message;
    }
  }

  return { source: source.name, ok: false, optional: !!source.optional, error: lastError, items: [] };
}

function extractOgImageFromHtml(html) {
  const match = html.match(/property=["']og:image["']\s+content=["']([^"']+)["']/i);
  return match ? match[1].trim() : "";
}

function isUsableOgImage(url) {
  if (!url) return false;
  const lower = url.toLowerCase();
  if (lower.includes("dailycaller-icon") || lower.endsWith(".svg")) return false;
  return true;
}

async function fetchOgImage(articleUrl) {
  const cached = ogImageCache.get(articleUrl);
  if (cached && Date.now() - cached.ts < OG_IMAGE_CACHE_TTL_MS) {
    return cached.url;
  }

  const html = await fetchHtmlViaCurl(articleUrl, 12000);
  const url = extractOgImageFromHtml(html);
  if (!isUsableOgImage(url)) return "";

  ogImageCache.set(articleUrl, { ts: Date.now(), url });
  return url;
}

async function enrichMissingImages(items, maxFetches = 8) {
  const targets = items.filter((item) => !item.image && item.link).slice(0, maxFetches);
  const batchSize = 3;

  for (let i = 0; i < targets.length; i += batchSize) {
    const batch = targets.slice(i, i + batchSize);
    await Promise.all(
      batch.map(async (item) => {
        try {
          const imageUrl = await fetchOgImage(item.link);
          if (!imageUrl) return;
          item.image = proxyImageUrl(absolutizeImageUrl(imageUrl, item.link));
        } catch (_err) {
          /* skip failed article scrape */
        }
      })
    );
  }

  return items;
}

// thelayoff.com sits behind Cloudflare, which blocks Node's fetch on a TLS
// fingerprint basis (403) but lets the system curl through, so we shell out to
// curl to retrieve the raw HTML.
const CURL_BIN = process.platform === "win32" ? "curl.exe" : "curl";

function fetchHtmlViaCurlOnce(url, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    execFile(
      CURL_BIN,
      [
        "-sL",
        "--max-time",
        String(Math.ceil(timeoutMs / 1000)),
        "-A",
        BROWSER_UA,
        "-H",
        "Accept-Language: en-US,en;q=0.9",
        "-H",
        "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "-H",
        "Referer: https://www.thelayoff.com/",
        url
      ],
      { maxBuffer: 20 * 1024 * 1024, timeout: timeoutMs + 5000, windowsHide: true },
      (error, stdout) => {
        if (error) {
          reject(new Error(`curl request failed: ${error.message}`));
          return;
        }
        if (isBlockedLayoffHtml(stdout)) {
          reject(new Error("Blocked by Cloudflare."));
          return;
        }
        resolve(stdout);
      }
    );
  });
}

function isBlockedLayoffHtml(html) {
  if (!html || html.length < 500) return true;
  if (/thread-link|post-title|col-12 post topic/i.test(html)) return false;
  return /just a moment|cf-browser-verification|challenge-platform|enable javascript and cookies/i.test(
    html
  );
}

async function fetchHtmlViaCurl(url, timeoutMs = 20000, retries = 5) {
  let lastError = new Error("curl request failed.");
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      return await fetchHtmlViaCurlOnce(url, timeoutMs);
    } catch (error) {
      lastError = error;
      if (attempt < retries - 1) {
        await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
      }
    }
  }
  throw lastError;
}

// Scrapes a thelayoff.com company board (e.g. /verizon-communications),
// which no longer offers RSS, and normalizes each topic into a feed item.
function findLayoffPosts($) {
  const selectors = [
    "article.post.topic",
    "article.post",
    "article.topic",
    'article[class*="post"][class*="topic"]'
  ];
  for (const selector of selectors) {
    const posts = $(selector);
    if (posts.length) return posts;
  }
  return $();
}

async function fetchLayoffSource(source) {
  const html = await fetchHtmlViaCurl(source.url);
  const $ = cheerio.load(html);
  const items = [];

  findLayoffPosts($).each((_, el) => {
    const node = $(el);
    let titleLink = node.find("h2.post-title a.thread-link").first();
    if (!titleLink.length) titleLink = node.find("h2.post-title a").first();
    if (!titleLink.length) titleLink = node.find("a.thread-link").first();
    const title = titleLink.text().trim();
    if (!title) return;

    const href = titleLink.attr("href") || "";
    let link = source.url;
    try {
      link = new URL(href, source.url).href;
    } catch (_err) {
      /* keep board URL as fallback */
    }

    const datetime =
      node.find(".post-timeago").first().attr("data-datetime") ||
      node.find(".post-timeago time").first().attr("datetime") ||
      "";

    const bodyClone = node.find(".post-body").first().clone();
    bodyClone.find("a").remove();
    let summary = bodyClone
      .text()
      .replace(/\s+/g, " ")
      .replace(/[–—-]\s*$/, "")
      .trim();

    const replies = node.find(".nreplies strong").first().text().trim();
    if (replies) {
      summary = summary ? `${summary} — ${replies}` : replies;
    }

    items.push({
      title,
      link,
      publishedAt: new Date(datetime || 0).toISOString(),
      source: source.name,
      summary,
      image: "/verizon-logo.svg",
      kind: "forum"
    });
  });

  if (!items.length) {
    throw new Error("No posts found (page layout may have changed).");
  }

  // Keep only the newest N topics (defaults to 10) for this board.
  const maxItems = source.maxItems || 10;
  const trimmed = items
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
    .slice(0, maxItems);

  return { source: source.name, ok: true, optional: !!source.optional, items: trimmed };
}

async function fetchSource(source) {
  try {
    if (source.type === "scrape" && source.scrape === "layoff") {
      return await fetchLayoffSource(source);
    }
    return await fetchRssSource(source);
  } catch (error) {
    return {
      source: source.name,
      ok: false,
      optional: !!source.optional,
      error: error.message,
      items: []
    };
  }
}

async function fetchSourceCached(source, { fresh = false } = {}) {
  const cached = cache.get(source.name);
  if (!fresh && cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.result;
  }

  const result = await fetchSource(source);
  if (result.ok) {
    cache.set(source.name, { ts: Date.now(), result });
    return result;
  }
  // Re-use the last good scrape when Cloudflare or a feed blips.
  if (cached?.result?.ok) {
    return cached.result;
  }
  return result;
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

app.get("/api/sources", (_req, res) => {
  res.json(SOURCES.map((source) => source.name));
});

app.get("/api/image-proxy", async (req, res) => {
  const rawUrl = req.query.url;
  if (!rawUrl || typeof rawUrl !== "string") {
    return res.status(400).json({ error: "Missing url parameter." });
  }

  let imageUrl;
  try {
    imageUrl = new URL(rawUrl);
  } catch (_err) {
    return res.status(400).json({ error: "Invalid url." });
  }

  if (!isAllowedImageUrl(imageUrl.href)) {
    return res.status(403).json({ error: "Image host not allowed." });
  }

  const cacheKey = imageUrl.href;
  const cachedImage = readImageCache(cacheKey);
  if (cachedImage) {
    res.setHeader("Content-Type", cachedImage.contentType);
    res.setHeader("Cache-Control", "public, max-age=3600");
    return res.send(cachedImage.buffer);
  }

  const referer = refererForImageUrl(imageUrl.href);
  try {
    const upstream = await runQueuedImageProxy(() =>
      fetch(imageUrl.href, {
        headers: {
          "User-Agent": BROWSER_UA,
          Accept: "image/*,*/*;q=0.8",
          ...(referer ? { Referer: referer } : {})
        },
        redirect: "follow",
        signal: AbortSignal.timeout(20000)
      })
    );

    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: "Upstream image request failed." });
    }

    const contentType = upstream.headers.get("content-type") || "application/octet-stream";
    const buffer = Buffer.from(await upstream.arrayBuffer());
    if (!contentType.startsWith("image/")) {
      return res.status(502).json({ error: "Upstream did not return an image." });
    }
    writeImageCache(cacheKey, contentType, buffer);
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=3600");
    return res.send(buffer);
  } catch (error) {
    return res.status(502).json({ error: error.message || "Image proxy failed." });
  }
});

app.get("/api/news", async (req, res) => {
  const limit = Number.parseInt(req.query.limit, 10) || 80;
  const fresh = req.query.fresh === "1" || req.query.fresh === "true";
  const requestedSource = req.query.source;
  const sourcesToFetch = requestedSource
    ? SOURCES.filter((source) => source.name.toLowerCase() === requestedSource.toLowerCase())
    : SOURCES;

  if (sourcesToFetch.length === 0) {
    return res.status(400).json({ error: "Unknown source." });
  }

  const results = await Promise.all(
    sourcesToFetch.map((source) => fetchSourceCached(source, { fresh }))
  );

  const cap = Math.max(1, Math.min(limit, 250));
  const newsItems = results
    .flatMap((result) => result.items.filter((item) => item.kind !== "forum"))
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
    .slice(0, cap);
  // Forum/layoff posts are scraped separately; keep them out of the headline cap
  // so fast RSS feeds don't crowd out the layoff board.
  const forumItems = results
    .flatMap((result) => result.items.filter((item) => item.kind === "forum"))
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
  const items = [...newsItems, ...forumItems];

  res.json({
    fetchedAt: new Date().toISOString(),
    items,
    sourceStatus: results.map((result) => ({
      source: result.source,
      ok: result.ok,
      optional: !!result.optional,
      error: result.error || null
    }))
  });
});

const X_TRENDS_URL = "https://trends24.in/united-states/";
const X_TRENDS_CACHE_TTL_MS = 5 * 60 * 1000;
let xTrendsCache = null;

function xSearchUrl(topic) {
  return `https://x.com/search?q=${encodeURIComponent(topic)}&src=trend_click&f=live`;
}

function parseTrends24List($, listEl) {
  const trends = [];
  const seen = new Set();
  $(listEl)
    .find("ol li a.trend-link")
    .each((_, el) => {
      const name = $(el).text().replace(/\s+/g, " ").trim();
      if (!name) return;
      const key = name.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      const countText = $(el).closest(".trend-name").find(".tweet-count").attr("data-count") || "";
      trends.push({
        name,
        url: xSearchUrl(name),
        tweetCount: countText || null
      });
    });
  return trends;
}

async function fetchXTrendsFromTrends24() {
  const html = await fetchHtmlViaCurl(X_TRENDS_URL);
  if (!/trend-link|list-container/i.test(html)) {
    throw new Error("Could not parse X trends page.");
  }
  const $ = cheerio.load(html);
  const lists = $(".list-container")
    .toArray()
    .slice(0, 2)
    .map((el) => parseTrends24List($, el));
  const trending = lists[0] || [];
  if (!trending.length) {
    throw new Error("No X trends found.");
  }
  const previousNames = new Set((lists[1] || []).map((t) => t.name.toLowerCase()));
  const newlyRising = trending.filter((t) => !previousNames.has(t.name.toLowerCase()));
  const breaking = (newlyRising.length ? newlyRising : trending).slice(0, 8);

  return {
    ok: true,
    fetchedAt: new Date().toISOString(),
    location: "United States",
    source: "trends24.in",
    breaking,
    trending: trending.slice(0, 12)
  };
}

async function fetchXTrendsCached({ fresh = false } = {}) {
  if (!fresh && xTrendsCache && Date.now() - xTrendsCache.ts < X_TRENDS_CACHE_TTL_MS) {
    return xTrendsCache.result;
  }
  try {
    const result = await fetchXTrendsFromTrends24();
    xTrendsCache = { ts: Date.now(), result };
    return result;
  } catch (error) {
    if (xTrendsCache?.result?.ok) {
      return {
        ...xTrendsCache.result,
        stale: true,
        warning: error.message
      };
    }
    return {
      ok: false,
      fetchedAt: new Date().toISOString(),
      location: "United States",
      source: "trends24.in",
      breaking: [],
      trending: [],
      error: error.message
    };
  }
}

app.get("/api/x-trends", async (req, res) => {
  const fresh = req.query.fresh === "1" || req.query.fresh === "true";
  const data = await fetchXTrendsCached({ fresh });
  res.json(data);
});

app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Right News Aggregator running at http://localhost:${PORT}`);
});
