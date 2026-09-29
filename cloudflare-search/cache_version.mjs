// Change the cache key across every Cloudflare data center after search data changes.
import { randomUUID } from "node:crypto";

const DATABASE_ID = "390de978-7db4-409c-9b55-e3f221b2b6a5";

export async function bumpSearchCacheVersion(account, token) {
  if (!account || !token) throw new Error("Cloudflare account and API token are required");
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${DATABASE_ID}/query`;
  const query = async sql => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ sql }),
    });
    const body = await response.json();
    if (!response.ok || !body.success) throw new Error(JSON.stringify(body.errors || body));
    return body.result[0];
  };
  await query("CREATE TABLE IF NOT EXISTS search_cache_version (id INTEGER PRIMARY KEY CHECK (id=1), version TEXT NOT NULL)");
  const version = randomUUID();
  await query(`INSERT INTO search_cache_version (id,version) VALUES (1,'${version}')
    ON CONFLICT(id) DO UPDATE SET version=excluded.version`);
  const check = await query("SELECT version FROM search_cache_version WHERE id=1");
  if (check.results[0]?.version !== version) throw new Error("Search cache version update was not verified");
  return version;
}
