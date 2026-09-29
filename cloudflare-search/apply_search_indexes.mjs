#!/usr/bin/env node
// Apply lossless lookup accelerators to the existing D1 database.
import { readFileSync } from "node:fs";

const config = Object.fromEntries(readFileSync(new URL(".env", import.meta.url), "utf8")
  .split(/\r?\n/).filter(line => line && !line.startsWith("#"))
  .map(line => line.split(/=(.*)/s).slice(0, 2)));
const account = config.CLOUDFLARE_ACCOUNT_ID;
const token = config.CLOUDFLARE_API_TOKEN;
if (!account || !token) throw new Error("Cloudflare account and API token are required");
const endpoint = `https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/390de978-7db4-409c-9b55-e3f221b2b6a5/query`;
const terms = ["AI", "読書", "映画", "漫画", "音楽", "仕事", "旅行"];
const sqlString = value => "'" + value.replaceAll("'", "''") + "'";

async function query(sql) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ sql }),
  });
  const body = await response.json();
  if (!response.ok || !body.success) throw new Error(JSON.stringify(body.errors || body));
  return body.result[0];
}

if (process.argv.includes("--cache")) {
  await query("CREATE TABLE IF NOT EXISTS short_segment_hits (term TEXT NOT NULL, ordinal INTEGER NOT NULL, segment_rowid INTEGER NOT NULL, PRIMARY KEY (term, ordinal))");
  for (const term of terms) {
    const literal = sqlString(term);
    const pattern = sqlString(`%${term}%`);
    await query(`DELETE FROM short_segment_hits WHERE term=${literal}`);
    await query(`INSERT INTO short_segment_hits (term, ordinal, segment_rowid)
      SELECT ${literal}, row_number() OVER (ORDER BY rowid), rowid
      FROM (SELECT rowid FROM segments WHERE text LIKE ${pattern} ORDER BY rowid LIMIT 200)`);
    const old = await query(`SELECT s.rowid FROM segments s JOIN episodes e ON e.id=s.episode WHERE s.text LIKE ${pattern} LIMIT 200`);
    const cached = await query(`SELECT s.rowid FROM short_segment_hits h JOIN segments s ON s.rowid=h.segment_rowid JOIN episodes e ON e.id=s.episode WHERE h.term=${literal} ORDER BY h.ordinal LIMIT 200`);
    if (JSON.stringify(old.results) !== JSON.stringify(cached.results)) throw new Error(`Short search mismatch: ${term}`);
    console.log(`${term}: ${old.results.length} identical hits, rows read ${old.meta.rows_read} -> ${cached.meta.rows_read}`);
  }
}

if (process.argv.includes("--vocabulary")) {
  const probes = ["gpt6", "chatgpt", "xyzabc", "ai", "slay", "gemini"];
  const lookup = token => `SELECT term,frequency FROM search_vocabulary
    WHERE length(term) BETWEEN ${Math.max(2, token.length - 1)} AND ${token.length + 1}
      AND (substr(term,1,1)=${sqlString(token[0])} OR substr(term,-1)=${sqlString(token.at(-1))})
    ORDER BY frequency DESC, rowid ASC LIMIT 500`;
  const before = await Promise.all(probes.map(token => query(lookup(token))));
  await query("CREATE INDEX IF NOT EXISTS search_vocabulary_first_idx ON search_vocabulary(substr(term,1,1),length(term),frequency DESC)");
  await query("CREATE INDEX IF NOT EXISTS search_vocabulary_last_idx ON search_vocabulary(substr(term,-1),length(term),frequency DESC)");
  for (let i = 0; i < probes.length; i++) {
    const after = await query(lookup(probes[i]));
    if (JSON.stringify(before[i].results) !== JSON.stringify(after.results)) throw new Error(`Spelling candidate mismatch: ${probes[i]}`);
    console.log(`${probes[i]}: ${after.results.length} identical candidates, rows read ${before[i].meta.rows_read} -> ${after.meta.rows_read}`);
  }
}

if (!process.argv.includes("--cache") && !process.argv.includes("--vocabulary")) {
  throw new Error("Choose --cache or --vocabulary");
}
