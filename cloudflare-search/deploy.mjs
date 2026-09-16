#!/usr/bin/env node
import { readFileSync } from "node:fs";

for (const line of readFileSync(new URL(".env", import.meta.url), "utf8").split(/\r?\n/)) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) process.env[match[1].trim()] = match[2].trim();
}

const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!account || !token) throw new Error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required");

const metadata = {
  main_module: "worker.js",
  compatibility_date: "2026-09-16",
  bindings: [{ type: "d1", name: "DB", database_id: "390de978-7db4-409c-9b55-e3f221b2b6a5" }],
};
const form = new FormData();
form.append("metadata", JSON.stringify(metadata));
form.append("worker.js", new Blob([readFileSync(new URL("worker.js", import.meta.url))], {
  type: "application/javascript+module",
}), "worker.js");

const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/arkbfm-search`, {
  method: "PUT",
  headers: { authorization: `Bearer ${token}` },
  body: form,
});
const result = await response.json();
if (!response.ok || !result.success) throw new Error(JSON.stringify(result.errors || result));
console.log("uploaded Worker arkbfm-search");

if (process.argv.includes("--attach-domain") || process.argv.includes("--detach-domain")) {
  const api = async (path, options = {}) => {
    const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
      ...options,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...options.headers },
    });
    const body = await response.text();
    const data = body ? JSON.parse(body) : { success: response.ok, result: null };
    if (!response.ok || !data.success) throw new Error(JSON.stringify(data.errors || data));
    return data.result;
  };
  if (process.argv.includes("--detach-domain")) {
    const domains = await api(`/accounts/${account}/workers/domains`);
    const domain = domains.find(item => item.hostname === "search.arkbfm.com" && item.service === "arkbfm-search");
    if (!domain) {
      console.log("search.arkbfm.com already detached");
      process.exit(0);
    }
    await api(`/accounts/${account}/workers/domains/${domain.id}`, { method: "DELETE" });
    console.log("detached search.arkbfm.com");
    process.exit(0);
  }
  const zones = await api(`/zones?name=arkbfm.com&account.id=${account}`);
  if (zones.length !== 1) throw new Error("arkbfm.com zone not found");
  await api(`/accounts/${account}/workers/domains`, {
    method: "PUT",
    body: JSON.stringify({
      environment: "production",
      hostname: "search.arkbfm.com",
      service: "arkbfm-search",
      zone_id: zones[0].id,
    }),
  });
  console.log("attached search.arkbfm.com");
}
