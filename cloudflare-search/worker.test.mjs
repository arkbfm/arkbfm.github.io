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
