import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../src/worker.js";

const sample = readFileSync(new URL("./fixtures/sample.xml", import.meta.url), "utf8");
const pages = readFileSync(new URL("./fixtures/episode-links.json", import.meta.url), "utf8");
const env = {
  SOURCE_FEED_URL: "https://anchor.fm/s/319a2820/podcast/rss",
  SITE_INDEX_URL: "https://www.arkbfm.com/episode-links.json",
  SITE_BASE_URL: "https://www.arkbfm.com/episode/",
  REFRESH_SECONDS: "900",
  LINK_OVERRIDES: {},
};

class MemoryCache {
  constructor() { this.entries = new Map(); }
  async match(request) {
    const hit = this.entries.get(request.url);
    return hit ? new Response(hit.body, { headers: hit.headers }) : undefined;
  }
  async put(request, response) {
    this.entries.set(request.url, { body: await response.arrayBuffer(), headers: [...response.headers] });
  }
  age(seconds) {  // pretend the stored feed was built `seconds` ago
    const feed = this.entries.get("https://arkbfm-rss.internal/v1/feed");
    feed.headers = feed.headers.map(([k, v]) => [k, k === "x-built-at" ? new Date(Date.now() - seconds * 1000).toISOString() : v]);
  }
}

function upstream(routes) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push(String(url));
    calls.conditional = (calls.conditional ?? 0) + (init.headers?.["if-none-match"] ? 1 : 0);
    const route = routes[String(url)];
    if (!route) throw new Error(`unexpected fetch ${url}`);
    if (route instanceof Error) throw route;
    return typeof route === "function" ? route() : new Response(route.body, { status: route.status ?? 200 });
  };
  return calls;
}

const ok = { [env.SOURCE_FEED_URL]: { body: sample }, [env.SITE_INDEX_URL]: { body: pages } };

function context() {
  const pending = [];
  return { pending, waitUntil: p => pending.push(p), settle: () => Promise.all(pending) };
}

const get = (path = "/", init) => new Request(`https://rss.arkbfm.com${path}`, init);

test("serves the rewritten feed with XML headers and an ETag", async () => {
  upstream(ok);
  const response = await worker.fetch(get(), env, context(), new MemoryCache());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/rss+xml; charset=utf-8");
  assert.match(response.headers.get("etag"), /^"[0-9a-f]{32}"$/);
  const body = await response.text();
  assert.match(body, /<link>https:\/\/www\.arkbfm\.com\/episode\/168<\/link>/);
  assert.equal(body.match(/<item>\n/g).length, 8);  // the fixture also has "<item>" inside a comment
});

test("a fresh cached feed is served without fetching; If-None-Match gives 304; HEAD has no body", async () => {
  const cache = new MemoryCache();
  upstream(ok);
  const first = await worker.fetch(get(), env, context(), cache);
  const etag = first.headers.get("etag");
  const calls = upstream({});
  const again = await worker.fetch(get(), env, context(), cache);
  assert.equal(again.status, 200);
  assert.equal(await again.text(), await first.text());
  assert.deepEqual(calls, []);
  const notModified = await worker.fetch(get("/", { headers: { "if-none-match": etag } }), env, context(), cache);
  assert.equal(notModified.status, 304);
  const head = await worker.fetch(get("/", { method: "HEAD" }), env, context(), cache);
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
});

test("a stale feed is served at once and rebuilt in the background with new episodes", async () => {
  const cache = new MemoryCache();
  upstream(ok);
  await worker.fetch(get(), env, context(), cache);
  cache.age(1000);
  const newer = sample.replace("<item>\n", `<item>
			<title><![CDATA[Ep. 170 Later On (ゲスト,あらB)]]></title>
			<link>https://podcasters.spotify.com/pod/show/arkbfm/episodes/Ep--170</link>
			<guid isPermaLink="false">guid-170</guid>
			<pubDate>Mon, 30 Nov 2026 17:18:49 GMT</pubDate>
			<enclosure url="https://example.com/170.mp3" length="1" type="audio/mpeg"/>
		</item>
		<item>\n`);
  const morePages = JSON.stringify([...JSON.parse(pages), { title: "Ep. 170 Later On (ゲスト,あらB)", url: "/episode/170" }]);
  upstream({ [env.SOURCE_FEED_URL]: { body: newer }, [env.SITE_INDEX_URL]: { body: morePages } });
  const ctx = context();
  const stale = await worker.fetch(get(), env, ctx, cache);
  assert.doesNotMatch(await stale.text(), /guid-170/);
  await ctx.settle();
  const fresh = await (await worker.fetch(get(), env, context(), cache)).text();
  assert.match(fresh, /<link>https:\/\/www\.arkbfm\.com\/episode\/170<\/link>\n\t\t\t<guid isPermaLink="false">guid-170/);
});

test("when Spotify fails and nothing is cached, the answer is 503, never a partial feed", async () => {
  for (const failure of [
    { [env.SOURCE_FEED_URL]: { status: 500, body: "oops" } },
    { [env.SOURCE_FEED_URL]: new Error("timeout") },
    { [env.SOURCE_FEED_URL]: { body: sample.slice(0, 2000) } },
    { [env.SOURCE_FEED_URL]: { body: "<html>maintenance</html>" } },
  ]) {
    upstream({ ...ok, ...failure });
    const response = await worker.fetch(get(), env, context(), new MemoryCache());
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("retry-after"), "300");
    assert.doesNotMatch(await response.text(), /<rss/);
  }
});

