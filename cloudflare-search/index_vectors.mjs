#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync } from "node:fs";

for (const line of readFileSync(new URL(".env", import.meta.url), "utf8").split(/\r?\n/)) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) process.env[match[1].trim()] = match[2].trim();
}

const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
const model = "@cf/qwen/qwen3-embedding-0.6b";
const dimensions = 256;
const batchSize = 25;
const concurrency = 10;
if (!account || !token) throw new Error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required");

const outputFile = new URL("vectors.ndjson", import.meta.url);
const completed = new Set(existsSync(outputFile)
  ? readFileSync(outputFile, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line).id)
  : []);
const documents = JSON.parse(readFileSync(new URL("vector-documents.json", import.meta.url), "utf8"))
  .filter(document => !completed.has(document.id));
const embed = async offset => {
  const batch = documents.slice(offset, offset + batchSize);
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${model}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ documents: batch.map(document => document.text) }),
        signal: AbortSignal.timeout(30000),
      });
      const body = await response.json();
      if (response.ok && body.success) return batch.map((document, index) => JSON.stringify({
        id: document.id, values: body.result.data[index].slice(0, dimensions), metadata: document.metadata,
      }));
      if (![3040, 3002].includes(body.errors?.[0]?.code)) throw new Error(JSON.stringify(body.errors || body));
    } catch (error) {
      if (attempt === 5) throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt));
  }
};
for (let offset = 0; offset < documents.length; offset += batchSize * concurrency) {
  const results = await Promise.all(Array.from({ length: concurrency }, (_, index) => offset + index * batchSize)
    .filter(start => start < documents.length)
    .map(embed));
  appendFileSync(outputFile, results.flat().join("\n") + "\n");
  console.log(`embedded ${completed.size + Math.min(offset + batchSize * concurrency, documents.length)}/${completed.size + documents.length}`);
}
console.log("wrote vectors.ndjson");
