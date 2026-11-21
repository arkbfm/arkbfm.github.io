// Compares two RSS documents with a real XML parser and reports every difference except the text of
// <rss><channel><item><link>. Exits non-zero when anything else differs or either document is not well-formed.
//
//   node scripts/diff-feed.mjs <original.xml|URL> <rewritten.xml|URL>
//
// Comments, CDATA sections, attributes, whitespace text and element order all count as content, so this is close
// to a byte comparison outside the links. Item links are listed as changes, not errors.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { XMLParser, XMLValidator } from "fast-xml-parser";

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  allowBooleanAttributes: true,
  cdataPropName: "#cdata",
  commentPropName: "#comment",
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
  // The feed escapes its HTML summaries, so it has far more entities than the parser's anti-abuse defaults allow.
  processEntities: { enabled: true, maxTotalExpansions: Infinity, maxExpandedLength: Infinity },
  htmlEntities: false,
  ignoreDeclaration: false,
  ignorePiTags: false,
});

const nameOf = node => Object.keys(node).find(key => key !== ":@");

export function parseFeed(xml, label = "document") {
  const valid = XMLValidator.validate(xml, { allowBooleanAttributes: true });
  if (valid !== true) {
    const { code, msg, line, col } = valid.err;
    throw new Error(`${label} is not well-formed XML: ${code} ${msg} (line ${line}, column ${col})`);
  }
  return parser.parse(xml);
}

function textOf(nodes) {
  return nodes.map(node => {
    const name = nameOf(node);
    if (name === "#text") return node[name];
    if (name === "#cdata") return textOf(node[name]);
    return "";
  }).join("").trim();
}

function child(nodes, name) {
  return nodes.find(node => nameOf(node) === name)?.[name] ?? [];
}

function compareNodes(a, b, path, errors) {
  if (a.length !== b.length) {
    errors.push(`${path}: ${a.length} child nodes became ${b.length}`);
    return;
  }
  for (let i = 0; i < a.length; i += 1) {
    const nameA = nameOf(a[i]);
    const nameB = nameOf(b[i]);
    const here = `${path}/${nameA}[${i}]`;
    if (nameA !== nameB) {
      errors.push(`${here}: became <${nameB}>`);
      continue;
    }
    const attrsA = JSON.stringify(a[i][":@"] ?? {});
    const attrsB = JSON.stringify(b[i][":@"] ?? {});
    if (attrsA !== attrsB) errors.push(`${here}: attributes ${attrsA} became ${attrsB}`);
    const valueA = a[i][nameA];
    const valueB = b[i][nameB];
    if (Array.isArray(valueA) && Array.isArray(valueB)) compareNodes(valueA, valueB, here, errors);
    else if (valueA !== valueB) errors.push(`${here}: ${JSON.stringify(valueA)} became ${JSON.stringify(valueB)}`);
  }
}

// Returns { errors: [...], links: [{ guid, title, from, to }], items }.
export function compareFeeds(originalXml, rewrittenXml) {
  const a = parseFeed(originalXml, "original");
  const b = parseFeed(rewrittenXml, "rewritten");
  const errors = [];
  const links = [];
  const channelA = child(child(a, "rss"), "channel");
  const channelB = child(child(b, "rss"), "channel");
  if (!channelA.length || !channelB.length) errors.push("missing <rss><channel>");
  // Set each item's direct <link> children aside, then require everything else to be identical.
  const strip = (channel, side) => channel.map(node => {
    if (nameOf(node) !== "item") return node;
    const kids = node.item;
    side.push({
      guid: textOf(child(kids, "guid")),
      title: textOf(child(kids, "title")),
      links: kids.filter(k => nameOf(k) === "link").map(k => textOf(k.link)),
    });
    return { ...node, item: kids.filter(k => nameOf(k) !== "link") };
  });
  const itemsA = [];
  const itemsB = [];
  compareNodes(strip(channelA, itemsA), strip(channelB, itemsB), "/rss/channel", errors);
  compareNodes(
    child(a, "rss").filter(n => nameOf(n) !== "channel"),
    child(b, "rss").filter(n => nameOf(n) !== "channel"),
    "/rss", errors,
  );
  compareNodes(a.filter(n => nameOf(n) !== "rss"), b.filter(n => nameOf(n) !== "rss"), "/", errors);
  const rootAttrs = doc => JSON.stringify(doc.find(n => nameOf(n) === "rss")?.[":@"] ?? {});
  if (rootAttrs(a) !== rootAttrs(b)) errors.push(`/rss attributes ${rootAttrs(a)} became ${rootAttrs(b)}`);
  if (itemsA.length !== itemsB.length) errors.push(`${itemsA.length} items became ${itemsB.length}`);
  itemsA.forEach((item, i) => {
    const after = itemsB[i];
    if (!after) return;
    if (item.links.length > 1 || after.links.length > 1) {
      if (JSON.stringify(item.links) !== JSON.stringify(after.links)) errors.push(`item ${item.guid}: several <link>s changed`);
      return;
    }
    if (after.links.length === 0 && item.links.length === 1) errors.push(`item ${item.guid}: <link> removed`);
    if ((item.links[0] ?? null) !== (after.links[0] ?? null)) {
      links.push({ guid: item.guid, title: item.title, from: item.links[0] ?? null, to: after.links[0] ?? null });
    }
  });
  return { errors, links, items: itemsA.length };
}

async function load(location) {
  if (/^https?:\/\//.test(location)) {
    const response = await fetch(location, { headers: { "user-agent": "arkbfm-rss diff" } });
    if (!response.ok) throw new Error(`${location} answered ${response.status}`);
    return response.text();
  }
  return readFile(location, "utf8");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [original, rewritten] = process.argv.slice(2);
  if (!original || !rewritten) {
    console.error("usage: node scripts/diff-feed.mjs <original.xml|URL> <rewritten.xml|URL>");
    process.exit(2);
  }
  const { errors, links, items } = compareFeeds(await load(original), await load(rewritten));
  for (const link of links) console.log(`link  ${link.title}\n      ${link.from}\n   -> ${link.to}`);
  console.log(`\n${items} items, ${links.length} links changed, ${errors.length} other differences`);
  for (const error of errors.slice(0, 50)) console.error(`DIFF  ${error}`);
  process.exit(errors.length ? 1 : 0);
}
