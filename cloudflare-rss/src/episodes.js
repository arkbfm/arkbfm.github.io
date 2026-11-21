// Matches an RSS item to its page on the official site.
//
// Both sides carry the episode label in the title: "Ep. 152-2 Beyond Yabai (ウスター,あらB)" in the RSS and
// "Ep. 152 Beyond Yabai (ウスター,あらB)" on the site. The label is the number, an optional ".5" for a bonus
// episode and an optional "-N" for a part. The site page is found by the full label, and failing that, for a part,
// by the episode number alone (the site often puts every part of an episode on one page). The URL is never built
// from the number: it comes from the site's own list of pages (/episode-links.json), so only existing pages are
// linked (e.g. "Ep. 56" lives at /episode/56-1, "Ep. 118.5" at /episode/118.5, "Ep. 131.5" at /episode/131_5-1).
//
// As a check against a wrong number on either side, the English subtitles must also agree: after dropping case,
// spaces and punctuation, one must start with the other ("Koko says soso 2" matches the site's "Koko says soso").

const LABEL = /^\s*Ep\.\s*(\d+(?:\.\d+)?)(?:-(\d+))?(?=\s|$)\s*(.*)$/s;
const GUESTS = /\s*[(（][^()（）]*[)）]\s*$/;

export function parseEpisodeTitle(title) {
  const m = LABEL.exec(String(title ?? "").normalize("NFKC"));
  if (!m) return null;
  const [, number, part, rest] = m;
  return {
    number,
    part: part ?? null,
    label: part ? `${number}-${part}` : number,
    subtitle: rest.replace(GUESTS, "").trim(),
  };
}

export function subtitleKey(subtitle) {
  return String(subtitle).normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

function subtitlesAgree(a, b) {
  const x = subtitleKey(a);
  const y = subtitleKey(b);
  return x.startsWith(y) || y.startsWith(x);
}

// pages: [{ title, url }] as published by the site (url may be a path). siteBase: the prefix every page URL must
// have after it is resolved against siteBase, e.g. "https://www.arkbfm.com/episode/".
// overrides: { [guid]: url | null } for the rare episode the rules cannot place (null keeps the original link).
export function createResolver(pages, { siteBase, overrides = {} } = {}) {
  if (!Array.isArray(pages)) throw new TypeError("site index must be an array");
  if (!siteBase) throw new TypeError("siteBase is required");
  const byLabel = new Map();
  const ambiguous = new Set();
  for (const page of pages) {
    const parsed = parseEpisodeTitle(page?.title);
    if (!parsed || typeof page.url !== "string") continue;
    let url;
    try {
      url = new URL(page.url, siteBase).href;  // the site lists paths such as "/episode/168"
    } catch {
      continue;
    }
    if (!url.startsWith(siteBase)) continue;
    if (byLabel.has(parsed.label) && byLabel.get(parsed.label).url !== url) ambiguous.add(parsed.label);
    byLabel.set(parsed.label, { url, subtitle: parsed.subtitle });
  }
  for (const label of ambiguous) byLabel.delete(label);

  return function resolve({ title, guid }) {
    if (guid && Object.prototype.hasOwnProperty.call(overrides, guid)) {
      const url = overrides[guid];
      return typeof url === "string" && /^https:\/\//.test(url) ? { url, by: "override" } : { reason: "override keeps the original link" };
    }
    const episode = parseEpisodeTitle(title);
    if (!episode) return { reason: "title has no episode number" };
    const candidates = episode.part ? [episode.label, episode.number] : [episode.label];
    for (const label of candidates) {
      if (ambiguous.has(label)) return { reason: `several site pages are titled Ep. ${label}` };
      const page = byLabel.get(label);
      if (!page) continue;
      if (!subtitlesAgree(episode.subtitle, page.subtitle)) {
        return { reason: `subtitle differs from the site's Ep. ${label} ("${page.subtitle}")` };
      }
      return { url: page.url, by: label };
    }
    return { reason: `no site page for Ep. ${episode.label}` };
  };
}
