#!/usr/bin/env python3
"""Build Jekyll data for episode cards, guest pages, topics and the random scene button.

Private sources (transcripts/ and transcripts/analytics/) are optional. When they are
missing, values derived from them are carried over from the previous output so the
result does not depend on which machine runs the script.
"""
from __future__ import annotations

import csv
from datetime import date
import json
from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[1]
POSTS = ROOT / "_posts"
TRANSCRIPTS = ROOT / "transcripts" / "text"
ANALYTICS = ROOT / "transcripts" / "analytics" / "あらB.fm_TrendsChart_AvgConsumptionTime_First30Days.csv"
FEATURED = ROOT / "_data" / "featured_episodes.yml"
DATA = ROOT / "_data"
GUEST_PAGES = ROOT / "_guests"
HOST = "ark_B"
POPULAR_LIMIT = 6

# Chips on the home page. `terms` are matched against show notes to count episodes.
TOPICS = [
    {"label": "AI", "q": "AI", "terms": ["AI", "ChatGPT", "LLM", "Claude", "Codex"]},
    {"label": "本", "q": "読書", "terms": ["課題図書", "おすすめ本", "読書", "小説"]},
    {"label": "映画", "q": "映画", "terms": ["映画"]},
    {"label": "漫画", "q": "漫画", "terms": ["漫画", "マンガ"]},
    {"label": "ゲーム", "q": "ゲーム", "terms": ["ゲーム"]},
    {"label": "音楽", "q": "音楽", "terms": ["音楽", "ライブ", "アルバム"]},
    {"label": "仕事", "q": "仕事", "terms": ["仕事", "転職", "働き方"]},
    {"label": "旅行", "q": "旅行", "terms": ["旅行", "旅"]},
]

TIME_RE = re.compile(r"^(\d{1,2}):(\d{2}):(\d{2})\s+(.+)$")
LINK_RE = re.compile(r"\[([^\]]+)\]\([^)]+\)")


def seconds(hms: str) -> int:
    parts = [int(part) for part in hms.split(":")]
    while len(parts) < 3:
        parts.insert(0, 0)
    return parts[0] * 3600 + parts[1] * 60 + parts[2]


def load_actors() -> dict[str, dict]:
    config = (ROOT / "_config.yml").read_text(encoding="utf-8-sig")
    block = re.search(r"^actors:\n((?:[ \t]+.*\n|\n)+)", config, re.MULTILINE).group(1)
    actors: dict[str, dict] = {}
    current = None
    for line in block.splitlines():
        if re.match(r"^  \S", line):
            current = line.strip().rstrip(":").strip("'\"")
            actors[current] = {}
        elif current and (match := re.match(r"^\s{4}(\w+):\s*(.*)$", line)):
            actors[current][match.group(1)] = match.group(2).strip().strip("'\"")
    return actors


def front_value(front: str, key: str) -> str:
    match = re.search(rf"^{key}:[ \t]*(.*)$", front, re.MULTILINE)
    return match.group(1).strip().strip("'\"") if match else ""


def load_posts() -> list[dict]:
    posts = []
    for path in POSTS.glob("*.md"):
        match = re.match(r"(\d{4}-\d{2}-\d{2})-(.+)\.md$", path.name)
        if not match:
            continue
        source = path.read_text(encoding="utf-8-sig")
        front, body = source.split("---", 2)[1:]
        actors_match = re.search(r"^actor_ids:\s*\n((?:\s+- .+\n?)+)", front, re.MULTILINE)
        actors = re.findall(r"^\s+-\s+(.+)$", actors_match.group(1), re.MULTILINE) if actors_match else []
        title = front_value(front, "title")
        title_match = re.match(r"Ep\.\s*([\w.-]+)\s+(.*?)\s*(?:\([^)]*\))?\s*$", title)
        chapters = []
        part = 0
        for heading in re.findall(r"^##\s+(.+)$", body, re.MULTILINE):
            chapter = TIME_RE.match(heading.strip())
            if not chapter:
                continue
            start = seconds(":".join(chapter.groups()[:3]))
            if chapters and start < chapters[-1]["s"] and chapters[-1]["p"] == part:
                part += 1
            chapters.append({
                "t": ":".join(chapter.groups()[:3]),
                "s": start,
                "p": part,
                "title": LINK_RE.sub(r"\1", chapter.group(4)).strip(),
            })
        posts.append({
            "slug": match.group(2),
            "date": match.group(1),
            "title": title,
            "subtitle": title_match.group(2) if title_match else title,
            "number": title_match.group(1) if title_match else match.group(2),
            "guests": [actor.strip() for actor in actors if actor.strip() != HOST],
            "audio_ids": [value.strip() for value in front_value(front, "audio_url").split(",") if value.strip()],
            "duration": front_value(front, "duration"),
            "chapters": chapters,
            "text": " ".join([title, front_value(front, "description"), body]),
        })
    return sorted(posts, key=lambda post: (post["date"], post["slug"]), reverse=True)


def transcript_minutes(slug: str) -> int | None:
    for name in (slug, slug.replace("_", "-"), slug.replace("-", "_")):
        path = TRANSCRIPTS / f"Ep{name}.md"
        if path.exists():
            stamps = re.findall(r"^\[(\d\d:\d\d:\d\d)\]", path.read_text(encoding="utf-8-sig"), re.MULTILINE)
            if stamps:
                return round(seconds(stamps[-1]) / 60)
    return None


def episode_key(post: dict) -> str:
    return re.sub(r"-\d+$", "", post["number"])


def months_between(earlier: str, later: str) -> int:
    a, b = date.fromisoformat(earlier), date.fromisoformat(later)
    return (b.year - a.year) * 12 + b.month - a.month


