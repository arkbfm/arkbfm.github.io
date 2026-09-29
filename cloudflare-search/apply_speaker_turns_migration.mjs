import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bumpSearchCacheVersion } from './cache_version.mjs';
const root=new URL('.',import.meta.url);
const config=Object.fromEntries(readFileSync(new URL('.env',root),'utf8').split(/\r?\n/)
  .filter(line=>line&&!line.startsWith('#')).map(line=>line.split(/=(.*)/s).slice(0,2)));
const url=`https://api.cloudflare.com/client/v4/accounts/${config.CLOUDFLARE_ACCOUNT_ID}/d1/database/390de978-7db4-409c-9b55-e3f221b2b6a5/query`;
async function query(sql){
  const response=await fetch(url,{method:'POST',headers:{authorization:`Bearer ${config.CLOUDFLARE_API_TOKEN}`,'content-type':'application/json'},body:JSON.stringify({sql})});
  const data=await response.json();
  if(!response.ok||!data.success)throw new Error(JSON.stringify(data.errors||data).slice(0,600));
  return data.result;
}
const schema=await query('PRAGMA table_info(segments)');
if(!schema[0].results.some(row=>row.name==='speaker_turns')){
  await query('ALTER TABLE segments ADD COLUMN speaker_turns TEXT');
  console.log('added speaker_turns column');
}
const lines=readFileSync(new URL('speaker-turns-migration.sql',root),'utf8').split('\n')
  .filter(line=>line.startsWith('UPDATE segments SET speaker_turns='));
if(lines.length<12000)throw new Error(`Only ${lines.length} speaker turn updates found`);
const progress=join(tmpdir(),'arkbfm-speaker-migration-progress.json');
let next=0;
try{next=JSON.parse(readFileSync(progress,'utf8')).next;}catch{}
for(;next<lines.length;){
  const batch=lines.slice(next,next+40);
  const result=await query(batch.join('\n'));
  if(result.length!==batch.length)throw new Error(`Batch ${next}: expected ${batch.length} statements, got ${result.length}`);
  next+=batch.length;
  writeFileSync(progress,JSON.stringify({next}));
  if(next%400===0||next===lines.length)console.log('applied',next,'of',lines.length);
}
console.log('speaker turn migration complete');

const final=await query('SELECT count(*) AS missing FROM segments WHERE speaker_turns IS NULL');
if(final[0].results[0].missing!==0)throw new Error(`Speaker turns missing on ${final[0].results[0].missing} rows`);
console.log('verified all search chunks have speaker turns');
await bumpSearchCacheVersion(config.CLOUDFLARE_ACCOUNT_ID, config.CLOUDFLARE_API_TOKEN);
console.log('invalidated search cache');
