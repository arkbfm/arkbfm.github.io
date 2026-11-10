import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("worker.js", import.meta.url), "utf8");
const worker = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);

assert.equal(worker.normalize(" ＶＲ　の話 "), "vr の話");
assert.equal(worker.semanticQuery("VRについての話"), "vr");
assert.deepEqual(worker.trigrams("VRの話"), ["vrの", "rの話"]);
assert(worker.fuzzyTrigrams("VZの話").includes("vの話"));
assert.equal(worker.editDistance("vz", "vr"), 1);
console.log("search helper checks passed");

const makeCandidates = () => [0, 1, 2].map(index => ({
  title: `Episode ${index}`, description: `Description ${index}`,
  hits: [{ text: `Hit ${index}` }], score: 0, reasons: new Set(),
}));

let candidates = makeCandidates();
let calls = [];
let env = { AI: { run: async (model, input) => {
  calls.push(model);
  assert(input.state.candidates[0].text.includes("Description 0"));
  return { answers: {
    candidate_0: { noul: 0.1 }, candidate_1: { noul: 0.8 }, candidate_2: { noul: 0.2 },
  } };
} } };
assert.equal(await worker.rerankCandidates(env, "query", candidates), "jev");
assert.deepEqual(calls, ["typesafe/jev"]);
assert(candidates[1].score > candidates[2].score);

// Cloudflare's Jev binding can return an async result envelope.
candidates = makeCandidates();
calls = [];
env = { AI: { run: async model => {
  calls.push(model);
  return { state: "Completed", result: { answers: {
    candidate_0: { noul: 0.1 }, candidate_1: { noul: 0.8 }, candidate_2: { noul: 0.2 },
  } } };
} } };
assert.equal(await worker.rerankCandidates(env, "query", candidates), "jev");
assert.deepEqual(calls, ["typesafe/jev"]);
assert(candidates[1].score > candidates[2].score);

candidates = makeCandidates();
calls = [];
env = { AI: { run: async model => {
  calls.push(model);
  if (model === "typesafe/jev") throw new Error("unavailable");
  return { response: [{ id: 2, score: 0.2 }, { id: 0, score: 0.01 }, { id: 1, score: 0.001 }] };
} } };
const previousConsoleError = console.error;
console.error = () => {};
try {
  assert.equal(await worker.rerankCandidates(env, "query", candidates), "bge");
} finally {
  console.error = previousConsoleError;
}
assert.deepEqual(calls, ["typesafe/jev", "@cf/baai/bge-reranker-base"]);
assert(candidates[2].score > candidates[0].score);
console.log("Jev reranking and fallback checks passed");

const firstTurn = "あらBが話します😀";
const secondTurn = "ピジェが答えます。検索語はここです。";
const mixedHit = {
  text: firstTurn + " " + secondTurn, speaker: "あらB / ピジェ", start: 10,
  speaker_turns: JSON.stringify([
    [Array.from(firstTurn).length, "あらB", 10],
    [Array.from(secondTurn).length, "ピジェ", 20],
  ]),
};
const lines = worker.labeledExcerpt(mixedHit, ["検索語"]);
assert.equal(lines[0].speaker, "ピジェ");
assert.equal(lines[0].start, 20);
assert(lines[0].text.includes("検索語"));
assert.equal(worker.labeledExcerpt({ ...mixedHit, speaker_turns: null }, ["検索語"])[0].speaker,
  "あらB / ピジェ");
console.log("speaker turn excerpt checks passed");

const contiguousHit = {
  ...mixedHit,
  text: firstTurn + secondTurn,
  speaker_turns: JSON.stringify([
    [Array.from(firstTurn).length, "あらB", 10, 0],
    [Array.from(secondTurn).length, "ピジェ", 20, 1],
  ]),
};
const contiguousLines = worker.labeledExcerpt(contiguousHit, ["検索語"]);
assert.equal(contiguousLines[0].speaker, "ピジェ");
assert.equal(contiguousLines[0].start, 20);
assert.equal(contiguousLines[0].text, secondTurn);
console.log("word-aligned speaker pieces without added spaces passed");

