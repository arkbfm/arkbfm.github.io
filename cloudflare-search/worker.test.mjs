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
