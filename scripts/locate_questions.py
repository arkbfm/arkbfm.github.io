"""Give each episode question a start time so the site can play the part that answers it.

A question is matched to the chapter whose heading and notes share its words, then to the first
transcript segment in that chapter that mentions them (transcripts/proofread, falling back to raw).
Questions that already have a time are left alone, so hand-picked times survive reruns.
Episodes published as several audio files also get the question's part (1-based), since each file restarts at 0.

    python scripts/locate_questions.py            # write times into _posts
    python scripts/locate_questions.py --dry-run  # print the report only
"""

import argparse
import json
import math
import re
import sys
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
POSTS = ROOT / "_posts"
TRANSCRIPTS = ROOT / "transcripts"

HEADING_RE = re.compile(r"^##\s+(.+)$", re.MULTILINE)
TIME_RE = re.compile(r"^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\s+(.+)$")
LINK_RE = re.compile(r"\[([^\]]+)\]\([^)]+\)")
TERM_RE = re.compile(r"[「『]([^」』]+)[」』]|[ァ-ヴー]{2,}|[一-龥々]{2,}|[A-Za-z0-9][A-Za-z0-9.+]+|[ぁ-ん]{3,}")
# Words that make up the question's form rather than its subject.
STOP = {"どうだった", "とは", "どんな", "どうやって", "ってどんな", "どう", "なぜ", "何", "魅力", "おすすめ", "最近",
        "振り返ると", "どこ", "どちら", "もの", "こと", "ある", "いい", "する", "には", "ている", "だった"}
# A match this close to the chapter start is the chapter's own opening; start there instead.
SNAP_SECONDS = 45
# Start a little before the matched segment so the answer is not cut mid-sentence.
LEAD_SECONDS = 3


def hms(total: int) -> str:
    return f"{total // 3600:02d}:{total % 3600 // 60:02d}:{total % 60:02d}"


def normalize(text: str) -> str:
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", text)).lower()


def bigrams(text: str) -> set[str]:
    """Pairs of content characters, for questions whose subject is a one-kanji word or mixed script."""
    text = re.sub(r"[^\w]", "", normalize(text))
    pairs = {text[index:index + 2] for index in range(len(text) - 1)}
    return {pair for pair in pairs if not re.fullmatch(r"[ぁ-ん]+", pair)}


def terms_of(question: str) -> list[str]:
    found = []
    for match in TERM_RE.finditer(question):
        term = normalize(match.group(1) or match.group(0))
        if term and term not in STOP and term not in found:
            found.append(term)
    return found


def split_front(source: str) -> tuple[str, str, str]:
    newline = "\r\n" if "\r\n" in source else "\n"
    end = source.index(newline + "---", 3)
    return source[:end], source[end:], newline


def read_questions(front: str) -> list[dict]:
    block = re.search(r"^questions:[ \t]*\r?\n((?:[ \t]+.*\r?\n?)+)", front + "\n", re.MULTILINE)
    if not block:
        return []
    questions = []
    for line in block.group(1).splitlines():
        item = re.match(r"^\s+-\s+(?:(text|time|part):\s*)?(.*)$", line)
        field = re.match(r"^\s+(text|time|part):\s*(.*)$", line)
        if item:
            questions.append({})
            key, value = item.group(1) or "text", item.group(2)
        elif field and questions:
            key, value = field.group(1), field.group(2)
        else:
            continue
        value = value.strip()
        if value.startswith('"'):
            value = json.loads(value)
        questions[-1][key] = value.strip("'")
    return questions


def write_questions(front: str, questions: list[dict], newline: str) -> str:
    def scalar(text: str) -> str:
        return json.dumps(text, ensure_ascii=False) if re.search(r": | #|^[-?:,\[\]{}#&*!|>'\"%@`]", text) else text

    lines = ["questions:"]
    for question in questions:
        lines.append("  - text: " + scalar(question["text"]))
        if question.get("time"):
            lines.append(f'    time: "{question["time"]}"')
        if question.get("part"):
            lines.append(f'    part: {question["part"]}')
    block = newline.join(lines)
    return re.sub(r"^questions:[ \t]*\r?\n(?:[ \t]+.*(?:\r?\n|$))+", lambda _: block + newline, front + newline, count=1, flags=re.MULTILINE)[: -len(newline)]


def chapters_of(body: str, parts: int) -> list[dict]:
    """Chapters with the notes under each and their audio part (0-based); timestamps restart with each part."""
    heads = list(HEADING_RE.finditer(body))
    chapters = []
    part = 0
    for index, head in enumerate(heads):
        match = TIME_RE.match(head.group(1).strip())
        if not match:
            continue
        start = int(match.group(1) or 0) * 3600 + int(match.group(2)) * 60 + int(match.group(3))
        if chapters and start < chapters[-1]["s"]:
            part += 1
            if part >= parts:
                break
        end = heads[index + 1].start() if index + 1 < len(heads) else len(body)
        notes = LINK_RE.sub(r"\1", body[head.start():end])
        chapters.append({"s": start, "p": part, "title": LINK_RE.sub(r"\1", match.group(4)).strip(), "text": normalize(notes)})
    return chapters