// Captions for the listening feed (GET /api/captions), against a real SQLite database standing in for D1.
const { DatabaseSync } = await import("node:sqlite");
let importCount = 0;
// A fresh module each time: the Worker keeps the caption generation in module state.
const loadWorker = () => import(`data:text/javascript;base64,${Buffer.from(`${source}\n// ${++importCount}`).toString("base64")}`);

function fakeD1(sql) {
  const db = new DatabaseSync(":memory:");
  db.exec(sql);
  const log = [];
  const statement = (query, args = []) => ({
    query, args,
    bind: (...values) => statement(query, values),
    first: async () => { log.push(query); return db.prepare(query).get(...args) ?? null; },
    all: async () => { log.push(query); return { results: db.prepare(query).all(...args) }; },
  });
  return {
    db, log,
    prepare: query => statement(query),
    batch: async statements => Promise.all(statements.map(item => item.all())),
  };
}

const row = (...values) => `(${values.map(value => value === null ? "NULL" : typeof value === "number" ? value
  : `'${String(value).replaceAll("'", "''")}'`).join(",")})`;
const pack = value => JSON.stringify(value);
// Episode "9": part 1 has a published answer at 290-700 s (clip 9.1) and part 2 one at 30-90 s (9.c2);
// chapter question 9.c1 is hidden, so neither its id nor its span (900-960 s, never written) exists.
const captionSql = `
CREATE TABLE caption_clips (id TEXT PRIMARY KEY, episode TEXT NOT NULL, part INTEGER NOT NULL, start REAL NOT NULL, end REAL NOT NULL) WITHOUT ROWID;
CREATE TABLE caption_episodes (episode TEXT PRIMARY KEY, speakers TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE caption_chunks (episode TEXT NOT NULL, part INTEGER NOT NULL, bucket INTEGER NOT NULL, lines TEXT NOT NULL, turns TEXT NOT NULL, carry TEXT, PRIMARY KEY (episode, part, bucket)) WITHOUT ROWID;
CREATE TABLE caption_cache_version (id INTEGER PRIMARY KEY CHECK (id=1), version TEXT NOT NULL);
INSERT INTO caption_cache_version VALUES (1,'gen1');
INSERT INTO caption_clips VALUES ${row("9.1", "9", 0, 290, 700)},${row("9.c2", "9", 1, 30, 90)};
INSERT INTO caption_episodes VALUES ${row("9", pack({ s0: ["あらB", "/images/actors/ark_B.jpg", true],
  s1: ["ゲスト", "/images/actors/guest.jpg", false], s2: ["別の人", "", false] }))};
INSERT INTO caption_chunks VALUES
${row("9", 0, 0, pack([[0, 286, "s0", "前置き|です"], [0, 295, "s1", "答えの|始まり"]]), pack([[0, 280, "s0"], [0, 296, "s1"]]), null)},
${row("9", 0, 1, pack([[0, 400, "s0", "まんなか"]]), pack([]), pack([0, 296, "s1"]))},
${row("9", 0, 2, pack([[0, 650, "s1", "おわり"], [0, 699.9, "s1", "最後"], [0, 705, "s1", "次の問いの冒頭"]]), pack([[0, 705, "s0"]]), pack([0, 296, "s1"]))},
${row("9", 1, 0, pack([[1, 31, "s1", "パート2"]]), pack([]), null)};
`;
const site = "https://www.arkbfm.com";
const captionsUrl = query => `https://search.arkbfm.com/api/captions?${query}`;
function captionEnv(overrides = {}) {
  const calls = { caption: 0, search: 0 };
  return {
    calls,
    DB: fakeD1(captionSql),
    CAPTION_RATE_LIMIT: { limit: async () => { calls.caption++; return { success: true }; } },
    SEARCH_RATE_LIMIT: { limit: async () => { calls.search++; return { success: true }; } },
    ...overrides,
  };
}
const get = (captionWorker, env, query, init = {}) => captionWorker.default.fetch(new Request(captionsUrl(query),
  { headers: { origin: site, "cf-connecting-ip": "203.0.113.9" }, ...init }), env, { waitUntil: () => {} });

// Request parsing: a clip id, or a moment of an episode no longer than the Worker serves at once.
assert.deepEqual(worker.parseCaptionRequest(new URLSearchParams("c=101_5.c12")), { clip: "101_5.c12" });
assert.deepEqual(worker.parseCaptionRequest(new URLSearchParams("c=118.5.2")), { clip: "118.5.2" });
assert.equal(worker.parseCaptionRequest(new URLSearchParams("ep=118.5&t=1&e=2")).episode, "118.5");
assert.deepEqual(worker.parseCaptionRequest(new URLSearchParams("ep=9&t=10&e=70")),
  { episode: "9", part: 0, start: 10, end: 70 });
assert.deepEqual(worker.parseCaptionRequest(new URLSearchParams("ep=9&p=2&t=10&e=1810")),
  { episode: "9", part: 1, start: 10, end: 1810 });
for (const bad of ["", "c=", "c=9", "c=../9.1", "c=9.1&ep=9&t=1&e=2", "ep=9&t=1", "ep=9&t=-1&e=5",
  "ep=9&t=1.5&e=5", "ep=9&t=10&e=10", "ep=9&t=0&e=1801", "ep=9&p=0&t=1&e=2", "ep=9&p=10&t=1&e=2", "ep=a/b&t=1&e=2"]) {
  assert(worker.parseCaptionRequest(new URLSearchParams(bad)).error, `should reject ${bad}`);
}

// Slicing: lead-in, end exclusive, the voice already talking, and only the speakers used.
const sliced = worker.sliceCaptions([
  { lines: pack([[0, 286, "s0", "a"], [0, 295, "s1", "b"]]), turns: pack([[0, 280, "s0"], [0, 296, "s1"]]), carry: null },
  { lines: pack([[0, 305, "s1", "c"]]), turns: pack([]), carry: pack([0, 296, "s1"]) },
], { s0: ["A"], s1: ["B"], s2: ["C"] }, { part: 0, start: 292, end: 305 });
assert.deepEqual(sliced, { speakers: { s0: ["A"], s1: ["B"] }, lines: [[0, 295, "s1", "b"]], turns: [[0, 280, "s0"], [0, 296, "s1"]] });
assert.equal(worker.sliceCaptions([{ lines: pack([[0, 10, "s0", "a"]]), turns: "[]", carry: null }], {},
  { part: 0, start: 100, end: 200 }), null);
console.log("caption slicing checks passed");

{
  const captionWorker = await loadWorker();
  const env = captionEnv();
  let response = await get(captionWorker, env, "c=9.1");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), site);
  assert.equal(response.headers.get("vary"), "Origin");
  assert.match(response.headers.get("cache-control"), /max-age=3600/);
  let body = await response.json();
  // 286 s is inside the 5-second lead-in; 705 s belongs to the next answer.
  assert.deepEqual(body.lines.map(line => line[1]), [286, 295, 400, 650, 699.9]);
  assert.deepEqual(body.turns, [[0, 280, "s0"], [0, 296, "s1"]]);
  assert.deepEqual(Object.keys(body.speakers), ["s0", "s1"]);

  // A moment inside the answer, starting in a bucket after the voice change: the carried turn names the voice.
  body = await (await get(captionWorker, env, "ep=9&t=600&e=660")).json();
  assert.deepEqual(body.lines, [[0, 650, "s1", "おわり"]]);
  assert.deepEqual(body.turns, [[0, 296, "s1"]]);
  assert.deepEqual(Object.keys(body.speakers), ["s1"]);
  body = await (await get(captionWorker, env, "ep=9&p=2&t=0&e=60")).json();
  assert.deepEqual(body.lines, [[1, 31, "s1", "パート2"]]);

  // Unknown and hidden questions, and the hidden question's span, have nothing to give.
  for (const query of ["c=9.99", "c=9.c1", "c=nosuch.1", "ep=9&t=900&e=960", "ep=nosuch&t=0&e=60"]) {
    response = await get(captionWorker, env, query);
    assert.equal(response.status, 404, query);
    assert.equal(response.headers.get("access-control-allow-origin"), site);
    assert((await response.json()).error);
  }
  for (const query of ["c=9.1;DROP", "ep=9&t=0&e=4000", "x=1"]) {
    response = await get(captionWorker, env, query);
    assert.equal(response.status, 400, query);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  // Captions never touch the search budget or the search cache generation.
  assert.equal(env.calls.search, 0);
  assert(!env.DB.log.some(query => query.includes("search_cache_version")));
  assert.equal(env.DB.log.filter(query => query.includes("caption_cache_version")).length, 1);
}

