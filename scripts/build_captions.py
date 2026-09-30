"""Write captions for the listening feed: /listen/captions/<slug>.json, one file per episode.

Only the talk inside published questions' answer spans is written (headline questions in front matter,
chapter questions in _data/chapter_questions.json that are not hidden), so the transcript is never
published whole and nothing from a hidden question's span leaks unless another public answer covers it.

Transcript segments run about 30 seconds, too long to read along, so each is cut into short lines at
sentence ends (and at commas when still long), and the segment's time is shared out by line length.
Speakers come from the transcript's confirmed speaker_identities, shown with the performer's face.

    python scripts/build_captions.py
"""

import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_site_data import load_actors  # noqa: E402
from locate_questions import POSTS, ROOT, read_questions, split_front  # noqa: E402

OUTPUT = ROOT / "listen" / "captions"
TRANSCRIPTS = ROOT / "transcripts"
CHAPTER_QUESTIONS = ROOT / "_data" / "chapter_questions.json"
# A caption line longer than this is split again at a comma or, failing that, by length.
LINE_CHARS = 34
# Answers can start a few seconds before the question's time; keep a little lead-in.
MARGIN_SECONDS = 5


def seconds(value: str) -> int:
    return sum(int(part) * unit for part, unit in zip(value.split(":"), (3600, 60, 1)))


def split_lines(text: str) -> list[str]:
    """Short readable lines: sentence ends first, then commas, then plain length."""
    text = re.sub(r"\s+", " ", text).strip()
    lines = []
    for sentence in re.findall(r"[^。！？!?]+[。！？!?]*", text):
        sentence = sentence.strip()
        while len(sentence) > LINE_CHARS:
            cut = max(sentence.rfind("、", 0, LINE_CHARS), sentence.rfind(" ", 0, LINE_CHARS))
            cut = cut + 1 if cut >= LINE_CHARS // 2 else LINE_CHARS
            lines.append(sentence[:cut].strip())
            sentence = sentence[cut:].strip()
        if sentence:
            lines.append(sentence)
    return lines


def spans_of(front: str, chapter_questions: list[dict]) -> list[tuple[int, int, int]]:
    """Merged (part, start, end) spans of the episode's published answers."""
    spans = []
    for question in read_questions(front):
        if question.get("time") and question.get("end"):
            spans.append((int(question.get("part") or 1) - 1, seconds(question["time"]), seconds(question["end"])))
    for question in chapter_questions:
        if not question.get("hidden"):
            spans.append((int(question.get("part") or 1) - 1, seconds(question["time"]), seconds(question["end"])))
    merged = []
    for part, start, end in sorted(spans):
        if merged and merged[-1][0] == part and start <= merged[-1][2] + MARGIN_SECONDS:
            merged[-1] = (part, merged[-1][1], max(merged[-1][2], end))
        else:
            merged.append((part, start, end))
    return merged


def main() -> None:
    actors = load_actors()
    chapter_questions = json.loads(CHAPTER_QUESTIONS.read_text(encoding="utf-8"))
    OUTPUT.mkdir(parents=True, exist_ok=True)
    written = set()
    total = 0
    for path in sorted(POSTS.glob("*.md")):
        match = re.match(r"\d{4}-\d{2}-\d{2}-(.+)\.md$", path.name)
        if not match:
            continue
        slug = match.group(1)
        transcript = TRANSCRIPTS / "proofread" / f"Ep{slug}.json"
        if not transcript.exists():
            continue
        front, _, _ = split_front(path.read_bytes().decode("utf-8"))
        spans = spans_of(front, chapter_questions.get(slug, []))
        if not spans:
            continue
        data = json.loads(transcript.read_text(encoding="utf-8"))
        identities = data.get("speaker_identities", {})

        speakers, keys = {}, {}
        lines = []
        for segment in data.get("segments", []):
            part = segment.get("part", 1) - 1
            start, end = float(segment["start"]), float(segment["end"])
            if not any(p == part and start < high + MARGIN_SECONDS and end > low - MARGIN_SECONDS for p, low, high in spans):
                continue
            identity = identities.get(segment.get("speaker") or "", {})
            speaker = ""
            if identity.get("status") == "confirmed" and identity.get("actor_id"):
                actor_id = identity["actor_id"]
                if actor_id not in keys:
                    keys[actor_id] = f"s{len(keys)}"
                    actor = actors.get(actor_id, {})
                    speakers[keys[actor_id]] = [actor.get("name") or identity.get("name", ""), actor.get("image_url", ""),
                                                identity.get("role") == "host"]
                speaker = keys[actor_id]
            pieces = split_lines(segment.get("text", ""))
            length = sum(len(piece) for piece in pieces) or 1
            at = start
            for piece in pieces:
                # Keep only lines inside an answer span; a segment can straddle a span's edge.
                if any(p == part and low - MARGIN_SECONDS <= at < high for p, low, high in spans):
                    lines.append([part, round(at, 1), speaker, piece])
                at += (end - start) * len(piece) / length
        if not lines:
            continue
        out = OUTPUT / f"{slug}.json"
        out.write_text(json.dumps({"speakers": speakers, "lines": lines}, ensure_ascii=False, separators=(",", ":")) + "\n",
                       encoding="utf-8", newline="\n")
        written.add(out.name)
        total += len(lines)
    for stale in OUTPUT.glob("*.json"):
        if stale.name not in written:
            stale.unlink()
    size = sum(path.stat().st_size for path in OUTPUT.glob("*.json"))
    print(f"{len(written)} episodes, {total} caption lines, {size // 1024} KB")


if __name__ == "__main__":
    main()
