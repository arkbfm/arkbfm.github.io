#!/usr/bin/env node
// Build the compact speaker lookup from the current production segments.
import { readFileSync } from "node:fs";

const config = Object.fromEntries(readFileSync(new URL(".env", import.meta.url), "utf8")
  .split(/\r?\n/).filter(line => line && !line.startsWith("#"))
  .map(line => line.split(/=(.*)/s).slice(0, 2)));
const account = config.CLOUDFLARE_ACCOUNT_ID;
const token = config.CLOUDFLARE_API_TOKEN;
if (!account || !token) throw new Error("Cloudflare account and API token are required");
const endpoint = `https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/390de978-7db4-409c-9b55-e3f221b2b6a5/query`;

async function query(sql) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ sql }),
  });
  const body = await response.json();
  if (!response.ok || !body.success) throw new Error(JSON.stringify(body.errors || body));
  return body.result[0].results;
}

await query("CREATE TABLE IF NOT EXISTS episode_speakers (episode TEXT NOT NULL, speaker TEXT NOT NULL, PRIMARY KEY (episode, speaker))");
await query("INSERT OR IGNORE INTO episode_speakers (episode, speaker) SELECT DISTINCT episode, speaker FROM segments WHERE speaker IS NOT NULL");
const checks = await query(`SELECT
  (SELECT count(*) FROM episode_speakers) AS indexed,
  (SELECT count(*) FROM (SELECT DISTINCT episode, speaker FROM segments WHERE speaker IS NOT NULL)) AS expected,
  (SELECT count(*) FROM (SELECT episode, speaker FROM episode_speakers EXCEPT SELECT episode, speaker FROM segments WHERE speaker IS NOT NULL)) AS extra`);
const { indexed, expected, extra } = checks[0];
if (indexed !== expected || extra !== 0) throw new Error(`Speaker index mismatch: indexed=${indexed}, expected=${expected}, extra=${extra}`);
console.log(`Verified ${indexed} distinct episode/speaker pairs`);