{
  const captionWorker = await loadWorker();
  const env = captionEnv();
  // Not from the site's pages (curl, another site): refused before any work is done.
  for (const headers of [{}, { origin: "https://example.com" }]) {
    const response = await captionWorker.default.fetch(new Request(captionsUrl("c=9.1"), { headers }), env, {});
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
  }
  assert.equal(env.calls.caption, 0);
  assert.equal(env.DB.log.length, 0);
  let response = await get(captionWorker, env, "c=9.1", { method: "POST", body: "{}" });
  assert.equal(response.status, 405);
  response = await get(captionWorker, env, "c=9.1", { method: "OPTIONS" });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), site);

  // Over the caption rate limit: 429 without reading D1.
  const limited = captionEnv({ CAPTION_RATE_LIMIT: { limit: async () => ({ success: false }) } });
  response = await get(captionWorker, limited, "c=9.1");
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "60");
  assert.equal(limited.DB.log.length, 0);

  // Tables mid-swap (or D1 down): 503, and the page plays on without captions.
  const broken = captionEnv();
  broken.DB.db.exec("DROP TABLE caption_chunks");
  const previous = console.error;
  console.error = () => {};
  try { response = await get(await loadWorker(), broken, "c=9.1"); }
  finally { console.error = previous; }
  assert.equal(response.status, 503);
}

