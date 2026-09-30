"""Write one share page per question (_clips/<id>.md -> /q/<id>/) so a single answer can be posted and found.

Headline questions come from each post's front matter (id "<slug>-<n>"), chapter questions from
_data/chapter_questions.json (id "<slug>-c<n>"). Pages no longer backed by a question are removed.

    python scripts/build_clip_pages.py
"""

import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from locate_questions import LINK_RE, POSTS, ROOT, chapters_of, read_questions, split_front  # noqa: E402

# Show-note bullets of the answering chapter shown on a question page: written by hand, so each page
# carries text of its own besides the generated question.
NOTES_PER_PAGE = 8

CLIPS = ROOT / "_clips"
CHAPTER_QUESTIONS = ROOT / "_data" / "chapter_questions.json"
CLIP_RELATED = ROOT / "_data" / "clip_related.json"
EPISODE_INDEX = ROOT / "_data" / "episode_index.json"
QUESTION_IMAGES = ROOT / "images" / "og" / "q"


def quoted(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def seconds(value: str) -> int:
    hours, minutes, secs = (int(part) for part in value.split(":"))
    return hours * 3600 + minutes * 60 + secs


def page_name(clip_id: str) -> str:
    """166.1 -> 166-1, 166.c3 -> 166-c3, 118.5.2 -> 118-5-2: what Jekyll's :name slug makes of the file name
    anyway, and how the feed builds its share links."""
    return re.sub(r"[^a-z0-9]+", "-", clip_id.lower()).strip("-")


def chapter_notes(chapters: list[dict], question: dict) -> tuple[str, list[str]]:
    """The heading and bullet points of the chapter the question is answered in."""
    part = int(question.get("part") or 1) - 1
    start = seconds(question["time"])
    chapter = None
    for candidate in chapters:
        if candidate["p"] == part and candidate["s"] <= start:
            chapter = candidate
    if not chapter:
        return "", []
    bullets = []
    for line in chapter["raw"].splitlines():
        match = re.match(r"^\s*[*-]\s+(.+)$", line)
        if match:
            text = re.sub(r"https?://\S+", "", LINK_RE.sub(r"\1", match.group(1))).strip(" ：:")
            if text:
                bullets.append(text)
    return chapter["title"], bullets[:NOTES_PER_PAGE]


def page(clip_id: str, slug: str, question: dict, headline: bool, episode: dict, related: list[dict],
         notes: list[str]) -> str:
    minutes = max(1, round((seconds(question["end"]) - seconds(question["time"])) / 60))
    where = f"Ep.{episode.get('number', slug)} {episode.get('subtitle', '')}" + (f"「{question['chapter']}」" if question.get("chapter") else "")
    lines = ["---", f"clip: {quoted(clip_id)}", f"episode: {quoted(slug)}", f"question: {quoted(question['text'])}",
             f"time: {quoted(question['time'])}", f"end: {quoted(question['end'])}", f"minutes: {minutes}"]
    if question.get("part"):
        lines.append(f"part: {int(question['part'])}")
    if question.get("chapter"):
        lines.append(f"chapter: {quoted(question['chapter'])}")
    if headline:
        lines.append(f"headline: {clip_id.split('.')[-1]}")
    lines.append(f"title: {quoted('Q. ' + question['text'])}")
    # Headline questions have a share image with the question on it (build_question_images.py).
    if headline and (QUESTION_IMAGES / (page_name(clip_id) + ".jpg")).exists():
        lines.append(f"image: {quoted('/images/og/q/' + page_name(clip_id) + '.jpg')}")
    lines.append(f"description: {quoted(f'あらB.fm {where}で話している、この問いへの答え（約{minutes}分）をつまみ聴きで。')}")
    if notes:
        lines.append("notes:")
        lines += [f"  - {quoted(note)}" for note in notes]
    if related:
        lines.append("related:")
        for item in related:
            lines.append(f"  - page: {quoted(page_name(item['id']))}")
            lines.append(f"    question: {quoted(item['text'])}")
            lines.append(f"    episode: {quoted(item['episode'])}")
            lines.append(f"    reason: {quoted(item['reason'])}")
    lines += ["---", ""]
    return "\n".join(lines)


def load(path: Path, empty):
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else empty


def main() -> None:
    chapter_questions = load(CHAPTER_QUESTIONS, {})
    clip_related = load(CLIP_RELATED, {})
    episodes = {episode["slug"]: episode for episode in load(EPISODE_INDEX, [])}

    # Every clip first, so related links can show the question they lead to.
    clips = {}
    chapters = {}
    for path in sorted(POSTS.glob("*.md")):
        match = re.match(r"\d{4}-\d{2}-\d{2}-(.+)\.md$", path.name)
        if not match:
            continue
        slug = match.group(1)
        front, rest, _ = split_front(path.read_bytes().decode("utf-8"))
        audio = re.search(r"^audio_url:[ \t]*(.*)$", front, re.MULTILINE)
        parts = len([value for value in audio.group(1).split(",") if value.strip()]) if audio else 1
        chapters[slug] = chapters_of(rest, max(parts, 1))
        for index, question in enumerate(read_questions(front), 1):
            if question.get("time") and question.get("end"):
                clips[f"{slug}.{index}"] = (slug, question, True)
        for index, question in enumerate(chapter_questions.get(slug, []), 1):
            # Hidden by review_questions.py: no page, and no links to it from other pages.
            if not question.get("hidden"):
                clips[f"{slug}.c{index}"] = (slug, question, False)

    names = [page_name(clip_id) for clip_id in clips]
    clashes = {name for name in names if names.count(name) > 1}
    if clashes:
        raise SystemExit(f"clip ids share a page name: {sorted(clashes)}")

    wanted = {}
    for clip_id, (slug, question, headline) in clips.items():
        related = []
        for spot in clip_related.get(clip_id, []):
            if spot.get("i") in clips:
                other_slug, other, _ = clips[spot["i"]]
                other_episode = episodes.get(other_slug, {})
                related.append({"id": spot["i"], "text": other["text"], "reason": spot.get("r", ""),
                                "episode": f"Ep.{other_episode.get('number', other_slug)} {other_episode.get('subtitle', '')}"})
        title, notes = chapter_notes(chapters[slug], question)
        if title and not question.get("chapter"):
            question = dict(question, chapter=title)
        wanted[page_name(clip_id) + ".md"] = page(clip_id, slug, question, headline, episodes.get(slug, {}), related, notes)

    CLIPS.mkdir(exist_ok=True)
    changed = 0
    for name, content in wanted.items():
        path = CLIPS / name
        if not path.exists() or path.read_text(encoding="utf-8") != content:
            path.write_text(content, encoding="utf-8", newline="\n")
            changed += 1
    removed = 0
    for path in CLIPS.glob("*.md"):
        if path.name not in wanted:
            path.unlink()
            removed += 1
    print(f"{len(wanted)} clip pages ({changed} written, {removed} removed)")


if __name__ == "__main__":
    main()
