#!/usr/bin/env node
// Run after any manual D1 or Vectorize update that changes search results.
import { readFileSync } from "node:fs";
import { bumpSearchCacheVersion } from "./cache_version.mjs";

const config = Object.fromEntries(readFileSync(new URL(".env", import.meta.url), "utf8")
  .split(/\r?\n/).filter(line => line && !line.startsWith("#"))
  .map(line => line.split(/=(.*)/s).slice(0, 2)));
const version = await bumpSearchCacheVersion(config.CLOUDFLARE_ACCOUNT_ID, config.CLOUDFLARE_API_TOKEN);
console.log(`Search cache invalidated (${version})`);