{
  // Edge cache: a hit reads no caption rows, and a new generation (captions.sql, deploy.mjs) misses at once.
  const captionWorker = await loadWorker();
  const env = captionEnv();
  const store = new Map();
  const pending = [];
  const previousCaches = globalThis.caches;
  globalThis.caches = { default: {
    match: async request => store.get(request.url)?.clone(),
    put: async (request, response) => { store.set(request.url, response); },
  } };
  const realNow = Date.now;
  try {
    const fetchOnce = async () => captionWorker.default.fetch(new Request(captionsUrl("c=9.1"),
      { headers: { origin: site } }), env, { waitUntil: promise => pending.push(promise) });
    let response = await fetchOnce();
    assert.equal(response.headers.get("x-caption-cache"), "MISS");
    const first = await response.json();
    await Promise.all(pending);
    assert(store.size === 1 && [...store.keys()][0].includes("v=gen1"));
    const reads = env.DB.log.length;
    response = await fetchOnce();
    assert.equal(response.headers.get("x-caption-cache"), "HIT");
    assert.equal(response.headers.get("access-control-allow-origin"), site);
    assert.deepEqual(await response.json(), first);
    assert.equal(env.DB.log.length, reads, "a cache hit within a minute does not query D1");

    env.DB.db.exec("UPDATE caption_cache_version SET version='gen2'");
    Date.now = () => realNow() + 61000;
    response = await fetchOnce();
    assert.equal(response.headers.get("x-caption-cache"), "MISS");
  } finally {
    globalThis.caches = previousCaches;
    Date.now = realNow;
  }
}

{
  // The search API and page are unchanged and keep their own rate limit.
  const searchWorker = await loadWorker();
  const env = captionEnv({ SEARCH_RATE_LIMIT: { limit: async () => ({ success: false }) } });
  let response = await searchWorker.default.fetch(new Request("https://search.arkbfm.com/api/search",
    { method: "POST", body: JSON.stringify({ q: "映画" }) }), env, {});
  assert.equal(response.status, 429);
  assert.equal(env.calls.caption, 0);
  response = await searchWorker.default.fetch(new Request("https://search.arkbfm.com/api/search"), env, {});
  assert.equal(response.status, 404);
  response = await searchWorker.default.fetch(new Request("https://search.arkbfm.com/"), env, {});
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
}
console.log("caption API checks passed");
