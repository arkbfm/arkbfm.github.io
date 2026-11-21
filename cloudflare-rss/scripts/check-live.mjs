// Runs the Worker's rewrite against the live Spotify feed and checks the result, without deploying anything.
//
//   node scripts/check-live.mjs [--feed <file|URL>] [--site <file|URL>] [--out <dir>]
//
// --feed  defaults to SOURCE_FEED_URL in wrangler.jsonc
// --site  defaults to SITE_INDEX_URL in wrangler.jsonc; when that is not published yet (404), the same list is built
//         from ../_posts (title from the front matter, URL /episode/<slug> as in the site's permalink setting)
// --out   where original.xml and rewritten.xml are written (default: out/)
//
// Prints which items keep their Spotify link and why, checks that nothing except item links changed (with the
// same XML-parser comparison as scripts/diff-feed.mjs), and times the rewrite as a guide to Workers CPU time.

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { rewriteItemLinks } from "../src/feed.js";
import { createResolver } from "../src/episodes.js";
import { compareFeeds } from "./diff-feed.mjs";

const root = new URL("..", import.meta.url).pathname;
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, arg, i, all) => {
  if (arg.startsWith("--")) pairs.push([arg.slice(2), all[i + 1]]);
  return pairs;
}, []));

const config = await readFile(join(root, "wrangler.jsonc"), "utf8");
const vars = JSON.parse(config.replace(/^\s*\/\/.*$/gm, "")).vars;

async function load(location) {
  if (/^https?:\/\//.test(location)) {
    const response = await fetch(location, { headers: { "user-agent": "arkbfm-rss check" } });
    return { status: response.status, text: response.ok ? await response.text() : null };
  }
  return { status: 200, text: await readFile(location, "utf8") };
}

async function loadBytes(location) {
  if (/^https?:\/\//.test(location)) {
    const response = await fetch(location, { headers: { "user-agent": "arkbfm-rss check" } });
    if (!response.ok) throw new Error(`feed answered ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }
  return new Uint8Array(await readFile(location));
}

async function pagesFromPosts() {
  const dir = join(root, "..", "_posts");
  const pages = [];
  for (const name of await readdir(dir)) {
    const m = /^\d{4}-\d{2}-\d{2}-(.+)\.md$/.exec(name);
    if (!m) continue;
    const text = await readFile(join(dir, name), "utf8");
    const title = /^title:\s*(.*?)\s*$/m.exec(text)?.[1];
    if (title) pages.push({ title, url: `/episode/${m[1]}` });
  }
  return pages;
}

const feedBytes = await loadBytes(args.feed ?? vars.SOURCE_FEED_URL);
const feed = { text: new TextDecoder().decode(feedBytes) };
const site = await load(args.site ?? vars.SITE_INDEX_URL);
let pages;
if (site.text) {
  pages = JSON.parse(site.text);
  console.log(`site index: ${args.site ?? vars.SITE_INDEX_URL} (${pages.length} pages)`);
} else {
  pages = await pagesFromPosts();
  console.log(`site index: ${vars.SITE_INDEX_URL} answered ${site.status}; built from ../_posts instead (${pages.length} pages)`);
}

const resolve = createResolver(pages, { siteBase: vars.SITE_BASE_URL, overrides: vars.LINK_OVERRIDES ?? {} });
rewriteItemLinks(feedBytes, resolve);  // warm up (bytes in and out, as in the Worker)
const runs = 5;
const started = performance.now();
let result;
for (let i = 0; i < runs; i += 1) result = rewriteItemLinks(feedBytes, resolve);
const ms = (performance.now() - started) / runs;

const { items } = result;
const xml = new TextDecoder().decode(result.xml);
const kept = items.filter(item => item.reason);
const pagesUsed = new Set(items.filter(item => !item.reason).map(item => item.link));
console.log(`feed: ${(feedBytes.length / 1e6).toFixed(2)} MB, ${items.length} items`);
console.log(`linked to the site: ${items.length - kept.length}, kept the Spotify link: ${kept.length}`);
for (const item of kept) console.log(`  kept  ${item.title}  (${item.reason})`);
console.log(`site pages linked: ${pagesUsed.size} of ${pages.length}`);
console.log(`rewrite: ${ms.toFixed(1)} ms per run on this machine`);

const { errors, links } = compareFeeds(feed.text, xml);
console.log(`XML comparison: ${links.length} item links changed, ${errors.length} other differences`);
for (const error of errors.slice(0, 20)) console.log(`  DIFF  ${error}`);

const out = join(root, args.out ?? "out");
await mkdir(out, { recursive: true });
await writeFile(join(out, "original.xml"), feed.text);
await writeFile(join(out, "rewritten.xml"), result.xml);
console.log(`written: ${join(out, "original.xml")}, ${join(out, "rewritten.xml")}`);
process.exit(errors.length ? 1 : 0);
