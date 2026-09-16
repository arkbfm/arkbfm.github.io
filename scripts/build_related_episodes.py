#!/usr/bin/env python3
"""Build Jekyll data for cross-episode navigation."""
from __future__ import annotations

from collections import Counter, defaultdict
import json
import math
from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[1]
POSTS = ROOT / "_posts"
TRANSCRIPTS = ROOT / "transcripts" / "text"
OUTPUT = ROOT / "_data" / "related_episodes.json"
HOST = "ark_B"
LIMIT = 6


def load_posts() -> dict[str, dict]:
    posts = {}
    for path in POSTS.glob("*.md"):
        match = re.match(r"\d{4}-\d{2}-\d{2}-(.+)\.md$", path.name)
        if not match:
            continue
        source = path.read_text(encoding="utf-8-sig")
        front, body = source.split("---", 2)[1:]
        title = re.search(r"^title:\s*(.+)$", front, re.MULTILINE).group(1).strip(' "')
        actors_match = re.search(r"^actor_ids:\s*\n((?:\s+- .+\n?)+)", front, re.MULTILINE)
        actors = re.findall(r"^\s+-\s+(.+)$", actors_match.group(1), re.MULTILINE) if actors_match else []
        slug = match.group(1)
        posts[slug] = {"title": title, "actors": set(actors), "body": body, "date": path.name[:10]}
    return posts


def transcript_path(slug: str) -> Path | None:
    candidates = [slug, slug.replace("_", "-"), slug.replace("-", "_")]
    for episode in candidates:
        path = TRANSCRIPTS / f"Ep{episode}.md"
        if path.exists():
            return path
    return None


def transcript_vectors(posts: dict[str, dict]) -> dict[str, dict[str, float]]:
    counts = {}
    document_frequency = Counter()
    for slug in posts:
        path = transcript_path(slug)
        if not path:
            continue
        text = path.read_text(encoding="utf-8-sig")
        text = re.sub(r"^#.*$|^\[\d\d:\d\d:\d\d\]\s*(?:SPEAKER_\d+:\s*)?", "", text, flags=re.MULTILINE)
        text = re.sub(r"[^0-9A-Za-zぁ-んァ-ヶ一-龠ー]", "", text).lower()
        frequent = Counter(text[index:index + 4] for index in range(len(text) - 3)).most_common(1200)
        counts[slug] = dict(frequent)
        document_frequency.update(counts[slug])

    vectors = {}
    total = len(counts)
    for slug, terms in counts.items():
        weighted = {
            term: (1 + math.log(count)) * math.log(total / frequency)
            for term, count in terms.items()
            if 1 < (frequency := document_frequency[term]) <= total * 0.35
        }
        norm = math.sqrt(sum(value * value for value in weighted.values())) or 1
        vectors[slug] = {term: value / norm for term, value in weighted.items()}
    return vectors


def transcript_neighbors(vectors: dict[str, dict[str, float]]) -> dict[str, list[str]]:
    index = defaultdict(list)
    for slug, vector in vectors.items():
        for term, weight in vector.items():
            index[term].append((slug, weight))

    neighbors = {}
    for slug, vector in vectors.items():
        scores = Counter()
        for term, weight in vector.items():
            for other, other_weight in index[term]:
                if other != slug:
                    scores[other] += weight * other_weight
        neighbors[slug] = [other for other, _ in scores.most_common(LIMIT)]
    return neighbors


def build() -> dict[str, list[dict]]:
    posts = load_posts()
    incoming = defaultdict(set)
    outgoing = defaultdict(set)
    link_pattern = re.compile(r"https?://(?:www\.)?(?:arkbfm\.com|arkbfm\.github\.io)/episode/([^/)#?]+)")
    for slug, post in posts.items():
        for target in link_pattern.findall(post["body"]):
            if target in posts and target != slug:
                outgoing[slug].add(target)
                incoming[target].add(slug)

    neighbors = transcript_neighbors(transcript_vectors(posts))
    result = {}
    for slug, post in posts.items():
        guests = post["actors"] - {HOST}
        direct = sorted(outgoing[slug]) + sorted(incoming[slug])
        guest_matches = sorted(
            (other for other, candidate in posts.items()
             if other != slug and guests & (candidate["actors"] - {HOST})),
            key=lambda other: posts[other]["date"], reverse=True,
        )
        transcript_matches = neighbors.get(slug, [])
        selected = []
        for pool in (direct[:3], transcript_matches[:2], guest_matches[:2], direct, transcript_matches, guest_matches):
            for other in pool:
                if other not in selected:
                    selected.append(other)
                if len(selected) == LIMIT:
                    break
            if len(selected) == LIMIT:
                break

        result[slug] = [
            {
                "title": posts[other]["title"],
                "url": f"/episode/{other}",
                "reasons": [
                    reason for matches, reason in (
                        (outgoing[slug], "この回から参照"),
                        (incoming[slug], "この回を参照"),
                        (guest_matches, "同じゲスト"),
                        (transcript_matches, "文字起こしの話題が近い"),
                    ) if other in matches
                ],
            }
            for other in selected
        ]
    return result


def main() -> None:
    data = build()
    assert data and all(item["url"] in {f"/episode/{slug}" for slug in data} for items in data.values() for item in items)
    OUTPUT.parent.mkdir(exist_ok=True)
    OUTPUT.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {OUTPUT.relative_to(ROOT)} for {len(data)} episodes")


if __name__ == "__main__":
    main()
