#!/usr/bin/env node
// Prepare the existing Vectorize index for episode-only semantic retrieval.
import { readFileSync } from 'node:fs';
import { bumpSearchCacheVersion } from './cache_version.mjs';

const config = Object.fromEntries(readFileSync(new URL('.env', import.meta.url), 'utf8').split(/\r?\n/)
  .filter(line => line && !line.startsWith('#')).map(line => line.split(/=(.*)/s).slice(0, 2)));
if (!config.CLOUDFLARE_ACCOUNT_ID || !config.CLOUDFLARE_API_TOKEN) {
  throw new Error('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required');
}
const base = `https://api.cloudflare.com/client/v4/accounts/${config.CLOUDFLARE_ACCOUNT_ID}/vectorize/v2/indexes/arkbfm-search`;
const authorization = `Bearer ${config.CLOUDFLARE_API_TOKEN}`;
async function api(path, { method = 'GET', body, contentType = 'application/json' } = {}) {
  const response = await fetch(base + path, { method, headers: {
    authorization, ...(body ? { 'content-type': contentType } : {}),
  }, body });
  const result = await response.json();
  if (!response.ok || !result.success) throw new Error(`${path}: ${JSON.stringify(result.errors || result).slice(0, 400)}`);
  return result.result;
}

const vectors = readFileSync(new URL('vectors.ndjson', import.meta.url), 'utf8').trim().split('\n')
  .filter(line => line.startsWith('{"id":"e:'));
if (vectors.length < 200) throw new Error(`Only ${vectors.length} episode vectors found`);
if (vectors.some(line => JSON.parse(line).metadata.kind !== 'episode')) {
  throw new Error('Episode vector metadata is inconsistent');
}
const hasKindIndex = async () => (await api('/metadata_index/list')).metadataIndexes
  .some(index => index.propertyName === 'kind' && String(index.indexType).toLowerCase() === 'string');
if (!await hasKindIndex()) {
  await api('/metadata_index/create', { method: 'POST',
    body: JSON.stringify({ propertyName: 'kind', indexType: 'string' }) });
  console.log('Created kind metadata index');
  for (let attempt = 0; attempt < 30 && !await hasKindIndex(); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  if (!await hasKindIndex()) throw new Error('kind metadata index did not become ready');
}
await api('/upsert', { method: 'POST', body: vectors.join('\n') + '\n',
  contentType: 'application/x-ndjson' });
console.log(`Re-upserted ${vectors.length} episode vectors`);

const probe = JSON.parse(vectors.find(line => line.startsWith('{"id":"e:52-1"')) || vectors[0]);
for (let attempt = 0; attempt < 30; attempt++) {
  const result = await api('/query', { method: 'POST', body: JSON.stringify({
    vector: probe.values, topK: 1, returnMetadata: 'all', filter: { kind: 'episode' },
  }) });
  if (result.matches?.[0]?.id === probe.id) {
    console.log('Episode-only vector search is ready');
    await bumpSearchCacheVersion(config.CLOUDFLARE_ACCOUNT_ID, config.CLOUDFLARE_API_TOKEN);
    console.log('invalidated search cache');
    process.exit(0);
  }
  await new Promise(resolve => setTimeout(resolve, 2000));
}
throw new Error('Episode-only vector search did not become ready');