test("when a rebuild fails, the last good feed keeps being served", async () => {
  const cache = new MemoryCache();
  upstream(ok);
  const good = await (await worker.fetch(get(), env, context(), cache)).text();
  for (const failure of [
    { [env.SOURCE_FEED_URL]: { body: sample.slice(0, 5000) } },
    { [env.SOURCE_FEED_URL]: { body: sample.replace(/<item>[\s\S]*<\/item>/, "<item><title>Ep. 1 x</title></item>") } },
  ]) {
    cache.age(1000);
    upstream({ ...ok, ...failure });
    const ctx = context();
    assert.equal(await (await worker.fetch(get(), env, ctx, cache)).text(), good);
    await ctx.settle();
    cache.age(0);
    assert.equal(await (await worker.fetch(get(), env, context(), cache)).text(), good);
  }
});

test("when the site index is down, the cached copy of it is used", async () => {
  const cache = new MemoryCache();
  upstream(ok);
  await worker.fetch(get(), env, context(), cache);
  cache.age(1000);
  upstream({ [env.SOURCE_FEED_URL]: { body: sample }, [env.SITE_INDEX_URL]: { status: 404, body: "" } });
  const ctx = context();
  await worker.fetch(get(), env, ctx, cache);
  await ctx.settle();
  const status = await (await worker.fetch(get("/status"), env, context(), cache)).json();
  assert.equal(status.siteIndex, "cache");
  assert.equal(status.linkedToSite, 5);
});

test("with no site index at all, the feed is served with its original links", async () => {
  upstream({ [env.SOURCE_FEED_URL]: { body: sample }, [env.SITE_INDEX_URL]: { status: 404, body: "" } });
  const cache = new MemoryCache();
  const body = await (await worker.fetch(get(), env, context(), cache)).text();
  assert.equal(body, sample);
});

test("/status lists the links that were kept and why", async () => {
  upstream(ok);
  const cache = new MemoryCache();
  await worker.fetch(get(), env, context(), cache);
  const status = await (await worker.fetch(get("/status"), env, context(), cache)).json();
  assert.equal(status.items, 8);
  assert.equal(status.linkedToSite, 5);
  assert.deepEqual(status.keptOriginal.map(item => item.guid).sort(), ["guid-169", "guid-63", "guid-trailer"]);
});

test("only GET and HEAD on known paths; query strings cannot choose what is fetched", async () => {
  const calls = upstream(ok);
  assert.equal((await worker.fetch(get("/", { method: "POST" }), env, context(), new MemoryCache())).status, 405);
  assert.equal((await worker.fetch(get("/https://evil.example/"), env, context(), new MemoryCache())).status, 404);
  await worker.fetch(get("/?url=https://evil.example/&src=x"), env, context(), new MemoryCache());
  assert.deepEqual([...new Set(calls)].sort(), [env.SITE_INDEX_URL, env.SOURCE_FEED_URL].sort());
});

test("when neither Spotify nor the site changed, the rewrite is skipped (304 from Spotify)", async () => {
  const cache = new MemoryCache();
  const etagged = () => new Response(sample, { headers: { etag: 'W/"v1"' } });
  upstream({ [env.SOURCE_FEED_URL]: etagged, [env.SITE_INDEX_URL]: { body: pages } });
  const first = await (await worker.fetch(get(), env, context(), cache)).text();
  cache.age(1000);
  let asked = null;
  upstream({
    [env.SOURCE_FEED_URL]: () => { throw new Error("must be conditional"); },
    [env.SITE_INDEX_URL]: { body: pages },
  });
  globalThis.fetch = async (url, init = {}) => {
    if (String(url) === env.SITE_INDEX_URL) return new Response(pages);
    asked = init.headers["if-none-match"];
    return new Response(null, { status: 304 });
  };
  const ctx = context();
  await worker.fetch(get(), env, ctx, cache);
  await ctx.settle();
  assert.equal(asked, 'W/"v1"');
  const status = await (await worker.fetch(get("/status"), env, context(), cache)).json();
  assert.equal(status.unchanged, true);
  const again = await worker.fetch(get(), env, context(), cache);
  assert.equal(await again.text(), first);
  assert.equal(await (await worker.fetch(get("/status"), env, context(), cache)).json().then(s => s.unchanged), true);
});

test("when only the site changed, the stored Spotify feed is rewritten again", async () => {
  const cache = new MemoryCache();
  upstream({ [env.SOURCE_FEED_URL]: () => new Response(sample, { headers: { etag: '"v1"' } }), [env.SITE_INDEX_URL]: { body: pages } });
  const before = await (await worker.fetch(get(), env, context(), cache)).text();
  assert.match(before, /Ep--169-e1<\/link>/);
  cache.age(1000);
  const withNewPage = JSON.stringify([...JSON.parse(pages), { title: "Ep. 169 Brand New (ゲスト,あらB)", url: "/episode/169" }]);
  globalThis.fetch = async (url) => (String(url) === env.SITE_INDEX_URL ? new Response(withNewPage) : new Response(null, { status: 304 }));
  const ctx = context();
  await worker.fetch(get(), env, ctx, cache);
  await ctx.settle();
  const after = await (await worker.fetch(get(), env, context(), cache)).text();
  assert.match(after, /<link>https:\/\/www\.arkbfm\.com\/episode\/169<\/link>/);
  assert.equal(after.length, before.length - "https://podcasters.spotify.com/pod/show/arkbfm/episodes/Ep--169-e1".length + "https://www.arkbfm.com/episode/169".length);
});
