const HTML = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>横断検索 | あらB.fm</title><meta name="robots" content="noindex,nofollow,noarchive">
<link rel="stylesheet" href="https://www.arkbfm.com/css/main.css"><link rel="shortcut icon" href="https://www.arkbfm.com/favicon.ico">
<style>
.search-card{max-width:960px}.search-note,#meta,.attrs,.kind{color:rgba(0,0,0,.54)}#meta{margin-top:8px}
.result{padding:22px 0}.result+.result{border-top:1px solid #eee}.title{font-size:1.5rem}.attrs,.kind{font-size:.86rem;margin:4px 0 9px}.hit{border-top:1px solid #eee;padding-top:12px;margin-top:12px}.text{line-height:1.7}mark{background:#ffe28a}
.play{font:inherit;cursor:pointer;color:#fff;background:#1c3c7c;border:0;border-radius:4px;margin-top:10px;padding:7px 11px}.player{position:sticky;bottom:8px;margin-top:16px}
@media(max-width:767px){.header-search{position:static;margin-top:18px}.header-search-input{width:100%}.title{font-size:1.25rem}}
</style></head><body><header class="header"><div class="header-overlay"><div class="container header-container"><div class="header-left"><h1 class="header-heading"><a href="https://www.arkbfm.com/"><span class="header-heading-ja">あら</span><span class="header-heading-en">B.fm</span></a></h1><div class="header-description">あらBがテクノロジー、音楽、映画などについてゲストを招いて話すポッドキャストです。</div></div><div class="header-search"><form class="header-search-form" id="form"><input type="search" id="q" name="q" minlength="2" maxlength="100" required autofocus placeholder="文字起こしを横断検索..." class="header-search-input" autocomplete="off"></form></div></div></div></header>
<main class="main"><div class="container search-card"><div class="card"><div class="card-header"><h1 class="card-heading">横断検索</h1><p class="search-note">校正済み文字起こし、タイトル、概要、ショーノートを検索します。</p><div id="meta"></div></div><div class="card-body" id="results"></div></div><div class="player" id="player"></div></div></main>
<script>
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const highlight=(text,q)=>esc(text).replaceAll(esc(q),'<mark>'+esc(q)+'</mark>');
document.querySelector('#results').addEventListener('click',e=>{const button=e.target.closest('.play');if(!button)return;const iframe=document.createElement('iframe');iframe.src='https://open.spotify.com/embed/episode/'+encodeURIComponent(button.dataset.spotify)+'?utm_source=generator&t='+Math.floor(Number(button.dataset.start));iframe.width='100%';iframe.height='152';iframe.title='Spotify episode player';iframe.allow='autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture';iframe.loading='eager';iframe.style.border='0';document.querySelector('#player').replaceChildren(iframe);iframe.scrollIntoView({behavior:'smooth',block:'nearest'})});
document.querySelector('#form').addEventListener('submit',async e=>{e.preventDefault();const q=document.querySelector('#q').value.trim();if(q.length<2)return;
const meta=document.querySelector('#meta'),results=document.querySelector('#results');meta.textContent='検索中…';results.innerHTML='';
try{const response=await fetch('/api/search',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({q})});const data=await response.json();if(!response.ok)throw new Error(data.error||'検索に失敗しました');
meta.textContent=data.results.length+'エピソード';results.innerHTML=data.results.map(x=>'<article class="result"><a class="title" href="'+esc(x.url)+'">'+esc(x.title)+'</a><div class="attrs">'+esc(x.published_at)+' · '+esc(x.actors)+'</div><div class="kind">'+esc(x.reason)+'</div>'+x.hits.map(h=>'<div class="hit"><div class="attrs">'+esc(h.timestamp)+' · '+esc(h.speaker||'話者不明')+(h.fuzzy?' · あいまい一致':'')+'</div><div class="text">'+highlight(h.text,q)+'</div><button class="play" data-spotify="'+esc(h.spotify_id)+'" data-start="'+Number(h.start)+'">Spotifyプレイヤーを表示（'+esc(h.timestamp)+'〜）</button></div>').join('')+'</article>').join('')||'<p>一致するエピソードはありませんでした。</p>';
}catch(error){meta.textContent=error.message;}});
const initialQuery=new URLSearchParams(location.search).get('q');if(initialQuery){document.querySelector('#q').value=initialQuery;document.querySelector('#form').requestSubmit()}
</script><footer class="footer"><div class="container"><div class="footer-copyright">© 2021 <a href="https://www.arkbfm.com/">あらB.fm</a></div></div></footer></body></html>`;

const headers = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline' https://www.arkbfm.com; font-src https://www.arkbfm.com; img-src https://www.arkbfm.com; script-src 'self' 'unsafe-inline'; frame-src https://open.spotify.com; base-uri 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow, noarchive",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers });
}

function timestamp(seconds) {
  const value = Math.max(0, Math.round(seconds));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor(value % 3600 / 60);
  const secs = value % 60;
  return [hours, minutes, secs].map(value => String(value).padStart(2, "0")).join(":");
}

const normalize = value => value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
const quoted = value => `"${value.replaceAll('"', '""')}"`;
const trigrams = value => [...new Set(Array.from(normalize(value)).slice(0, -2).map((_, index, chars) => chars.slice(index, index + 3).join("")))];
const excerpt = (text, needles) => {
  if (text.length <= 280) return text;
  const positions = needles.map(needle => normalize(text).indexOf(normalize(needle))).filter(index => index >= 0);
  const start = Math.max(0, (positions[0] || 0) - 100);
  const prefix = start ? "…" : "";
  const suffix = start + 280 - prefix.length < text.length ? "…" : "";
  return `${prefix}${text.slice(start, start + 280 - prefix.length - suffix.length)}${suffix}`;
};

async function search(env, query) {
  const normalized = normalize(query);
  const aliasRows = await env.DB.prepare(
    "SELECT term,replacement FROM search_aliases WHERE lower(term)=? OR lower(replacement)=? LIMIT 4"
  ).bind(normalized, normalized).all();
  const variants = [...new Set([query, ...aliasRows.results.flatMap(row => [row.term, row.replacement])])];
  const groups = new Map();
  const group = row => {
    if (!groups.has(row.episode)) groups.set(row.episode, {
      episode: row.episode, title: row.title, slug: row.slug, published_at: row.published_at,
      actors: row.actors, score: 0, reasons: new Set(), hits: [],
    });
    return groups.get(row.episode);
  };

  for (const variant of variants) {
    const term = variant.length < 3 ? `%${variant}%` : quoted(variant);
    const episodeSql = variant.length < 3
      ? `SELECT id episode,title,slug,published_at,actors,description,show_notes FROM episodes
         WHERE title LIKE ? OR description LIKE ? OR show_notes LIKE ? LIMIT 100`
      : `SELECT e.id episode,e.title,e.slug,e.published_at,e.actors,e.description,e.show_notes
         FROM episodes_fts f JOIN episodes e ON e.rowid=f.rowid
         WHERE episodes_fts MATCH ? ORDER BY bm25(episodes_fts,10.0,5.0,3.0) LIMIT 100`;
    const episodeQuery = env.DB.prepare(episodeSql);
    const episodeRows = await (variant.length < 3
      ? episodeQuery.bind(term, term, term).all()
      : episodeQuery.bind(term).all());
    episodeRows.results.forEach((row, index) => {
      const item = group(row), needle = normalize(variant);
      if (normalize(row.title).includes(needle)) { item.score = Math.max(item.score, 100 - index / 100); item.reasons.add("タイトル一致"); }
      else if (normalize(row.description).includes(needle)) { item.score = Math.max(item.score, 50 - index / 100); item.reasons.add("概要一致"); }
      else { item.score = Math.max(item.score, 30 - index / 100); item.reasons.add("ショーノート一致"); }
    });

    const segmentSql = variant.length < 3
      ? `SELECT s.episode,e.title,e.slug,e.published_at,e.actors,s.spotify_id,s.start,s.speaker,s.text
         FROM segments s JOIN episodes e ON e.id=s.episode WHERE s.text LIKE ? LIMIT 200`
      : `SELECT s.episode,e.title,e.slug,e.published_at,e.actors,s.spotify_id,s.start,s.speaker,s.text
         FROM segments_fts f JOIN segments s ON s.rowid=f.rowid JOIN episodes e ON e.id=s.episode
         WHERE segments_fts MATCH ? ORDER BY bm25(segments_fts) LIMIT 200`;
    const segmentRows = await env.DB.prepare(segmentSql).bind(term).all();
    segmentRows.results.forEach((row, index) => {
      const item = group(row);
      item.score = Math.max(item.score, 20 - index / 1000);
      item.reasons.add("文字起こし一致");
      if (!item.hits.some(hit => hit.start === row.start)) item.hits.push({ ...row, fuzzy: false });
    });
  }

  if (groups.size < 10 && Array.from(normalized).length >= 4) {
    const grams = trigrams(query);
    const fuzzyTerm = grams.map(quoted).join(" OR ");
    const fuzzyRows = await env.DB.prepare(
      `SELECT s.episode,e.title,e.slug,e.published_at,e.actors,s.spotify_id,s.start,s.speaker,s.text
       FROM segments_fts f JOIN segments s ON s.rowid=f.rowid JOIN episodes e ON e.id=s.episode
       WHERE segments_fts MATCH ? ORDER BY bm25(segments_fts) LIMIT 200`
    ).bind(fuzzyTerm).all();
    fuzzyRows.results.forEach(row => {
      const text = normalize(row.text);
      const coverage = grams.filter(gram => text.includes(gram)).length / grams.length;
      if (coverage < 0.55) return;
      const item = group(row);
      item.score = Math.max(item.score, 5 + coverage * 10);
      item.reasons.add("あいまい一致");
      if (!item.hits.some(hit => hit.start === row.start)) item.hits.push({ ...row, fuzzy: true, coverage });
    });
  }

  return [...groups.values()]
    .sort((a, b) => b.score - a.score || b.published_at.localeCompare(a.published_at))
    .slice(0, 20)
    .map(item => ({
      ...item, reasons: undefined, score: undefined,
      reason: [...item.reasons].join("・"),
      url: `https://www.arkbfm.com/episode/${item.slug}`,
      hits: item.hits.sort((a, b) => (b.coverage || 1) - (a.coverage || 1) || a.start - b.start).slice(0, 3)
        .map(hit => ({ ...hit, text: excerpt(hit.text, [query, ...variants, ...trigrams(query)]), timestamp: timestamp(hit.start) })),
    }));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") {
      return new Response(HTML, { headers: { ...headers, "content-type": "text/html; charset=utf-8" } });
    }
    if (request.method !== "POST" || url.pathname !== "/api/search") {
      return new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
    }

    const rate = await env.SEARCH_RATE_LIMIT.limit({ key: request.headers.get("cf-connecting-ip") || "unknown" });
    if (!rate.success) return json({ error: "検索回数が多すぎます。1分後にお試しください" }, 429);

    let query;
    try {
      query = String((await request.json()).q || "").trim();
    } catch {
      return json({ error: "JSONが不正です" }, 400);
    }
    if (query.length < 2 || query.length > 100) {
      return json({ error: "検索語は2〜100文字で入力してください" }, 400);
    }

    try {
      return json({ results: await search(env, query) });
    } catch (error) {
      console.error(error);
      return json({ error: "検索に失敗しました" }, 500);
    }
  },
};
