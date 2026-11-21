// The あらB.fm feed for Apple Podcasts: the Spotify for Creators feed with each episode's <link> pointed at its
// page on www.arkbfm.com. Everything else in the feed is passed through byte for byte.
//
// GET /         the feed (also HEAD, with ETag / If-None-Match)
// GET /status   what the last build did: item counts and every item whose link was left as it was, and why
//
// The Worker only ever fetches the two URLs set in its configuration (SOURCE_FEED_URL, SITE_INDEX_URL); nothing in a
// request can change what it fetches. A built feed is kept in the Cache API: it is served as is for REFRESH_SECONDS,
// after that it is still served while a rebuild runs in the background, and a failed rebuild keeps the last good
// feed. Only when there is no feed at all does a failure reach the client, as a 503 (never a partial feed).

import { FeedError, rewriteItemLinks } from "./feed.js";
import { createResolver } from "./episodes.js";

const CACHE_PREFIX = "https://arkbfm-rss.internal/v1/";
const KEEP_SECONDS = 30 * 24 * 3600;   // how long the Cache API may hold the last good copy

function settings(env) {
  const number = (value, fallback) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback);
  let overrides = env.LINK_OVERRIDES ?? {};
  if (typeof overrides === "string") overrides = overrides.trim() ? JSON.parse(overrides) : {};
  return {
    sourceUrl: env.SOURCE_FEED_URL,
    siteIndexUrl: env.SITE_INDEX_URL,
    siteBase: env.SITE_BASE_URL,
    overrides,
    refreshSeconds: number(env.REFRESH_SECONDS, 900),
    timeoutMs: number(env.FETCH_TIMEOUT_MS, 15000),
    maxBytes: number(env.MAX_FEED_BYTES, 20 * 1024 * 1024),
  };
}

function log(level, event, data = {}) {
  console[level === "error" ? "error" : "log"](JSON.stringify({ event, ...data }));
}

