// Rewrites only the text of each <rss><channel><item><link> in an RSS document and leaves every other byte as it
// was. The document is read by a small XML tokenizer (tags, quoted attribute values, CDATA, comments, processing
// instructions) rather than a DOM: a DOM would have to parse the whole 2 MB feed and serialize it again, which
// does not fit the Workers free plan's 10 ms of CPU and would reformat CDATA, namespaces and whitespace that
// Apple Podcasts already reads. The tokenizer works on the UTF-8 bytes as fetched, so the feed is never decoded
// and re-encoded, and it checks that every element is closed in order: a truncated or malformed feed is rejected
// instead of served.

export class FeedError extends Error {}

const encoder = new TextEncoder();
const utf8 = new TextDecoder("utf-8", { fatal: true });
const ascii = s => encoder.encode(s);

const LT = 0x3c, GT = 0x3e, SLASH = 0x2f, QUOT = 0x22, APOS = 0x27, BANG = 0x21, QUESTION = 0x3f;
const CDATA_OPEN = ascii("<![CDATA["), CDATA_CLOSE = ascii("]]>");
const COMMENT_OPEN = ascii("<!--"), COMMENT_CLOSE = ascii("-->");
const PI_CLOSE = ascii("?>"), DOCTYPE_OPEN = ascii("<!DOCTYPE");
// Only the text of these item children is read; descriptions and summaries (most of the feed) are skipped over.
const READ_TEXT = new Set(["title", "guid", "link"]);

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeEntities(raw) {
  return raw.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, name) => {
    if (name[0] === "#") {
      const code = name[1] === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name] ?? whole;
  });
}

export function escapeText(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function startsAt(bytes, needle, at) {
  if (at + needle.length > bytes.length) return false;
  for (let k = 0; k < needle.length; k += 1) if (bytes[at + k] !== needle[k]) return false;
  return true;
}

function find(bytes, needle, from, what) {
  for (let at = bytes.indexOf(needle[0], from); at >= 0; at = bytes.indexOf(needle[0], at + 1)) {
    if (startsAt(bytes, needle, at)) return at;
  }
  throw new FeedError(`unterminated ${what} at byte ${from}`);
}

function findByte(bytes, byte, from, what) {
  const at = bytes.indexOf(byte, from);
  if (at < 0) throw new FeedError(`unterminated ${what} at byte ${from}`);
  return at;
}

const text = (bytes, start, end) => {
  try {
    return utf8.decode(bytes.subarray(start, end));
  } catch {
    throw new FeedError(`invalid UTF-8 at byte ${start}`);
  }
};

const isSpace = c => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;

// Offset of the ">" that ends the start tag beginning at `from`, skipping ">" inside quoted attribute values.
function endOfTag(bytes, from) {
  for (let i = from; i < bytes.length; i += 1) {
    const c = bytes[i];
    if (c === GT) return i;
    if (c === QUOT || c === APOS) i = findByte(bytes, c, i + 1, "attribute value");
  }
  throw new FeedError(`unterminated tag at byte ${from}`);
}

// The element name starting at `from`, and the offset just after it. Names are almost always ASCII, which is read
// without a TextDecoder call.
function tagName(bytes, from, to) {
  let end = from;
  let name = "";
  let asciiOnly = true;
  while (end < to) {
    const c = bytes[end];
    if (isSpace(c) || c === SLASH || c === GT) break;
    if (c > 0x7f) asciiOnly = false;
    else if (asciiOnly) name += String.fromCharCode(c);
    end += 1;
  }
  return { name: asciiOnly ? name : text(bytes, from, end), end };
}

function hasNonSpace(bytes, start, end) {
  for (let k = start; k < end; k += 1) if (!isSpace(bytes[k])) return true;
  return false;
}

// Walks the document once. Returns, for each channel item, its byte range, the text of its direct-child <title>
// and <guid>, and the content byte ranges of its direct-child <link> elements.
export function scanFeed(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new FeedError("feed must be bytes");
  const stack = [];
  const items = [];
  let item = null;   // the <item> being read
  let field = null;  // a direct child of that item
  let channels = 0;
  let root = null;
  let i = 0;
  // Skip a UTF-8 byte order mark.
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) i = 3;
  while (i < bytes.length) {
    const lt = bytes.indexOf(LT, i);
    const textEnd = lt < 0 ? bytes.length : lt;
    if (textEnd > i) {
      if (field?.parts) field.parts.push(decodeEntities(text(bytes, i, textEnd)));
      else if (!stack.length && hasNonSpace(bytes, i, textEnd)) throw new FeedError("text outside the root element");
    }
    if (lt < 0) break;
    const next = bytes[lt + 1];
    if (next === BANG && startsAt(bytes, CDATA_OPEN, lt)) {
      const end = find(bytes, CDATA_CLOSE, lt + CDATA_OPEN.length, "CDATA section");
      if (!stack.length) throw new FeedError("CDATA outside the root element");
      if (field?.parts) field.parts.push(text(bytes, lt + CDATA_OPEN.length, end));
      i = end + CDATA_CLOSE.length;
    } else if (next === BANG && startsAt(bytes, COMMENT_OPEN, lt)) {
      i = find(bytes, COMMENT_CLOSE, lt + COMMENT_OPEN.length, "comment") + COMMENT_CLOSE.length;
    } else if (next === QUESTION) {
      i = find(bytes, PI_CLOSE, lt + 2, "processing instruction") + PI_CLOSE.length;
    } else if (next === BANG && startsAt(bytes, DOCTYPE_OPEN, lt)) {
      const gt = findByte(bytes, GT, lt, "DOCTYPE");
      if (bytes.subarray(lt, gt).includes(0x5b)) throw new FeedError("DOCTYPE with an internal subset is not supported");
      i = gt + 1;
    } else if (next === BANG) {
      throw new FeedError(`unexpected markup at byte ${lt}`);
    } else if (next === SLASH) {
      const gt = findByte(bytes, GT, lt, "end tag");
      const { name, end } = tagName(bytes, lt + 2, gt);
      if (hasNonSpace(bytes, end, gt)) throw new FeedError(`malformed end tag at byte ${lt}`);
      const open = stack.pop();
      if (open !== name) throw new FeedError(`</${name}> at byte ${lt} closes <${open ?? "nothing"}>`);
      if (field && stack.length === 3) {
        field.end = lt;
        field.text = field.parts ? field.parts.join("") : null;
        item.fields.push(field);
        field = null;
      } else if (item && stack.length === 2) {
        item.end = lt;
        items.push(item);
        item = null;
      }
      i = gt + 1;
    } else {
      const gt = endOfTag(bytes, lt + 1);
      const selfClosing = bytes[gt - 1] === SLASH;
      const { name } = tagName(bytes, lt + 1, gt);
      if (!name) throw new FeedError(`malformed tag at byte ${lt}`);
      if (!stack.length) {
        if (root) throw new FeedError("more than one root element");
        root = name;
      }
      const depth = stack.length;  // the new element's parent depth
      if (depth === 1 && name === "channel") channels += 1;
      if (depth === 2 && name === "item" && stack[1] === "channel" && !selfClosing) {
        item = { start: lt, end: -1, fields: [] };
      } else if (depth === 3 && item) {
        const entry = {
          name, start: gt + 1, end: gt + 1, tagStart: lt, selfClosing,
          parts: READ_TEXT.has(name) ? [] : null,
        };
        if (selfClosing) {
          entry.text = "";
          item.fields.push(entry);
        } else {
          field = entry;
        }
      }
      if (!selfClosing) stack.push(name);
      i = gt + 1;
    }
  }
  if (stack.length) throw new FeedError(`document ends inside <${stack[stack.length - 1]}>`);
  if (root !== "rss") throw new FeedError(`root element is <${root}>, not <rss>`);
  if (channels !== 1) throw new FeedError(`expected one <channel>, found ${channels}`);
  return items.map(({ start, end, fields }) => {
    const first = name => fields.find(f => f.name === name);
    return {
      start,
      end,
      title: first("title")?.text.trim() ?? "",
      guid: first("guid")?.text.trim() ?? "",
      links: fields.filter(f => f.name === "link"),
    };
  });
}

