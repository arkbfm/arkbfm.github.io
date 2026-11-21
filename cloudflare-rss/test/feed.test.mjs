import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FeedError, rewriteItemLinks, scanFeed } from "../src/feed.js";
import { createResolver, parseEpisodeTitle } from "../src/episodes.js";
import { compareFeeds, parseFeed } from "../scripts/diff-feed.mjs";

const sample = readFileSync(new URL("./fixtures/sample.xml", import.meta.url), "utf8");
const pages = JSON.parse(readFileSync(new URL("./fixtures/episode-links.json", import.meta.url), "utf8"));
const SITE = "https://www.arkbfm.com/episode/";
const resolve = createResolver(pages, { siteBase: SITE });

const byGuid = items => Object.fromEntries(items.map(item => [item.guid, item]));

test("episode labels: numbers, bonus episodes, parts, guests and spacing", () => {
  assert.deepEqual(parseEpisodeTitle("Ep. 168 Think Outside the Output (シオン,あらB)"),
    { number: "168", part: null, label: "168", subtitle: "Think Outside the Output" });
  assert.equal(parseEpisodeTitle("Ep. 158.5-3 Look Back in Anger (モラズ,ムート,あらB)").label, "158.5-3");
  assert.equal(parseEpisodeTitle("Ep.69-1 Linear algebra behind complexity").label, "69-1");
  assert.equal(parseEpisodeTitle("Ep. 145 Anime Archive System Still Running (うっしー、あらB)").subtitle,
    "Anime Archive System Still Running");
  assert.equal(parseEpisodeTitle("Ep. 49 \"Season 2\"").subtitle, "\"Season 2\"");
  assert.equal(parseEpisodeTitle("Ep. 10 go_o2 Travel").label, "10");
  assert.equal(parseEpisodeTitle("Ep. 1680x"), null);
  assert.equal(parseEpisodeTitle("Trailer"), null);
});

test("links point at the site's own pages, and only pages it lists", () => {
  const { xml, items } = rewriteItemLinks(sample, resolve);
  const out = byGuid(items);
  assert.equal(out["44dad45e-6702-4977-8d08-688e56ae3a26"].link, "https://www.arkbfm.com/episode/168");
  assert.equal(out["guid-158.5-2"].link, "https://www.arkbfm.com/episode/158_5", "a part falls back to its episode page");
  assert.equal(out["guid-101.5"].link, "https://www.arkbfm.com/episode/101_5");
  assert.equal(out["guid-56-1"].link, "https://www.arkbfm.com/episode/56-1", "the URL comes from the site, not the number");
  assert.equal(out["guid-69-1"].link, "https://www.arkbfm.com/episode/69-1");
  assert.match(xml, /<link>https:\/\/www\.arkbfm\.com\/episode\/168<\/link>/);
  assert.doesNotMatch(xml, /evil\.example\/episode/, "site entries outside SITE_BASE_URL are ignored");
});

test("unmatched items keep their Spotify link", () => {
  const { xml, items } = rewriteItemLinks(sample, resolve);
  const out = byGuid(items);
  for (const guid of ["guid-169", "guid-63", "guid-trailer"]) {
    assert.equal(out[guid].changed, false, guid);
    assert.equal(out[guid].link, out[guid].original, guid);
    assert.ok(out[guid].reason, guid);
  }
  assert.match(out["guid-169"].reason, /no site page for Ep\. 169/);
  assert.match(out["guid-63"].reason, /subtitle differs/);
  assert.match(xml, /<link>https:\/\/podcasters\.spotify\.com\/pod\/show\/arkbfm\/episodes\/Ep--169-e1<\/link>/);
});

test("nothing but item links changes: GUIDs, enclosures, dates, CDATA, namespaces, channel", () => {
  const { xml } = rewriteItemLinks(sample, resolve);
  const { errors, links, items } = compareFeeds(sample, xml);
  assert.deepEqual(errors, []);
  assert.equal(items, 8);
  assert.equal(links.length, 5);
  assert.ok(links.every(link => link.to.startsWith(SITE)));
  // The parts the parser cannot see are also untouched: the declaration, namespaces and CDATA markers.
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?><rss xmlns:dc='));
  assert.equal(xml.split("<![CDATA[").length, sample.split("<![CDATA[").length);
  assert.ok(xml.includes("<link>https://arkbfm.com</link>"), "the channel link stays");
  assert.ok(xml.includes("<link>https://inside.cdata</link>"), "text inside CDATA is not a tag");
  assert.ok(xml.includes("<item><link>https://evil.example</link></item> inside -->"), "comments are skipped");
  assert.ok(xml.includes('<atom:link href="https://example.com/item-atom-link"'), "namespaced links are left alone");
  const strip = s => s.replace(/<link>[^<]*<\/link>|<link\/>/g, "");
  assert.equal(strip(xml), strip(sample), "outside <link> the bytes are identical");
});