def gap_label(months: int) -> str:
    if months >= 12:
        years, rest = divmod(months, 12)
        return f"{years}年{rest}か月ぶり" if rest else f"{years}年ぶり"
    return f"{months}か月ぶり" if months >= 2 else "前回に続いて"


def read_json(path: Path, default):
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else default


def write_json(path: Path, value) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=1) + "\n", encoding="utf-8", newline="\n")


def build_popular(posts: list[dict]) -> list[dict] | None:
    if not ANALYTICS.exists():
        return None
    featured = set(re.findall(r'^- episode: "?([\w-]+)"?', FEATURED.read_text(encoding="utf-8"), re.MULTILINE))
    by_title = {post["title"]: post for post in posts}
    rows = []
    with ANALYTICS.open(encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            post = by_title.get(row["エピソード名"].strip())
            if not post or post["slug"] in featured or not post["audio_ids"]:
                continue
            rows.append((float(row["平均視聴時間 (時間)"] or 0), post["slug"]))
    # Depth of listening in the first 30 days is comparable across old and new episodes.
    return [{"slug": slug} for _, slug in sorted(rows, reverse=True)[:POPULAR_LIMIT]]


def latest_gap(history: list[dict]) -> str | None:
    """How long the guest had been away before their latest appearance ("1年9か月ぶり"), None on a first visit.
    Parts of one recording count as one appearance."""
    latest = history[-1]
    earlier = [post for post in history if episode_key(post) != episode_key(latest)]
    return gap_label(months_between(earlier[-1]["date"], latest["date"])) if earlier else None


def main() -> None:
    actors = load_actors()
    posts = load_posts()
    previous = {item["slug"]: item for item in read_json(DATA / "episode_index.json", [])}

    appearances: dict[str, list[dict]] = {}
    for post in reversed(posts):
        for guest in post["guests"]:
            appearances.setdefault(guest, []).append(post)

    index = []
    for post in posts:
        minutes = None
        if post["duration"] and post["duration"] != "00:00":
            minutes = round(seconds(post["duration"]) / 60)
        minutes = minutes or transcript_minutes(post["slug"]) or previous.get(post["slug"], {}).get("minutes")

        returns = []
        for guest in post["guests"]:
            # Parts of one recording (Ep. 118-1, 118-2) count as a single appearance.
            earlier = [item for item in appearances[guest] if item["date"] < post["date"] and episode_key(item) != episode_key(post)]
            if not earlier:
                returns.append({"id": guest, "first": True})
            else:
                before = earlier[-1]
                returns.append({
                    "id": guest,
                    "first": False,
                    "count": len({episode_key(item) for item in earlier}) + 1,
                    "prev": before["slug"],
                    "gap": gap_label(months_between(before["date"], post["date"])),
                    "months": months_between(before["date"], post["date"]),
                })

        index.append({
            "slug": post["slug"],
            "number": post["number"],
            "subtitle": post["subtitle"],
            "date": post["date"],
            "guests": post["guests"],
            "minutes": minutes,
            "chapter_count": len(post["chapters"]),
            "returns": returns,
            "audio": post["audio_ids"][0] if post["audio_ids"] else "",
            # Random scenes only use chapters of the first audio part, which the page's player loads.
            "scenes": [[c["s"], c["title"]] for c in post["chapters"] if c["p"] == 0 and c["s"] > 0]
            if len(post["audio_ids"]) == 1 else [],
        })
    write_json(DATA / "episode_index.json", index)

    guests = {}
    for guest, history in appearances.items():
        if guest not in actors:
            continue
        guests[guest] = {
            "count": len({episode_key(post) for post in history}),
            "first": history[0]["slug"],
            "latest": history[-1]["slug"],
            # The relationship told on the guest lists: since when, and how the latest visit came about.
            "first_number": re.sub(r"-\d+$", "", history[0]["number"]),
            "since": history[0]["date"][:4],
            "latest_number": re.sub(r"-\d+$", "", history[-1]["number"]),
            "latest_gap": latest_gap(history),
            "episodes": [post["slug"] for post in reversed(history)],
            "friends": sorted(
                {other for post in history for other in post["guests"] if other != guest and other in actors},
                # Ties by name, so the order does not change from run to run with the set's hashing.
                key=lambda other: (-sum(other in post["guests"] for post in history), other.lower()),
            )[:8],
        }
    write_json(DATA / "guests.json", dict(sorted(guests.items(), key=lambda item: (-item[1]["count"], item[0].lower()))))

    GUEST_PAGES.mkdir(exist_ok=True)
    wanted = set()
    for guest in guests:
        path = GUEST_PAGES / f"{guest}.md"
        wanted.add(path.name)
        name = actors[guest].get("name", guest).replace('"', '\\"')
        # The address is spelled out: Jekyll's :name drops a handle's trailing "_" (asesama_ -> /guest/asesama/),
        # while every link builds /guest/<handle>/.
        content = f'---\nactor_id: "{guest}"\ntitle: "{name}さんの出演回"\npermalink: /guest/{guest}/\n---\n'
        if not path.exists() or path.read_text(encoding="utf-8") != content:
            path.write_text(content, encoding="utf-8", newline="\n")
    for path in GUEST_PAGES.glob("*.md"):
        if path.name not in wanted:
            path.unlink()

    topics = []
    for topic in TOPICS:
        count = sum(any(term in post["text"] for term in topic["terms"]) for post in posts)
        topics.append({"label": topic["label"], "q": topic["q"], "count": count})
    write_json(DATA / "topics.json", topics)

    popular = build_popular(posts)
    if popular is not None:
        write_json(DATA / "popular_episodes.json", popular)

    print(f"{len(index)} episodes, {len(guests)} guests, popular={'updated' if popular is not None else 'kept'}")


if __name__ == "__main__":
    main()