function concat(chunks) {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

// resolve(item) returns { url } to set the item's link, or { reason } to leave it as it is.
// Takes and returns the same type: UTF-8 bytes (Uint8Array) or a string. Also returns one report entry per item.
export function rewriteItemLinks(input, resolve) {
  const asString = typeof input === "string";
  const bytes = asString ? encoder.encode(input) : input;
  const items = scanFeed(bytes);
  const chunks = [];
  const report = [];
  let cursor = 0;
  const copyTo = end => chunks.push(bytes.subarray(cursor, end));
  for (const item of items) {
    const original = item.links.length === 1 ? item.links[0].text.trim() : null;
    const entry = { guid: item.guid, title: item.title, original, link: original, changed: false };
    report.push(entry);
    if (item.links.length > 1) {
      entry.reason = "item has more than one <link>";
      continue;
    }
    const decision = resolve({ title: item.title, guid: item.guid, link: original });
    if (!decision?.url) {
      entry.reason = decision?.reason ?? "no match";
      continue;
    }
    entry.link = decision.url;
    if (decision.url === original) continue;
    entry.changed = true;
    const link = item.links[0];
    const url = encoder.encode(escapeText(decision.url));
    if (!link) {
      // No <link> at all: add one just before </item>.
      copyTo(item.end);
      chunks.push(ascii("<link>"), url, ascii("</link>"));
      cursor = item.end;
    } else if (link.selfClosing) {
      copyTo(link.tagStart);
      chunks.push(ascii("<link>"), url, ascii("</link>"));
      cursor = link.start;
    } else {
      copyTo(link.start);
      chunks.push(url);
      cursor = link.end;
    }
  }
  copyTo(bytes.length);
  const out = concat(chunks);
  return { xml: asString ? new TextDecoder().decode(out) : out, items: report };
}