// Returns { bytes, etag }, or { notModified: true } when `ifNoneMatch` is given and the origin answers 304.
async function fetchBytes(url, { timeoutMs, maxBytes, accept, ifNoneMatch }) {
  const headers = { accept, "user-agent": "arkbfm-rss (Cloudflare Worker)" };
  if (ifNoneMatch) headers["if-none-match"] = ifNoneMatch;
  const response = await fetch(url, {
    headers,
    cache: "no-store",
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (ifNoneMatch && response.status === 304) return { notModified: true };
  if (!response.ok) throw new FeedError(`${url} answered ${response.status}`);
  const length = Number(response.headers.get("content-length"));
  if (length > maxBytes) throw new FeedError(`${url} is ${length} bytes, over the ${maxBytes} byte limit`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > maxBytes) throw new FeedError(`${url} is over the ${maxBytes} byte limit`);
  return { bytes, etag: response.headers.get("etag") };
}

async function sha256(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].slice(0, 16).map(b => b.toString(16).padStart(2, "0")).join("");
}

const cacheKey = name => new Request(CACHE_PREFIX + name);

async function readCached(cache, name) {
  const response = await cache.match(cacheKey(name));
  return response ?? null;
}

async function writeCached(cache, name, body, headers) {
  await cache.put(cacheKey(name), new Response(body, {
    headers: { ...headers, "cache-control": `public, max-age=${KEEP_SECONDS}` },
  }));
}

async function loadSiteIndex(env, cache, config) {
  try {
    const { bytes } = await fetchBytes(config.siteIndexUrl, { ...config, maxBytes: 2 * 1024 * 1024, accept: "application/json" });
    const pages = JSON.parse(new TextDecoder().decode(bytes));
    if (!Array.isArray(pages) || !pages.length) throw new FeedError("site index is empty");
    await writeCached(cache, "site-index", bytes, { "content-type": "application/json" });
    return { pages, from: "site", key: await sha256(bytes) };
  } catch (error) {
    const cached = await readCached(cache, "site-index");
    log("error", "site_index_failed", { error: String(error), fallback: cached ? "cached" : "none" });
    if (cached) {
      const bytes = new Uint8Array(await cached.arrayBuffer());
      return { pages: JSON.parse(new TextDecoder().decode(bytes)), from: "cache", key: await sha256(bytes) };
    }
    return { pages: null, from: "none", key: null };
  }
}

// Builds the feed and stores it. Throws when there is nothing safe to store.
//
// The rewrite is the only CPU-heavy step, so it is skipped when nothing has changed: Spotify is asked with the
// ETag of the last feed it sent (a 304 costs nothing) and the site's page list is compared by hash. When both are
// unchanged the stored feed is only marked as fresh again. A copy of Spotify's feed is kept for the case where
// only the site changed.
export async function rebuild(env, cache = caches.default) {
  const started = Date.now();
  const config = settings(env);
  if (!config.sourceUrl || !config.siteIndexUrl || !config.siteBase) throw new FeedError("missing configuration");
  const [previous, storedSource, storedFeed] = await Promise.all([
    readCached(cache, "status").then(r => (r ? r.json() : null)),
    readCached(cache, "source"),
    readCached(cache, "feed"),
  ]);
  const sourceEtag = storedSource?.headers.get("x-source-etag") || null;
  const [fetched, site] = await Promise.all([
    fetchBytes(config.sourceUrl, {
      ...config,
      accept: "application/rss+xml, application/xml;q=0.9",
      ifNoneMatch: storedSource && storedFeed ? sourceEtag : null,
    }),
    loadSiteIndex(env, cache, config),
  ]);
  if (fetched.notModified && previous && site.key && site.key === previous.siteIndexKey) {
    const builtAt = new Date().toISOString();
    const status = { ...previous, builtAt, siteIndex: site.from, unchanged: true, durationMs: Date.now() - started };
    await Promise.all([
      writeCached(cache, "feed", storedFeed.body, {
        ...Object.fromEntries([...storedFeed.headers].filter(([name]) => name !== "content-length")),
        "x-built-at": builtAt,
      }),
      writeCached(cache, "status", JSON.stringify(status), { "content-type": "application/json" }),
    ]);
    log("info", "feed_unchanged", { builtAt, etag: previous.etag });
    return { xml: null, status };
  }
  const source = fetched.notModified ? new Uint8Array(await storedSource.arrayBuffer()) : fetched.bytes;
  if (!site.pages && previous) {
    // Without the site's page list every link would fall back to Spotify; keep the last good feed instead.
    throw new FeedError("site index unavailable; keeping the last good feed");
  }
  const resolve = site.pages
    ? createResolver(site.pages, { siteBase: config.siteBase, overrides: config.overrides })
    : () => ({ reason: "site index unavailable" });
  const { xml, items } = rewriteItemLinks(source, resolve);
  if (!items.length) throw new FeedError("source feed has no episodes");
  if (previous && items.length < previous.items / 2) {
    throw new FeedError(`source feed has ${items.length} episodes, down from ${previous.items}; keeping the last good feed`);
  }
  const builtAt = new Date();
  const etag = `"${await sha256(xml)}"`;
  const lastModified = previous?.etag === etag ? previous.lastModified : builtAt.toUTCString();
  const kept = items.filter(item => item.reason);
  const sourceTag = fetched.notModified ? sourceEtag : fetched.etag;
  const status = {
    builtAt: builtAt.toISOString(),
    lastModified,
    etag,
    source: config.sourceUrl,
    siteIndex: site.from,
    siteIndexKey: site.key,
    unchanged: false,
    items: items.length,
    linkedToSite: items.length - kept.length,
    keptOriginal: kept.map(({ guid, title, reason }) => ({ guid, title, reason })),
    durationMs: Date.now() - started,
  };
  await Promise.all([
    writeCached(cache, "feed", xml, {
      "content-type": "application/rss+xml; charset=utf-8",
      etag,
      "last-modified": lastModified,
      "x-built-at": status.builtAt,
    }),
    writeCached(cache, "status", JSON.stringify(status), { "content-type": "application/json" }),
    fetched.notModified ? null : writeCached(cache, "source", source, {
      "content-type": "application/xml",
      ...(sourceTag ? { "x-source-etag": sourceTag } : {}),
    }),
  ]);
  log("info", "feed_built", { ...status, keptOriginal: status.keptOriginal.length });
  for (const item of status.keptOriginal) log("info", "link_kept", item);
  return { xml, status };
}

function feedResponse(request, body, headers) {
  const out = new Headers({
    "content-type": "application/rss+xml; charset=utf-8",
    "cache-control": "public, max-age=300",
    "x-content-type-options": "nosniff",
  });
  for (const name of ["etag", "last-modified"]) if (headers.get(name)) out.set(name, headers.get(name));
  const tag = headers.get("etag");
  const match = request.headers.get("if-none-match");
  if (tag && match && match.split(",").some(t => t.trim().replace(/^W\//, "") === tag)) {
    return new Response(null, { status: 304, headers: out });
  }
  return new Response(request.method === "HEAD" ? null : body, { headers: out });
}

// One rebuild at a time per isolate, so a burst of requests for a stale feed starts only one.
let inFlight = null;
function rebuildOnce(env, cache) {
  inFlight ??= rebuild(env, cache).finally(() => { inFlight = null; });
  return inFlight;
}

async function serveFeed(request, env, ctx, cache) {
  const config = settings(env);
  const cached = await readCached(cache, "feed");
  if (cached) {
    const age = (Date.now() - Date.parse(cached.headers.get("x-built-at"))) / 1000;
    if (!(age < config.refreshSeconds)) {
      ctx.waitUntil(rebuildOnce(env, cache).catch(error => log("error", "rebuild_failed", { error: String(error) })));
    }
    return feedResponse(request, cached.body, cached.headers);
  }
  try {
    const { xml, status } = await rebuildOnce(env, cache);
    if (!xml) {
      // Another request stored the feed in the meantime and this rebuild found nothing new: serve what it stored.
      const stored = await readCached(cache, "feed");
      if (!stored) throw new FeedError("feed missing from the cache after an unchanged rebuild");
      return feedResponse(request, stored.body, stored.headers);
    }
    return feedResponse(request, xml, new Headers({ etag: status.etag, "last-modified": status.lastModified }));
  } catch (error) {
    log("error", "build_failed", { error: String(error) });
    return new Response("The feed is temporarily unavailable.\n", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8", "retry-after": "300", "cache-control": "no-store" },
    });
  }
}

export default {
  async fetch(request, env, ctx, cache = caches.default) {
    const { pathname } = new URL(request.url);
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed\n", { status: 405, headers: { allow: "GET, HEAD" } });
    }
    if (pathname === "/") return serveFeed(request, env, ctx, cache);
    if (pathname === "/status") {
      const cached = await readCached(cache, "status");
      return new Response(cached ? await cached.text() : JSON.stringify({ built: false }), {
        status: cached ? 200 : 404,
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
      });
    }
    return new Response("Not found\n", { status: 404 });
  },
};