test("the rewritten feed parses as XML and a missing <link> is added inside its item", () => {
  const { xml } = rewriteItemLinks(sample, resolve);
  parseFeed(xml);
  assert.match(xml, /<enclosure url="https:\/\/example\.com\/56-1\.mp3" length="1" type="audio\/mpeg"\/>\n\t\t<link>https:\/\/www\.arkbfm\.com\/episode\/56-1<\/link><\/item>/);
});

test("URLs are escaped as XML text", () => {
  const { xml } = rewriteItemLinks(sample, () => ({ url: "https://www.arkbfm.com/episode/1?a=1&b=<2>" }));
  assert.ok(xml.includes("<link>https://www.arkbfm.com/episode/1?a=1&amp;b=&lt;2&gt;</link>"));
  assert.deepEqual(compareFeeds(sample, xml).errors, []);
});

test("titles are read from CDATA and from escaped text", () => {
  const titles = scanFeed(new TextEncoder().encode(sample)).map(item => item.title);
  assert.ok(titles.includes("Ep. 101.5 This is a Bonus Episode & more"));
  assert.ok(titles.includes("Ep. 168 Think Outside the Output (シオン,あらB)"));
});

test("a broken or truncated feed is rejected, never passed on", () => {
  const cut = sample.slice(0, sample.indexOf("</channel>"));
  assert.throws(() => rewriteItemLinks(cut, resolve), FeedError);
  assert.throws(() => rewriteItemLinks(sample.replace("</guid>", "</gid>"), resolve), FeedError);
  assert.throws(() => rewriteItemLinks(sample.replace("]]></description>", "</description>"), resolve), FeedError);
  assert.throws(() => rewriteItemLinks("<html><body>Error</body></html>", resolve), /not <rss>/);
  assert.throws(() => rewriteItemLinks("", resolve), FeedError);
});

test("bytes in, bytes out: the same bytes as the string version", () => {
  const bytes = new TextEncoder().encode(sample);
  const fromBytes = rewriteItemLinks(bytes, resolve).xml;
  assert.ok(fromBytes instanceof Uint8Array);
  assert.equal(new TextDecoder().decode(fromBytes), rewriteItemLinks(sample, resolve).xml);
  // Bytes the Worker does not read (here, inside a description) pass through even when they are not valid UTF-8.
  const at = new TextEncoder().encode(sample.slice(0, sample.indexOf("Part 2]]>"))).length;
  const odd = Uint8Array.of(...bytes.subarray(0, at), 0xff, ...bytes.subarray(at));
  const out = rewriteItemLinks(odd, resolve).xml;
  assert.equal(out.length, fromBytes.length + 1);
  assert.ok(out.includes(0xff));
});

test("an item with two links is left alone", () => {
  const doubled = sample.replace("<guid isPermaLink=\"false\">guid-63</guid>",
    "<link>https://second.example</link><guid isPermaLink=\"false\">guid-63</guid>");
  const { items } = rewriteItemLinks(doubled, () => ({ url: "https://www.arkbfm.com/episode/63" }));
  assert.equal(byGuid(items)["guid-63"].changed, false);
});

test("overrides by GUID set a link or keep the original", () => {
  const custom = createResolver(pages, {
    siteBase: SITE,
    overrides: { "guid-169": "https://www.arkbfm.com/episode/special", "44dad45e-6702-4977-8d08-688e56ae3a26": null },
  });
  const out = byGuid(rewriteItemLinks(sample, custom).items);
  assert.equal(out["guid-169"].link, "https://www.arkbfm.com/episode/special");
  assert.equal(out["44dad45e-6702-4977-8d08-688e56ae3a26"].changed, false);
});

test("two site pages with the same label are not guessed between", () => {
  const twice = [...pages, { title: "Ep. 168 Think Outside the Output", url: "/episode/168-copy" }];
  const out = byGuid(rewriteItemLinks(sample, createResolver(twice, { siteBase: SITE })).items);
  assert.match(out["44dad45e-6702-4977-8d08-688e56ae3a26"].reason, /several site pages/);
});

test("the diff check itself catches changes outside the links", () => {
  const { xml } = rewriteItemLinks(sample, resolve);
  const changed = [
    xml.replace("guid-101.5", "guid-101.6"),
    xml.replace('url="https://example.com/63.mp3"', 'url="https://example.com/64.mp3"'),
    xml.replace('length="113684981"', 'length="1"'),
    xml.replace("Tue, 01 Jan 2022 10:00:00 GMT", "Tue, 01 Jan 2022 10:00:01 GMT"),
    xml.replace("<![CDATA[Part 2]]>", "Part 2"),
    xml.replace("<itunes:season>1</itunes:season>", ""),
    xml.replace("<link>https://arkbfm.com</link>", "<link>https://www.arkbfm.com</link>"),
    xml.replace(' xmlns:podcast="https://podcastindex.org/namespace/1.0"', ""),
    xml.replace(/<item>[\s\S]*?<\/item>\s*/, ""),
  ];
  for (const [i, doc] of changed.entries()) {
    assert.notEqual(doc, xml, `case ${i} must change the document`);
    assert.ok(compareFeeds(sample, doc).errors.length > 0, `case ${i} must be reported`);
  }
});