def load_segments(slug: str) -> list[dict]:
    for folder in ("proofread", "raw"):
        path = TRANSCRIPTS / folder / f"Ep{slug}.json"
        if path.exists():
            data = json.loads(path.read_text(encoding="utf-8"))
            # Transcripts of multi-file episodes number their parts from 1 and restart the clock in each.
            return [{"start": seg["start"], "p": seg.get("part", 1) - 1, "text": normalize(seg.get("text", ""))}
                    for seg in data.get("segments", [])]
    return []


def bullets_of(body: str) -> list[str]:
    return [normalize(LINK_RE.sub(r"\1", line)) for line in re.findall(r"^\s*[*-]\s+(.+)$", body, re.MULTILINE)]


def locate_by_order(terms: list[str], bullets: list[str], segments: list[dict]) -> tuple[int | None, int, str, str]:
    """Without timed chapters, the notes still follow the talk: weight matches near the bullet's share of the episode."""
    scores = [sum(len(term) for term in terms if term in bullet) for bullet in bullets]
    if not scores or max(scores) == 0 or not segments:
        return None, 0, "", ""
    expected = (scores.index(max(scores)) + 0.5) / len(bullets)
    count = len(segments)
    weights = {term: math.log((count + 1) / (1 + sum(term in seg["text"] for seg in segments))) for term in terms}
    duration = segments[-1]["start"] or 1
    best, found = 0.0, None
    for index, seg in enumerate(segments):
        # A topic is talked about for a while, so count each term once across a few neighbouring segments.
        nearby = "".join(item["text"] for item in segments[index:index + 3])
        hits = sum(weights[term] * len(term) for term in terms if term in nearby)
        if not hits or not any(term in seg["text"] for term in terms):
            continue
        score = hits * math.exp(-abs(seg["start"] / duration - expected) / 0.2)
        if score > best:
            best, found = score, seg
    if not found:
        return None, 0, "", ""
    return max(0, int(found["start"]) - LEAD_SECONDS), found["p"], "(notes order)", found["text"][:50]


def locate(question: str, chapters: list[dict], segments: list[dict], bullets: list[str]) -> tuple[int | None, int, str, str]:
    """Start second, audio part (0-based), and the chapter and transcript text it was found in."""
    terms = terms_of(question) or sorted(bigrams(question))
    if not chapters:
        return locate_by_order(terms, bullets, segments)
    chapter = None
    if chapters:
        # A term in the heading names the chapter's subject; one in its notes may be a passing mention.
        scores = [sum(len(term) * (3 if term in normalize(chapter["title"]) else 1) for term in terms if term in chapter["text"])
                  for chapter in chapters]
        if max(scores) == 0:
            pairs = bigrams(question)
            scores = [sum(pair in chapter["text"] for pair in pairs) for chapter in chapters]
        if max(scores) > 0:
            chapter = chapters[scores.index(max(scores))]

    if chapter:
        index = chapters.index(chapter)
        low = chapter["s"]
        following = chapters[index + 1] if index + 1 < len(chapters) else None
        high = following["s"] if following and following["p"] == chapter["p"] else math.inf
        window = [seg for seg in segments if seg["p"] == chapter["p"] and low <= seg["start"] < high]
    else:
        low = 0
        window = segments
    if window:
        count = len(segments)
        weights = {term: math.log((count + 1) / (1 + sum(term in seg["text"] for seg in segments))) for term in terms}
        scored = [(sum(weights[term] * len(term) for term in terms if term in seg["text"]), seg) for seg in window]
        best = max(score for score, _ in scored)
        if best > 0:
            # The first segment that clearly mentions the subject is where its discussion begins.
            score, seg = next(item for item in scored if item[0] >= best * 0.6)
            start = max(int(low), int(seg["start"]) - LEAD_SECONDS)
            if chapter and start - chapter["s"] < SNAP_SECONDS:
                start = chapter["s"]
            return start, seg["p"], chapter["title"] if chapter else "(transcript)", seg["text"][:50]

    if chapter:
        return chapter["s"], chapter["p"], chapter["title"], ""
    return None, 0, "", ""


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")

    for path in sorted(POSTS.glob("*.md")):
        match = re.match(r"\d{4}-\d{2}-\d{2}-(.+)\.md$", path.name)
        if not match:
            continue
        slug = match.group(1)
        source = path.read_bytes().decode("utf-8")
        front, rest, newline = split_front(source)
        questions = read_questions(front)
        if not questions or all(question.get("time") for question in questions):
            continue
        audio = re.search(r"^audio_url:[ \t]*(.*)$", front, re.MULTILINE)
        parts = len([value for value in audio.group(1).split(",") if value.strip()]) if audio else 0
        if not parts:
            continue

        chapters = chapters_of(rest, parts)
        segments = load_segments(slug)
        bullets = bullets_of(rest)
        for question in questions:
            if question.get("time"):
                continue
            start, part, where, snippet = locate(question["text"], chapters, segments, bullets)
            if start is not None:
                question["time"] = hms(start)
                if parts > 1:
                    question["part"] = part + 1
            print(f"{slug}\t{question.get('part', '')}\t{question.get('time', '-')}\t{question['text']}\t[{where}] {snippet}")

        if not args.dry_run:
            path.write_bytes((write_questions(front, questions, newline) + rest).encode("utf-8"))


if __name__ == "__main__":
    main()
