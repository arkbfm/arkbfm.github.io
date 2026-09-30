"""Write captions for the listening feed: /listen/captions/<slug>.json, one file per episode.

Only the talk inside published questions' answer spans is written (headline questions in front matter,
chapter questions in _data/chapter_questions.json that are not hidden), so the transcript is never
published whole and nothing from a hidden question's span leaks unless another public answer covers it.

Transcript segments run about 30 seconds, too long to read along, so each is cut into short lines at
sentence ends, and long sentences at BudouX phrase boundaries (as podclip's burned-in subtitles do);
the segment's time is shared out by line length. Inside a line the phrases are joined with a zero-width
space, so the page (word-break: keep-all) wraps only between phrases, never mid-word; the files store it as "|"
(one byte instead of three).
Speakers come from the transcript's confirmed speaker_identities, shown with the performer's face.

    python scripts/build_captions.py        # needs: pip install budoux
"""

import bisect
import json
import re
import sys
from pathlib import Path

import budoux

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_site_data import load_actors  # noqa: E402
from locate_questions import POSTS, ROOT, read_questions, split_front  # noqa: E402

OUTPUT = ROOT / "listen" / "captions"
TRANSCRIPTS = ROOT / "transcripts"
CHAPTER_QUESTIONS = ROOT / "_data" / "chapter_questions.json"
# A caption line holds at most this many characters (two lines on a phone), as in podclip.
LINE_CHARS = 26
# A leftover this short joins the line before it, unless that makes the line far too long.
TAIL_CHARS = 4
# Answers can start a few seconds before the question's time; keep a little lead-in.
MARGIN_SECONDS = 5
# Past this many characters, a line closes after a phrase that ends a clause (the transcripts have
# few punctuation marks, so this is what keeps "…人も / いるかもしれない" from being cut mid-clause).
CLAUSE_CHARS = 13
CLAUSE_END = re.compile(r"(ね|よね|よ|な|けど|けれど|ので|から|って|です|ます|した|たら|ても|でしょう|じゃん)$")
# Marks where the page may wrap a line: between BudouX phrases (the page turns it into a zero-width space).
BREAK = "|"
PARSER = budoux.load_default_japanese_parser()


def seconds(value: str) -> int:
    return sum(int(part) * unit for part, unit in zip(value.split(":"), (3600, 60, 1)))


def phrases(text: str) -> list[str]:
    """BudouX phrases, minus the boundaries that would strand a bracket, a punctuation mark, or an
    English word after Japanese (the same rules as podclip's budoux_phrases)."""
    safe = []
    for phrase in PARSER.parse(text):
        if safe and (
            safe[-1][-1] in "『「（(【" or phrase[0] in "』」）)】、。，,.!?！？ー〜"
            or (re.search(r"[ぁ-んァ-ヶ一-龠]$", safe[-1]) and re.match(r"[A-Za-z]", phrase))
        ):
            safe[-1] += phrase
        else:
            safe.append(phrase)
    return safe


def split_lines(text: str) -> list[str]:
    """Short readable lines: sentence ends first, then BudouX phrases packed up to LINE_CHARS, closing
    early after a clause ending. Each line keeps BREAK between its phrases."""
    text = re.sub(r"\s+", " ", text.replace(BREAK, "｜")).strip()
    lines = []
    for sentence in re.findall(r"[^。！？!?]+[。！？!?]*", text):
        chunks, current = [], []
        for phrase in phrases(sentence.strip()):
            if current and len("".join(current) + phrase) > LINE_CHARS:
                chunks.append(current)
                current = [phrase]
            else:
                current.append(phrase)
            if len("".join(current)) > CLAUSE_CHARS and CLAUSE_END.search(phrase):
                chunks.append(current)
                current = []
        if current:
            if chunks and len("".join(current)) <= TAIL_CHARS and len("".join(chunks[-1] + current)) <= LINE_CHARS + TAIL_CHARS:
                chunks[-1] += current
            else:
                chunks.append(current)
        lines += [BREAK.join(part.strip() for part in chunk if part.strip()) for chunk in chunks]
    return [line for line in lines if line]


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


class Turns:
    """Who talks when, from the episode's diarization (transcripts/diarization/Ep<slug>.json).

    Transcript segments run 20-30 seconds and often hold both voices, so a caption line takes the
    speaker who talks most during the line itself; the segment's speaker is only the fallback. The
    labels go through the same part mapping the transcript was integrated with, so they match its
    reviewed speaker_identities. Used only when the diarization file is the one the transcript was
    integrated from."""

    def __init__(self, slug: str, transcript: dict):
        self.parts = {}
        meta = transcript.get("diarization") or {}
        path = TRANSCRIPTS / "diarization" / f"Ep{slug}.json"
        if not meta or not path.exists():
            return
        diarization = json.loads(path.read_text(encoding="utf-8"))
        if diarization.get("generated_at") != meta.get("generated_at"):
            return
        by_number = {int(part["part"]): part for part in diarization["parts"]}
        for raw_part, diar_part in meta.get("raw_to_diarization_part", {}).items():
            part = by_number.get(int(diar_part))
            if not part:
                continue
            turns = sorted(part.get("exclusive_turns") or part["regular_turns"], key=lambda turn: turn["start"])
            self.parts[int(raw_part) - 1] = {
                "turns": turns,
                "starts": [turn["start"] for turn in turns],
                "offset": float(meta.get("raw_part_time_offsets", {}).get(raw_part, 0.0)),
                "map": meta.get("part_speaker_maps", {}).get(str(diar_part), {}),
            }

    def speaker(self, part: int, start: float, end: float) -> str | None:
        """The (transcript) speaker label talking longest between start and end, or None."""
        info = self.parts.get(part)
        if not info:
            return None
        start, end = start + info["offset"], end + info["offset"]
        talk = {}
        index = max(0, bisect.bisect_right(info["starts"], start) - 1)
        # Turns are short, so a few before the line's start are enough to catch one overlapping it.
        for turn in info["turns"][max(0, index - 3):]:
            if turn["start"] >= end:
                break
            overlap = min(end, turn["end"]) - max(start, turn["start"])
            if overlap > 0:
                talk[turn["speaker"]] = talk.get(turn["speaker"], 0.0) + overlap
        if not talk:
            return None
        local = max(talk, key=talk.get)
        return info["map"].get(local, local)


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
        turns = Turns(slug, data)

        speakers, keys = {}, {}

        def key_of(label: str | None) -> str | None:
            """The caption file's speaker key for a transcript label, or None when not a confirmed performer."""
            identity = identities.get(label or "", {})
            if identity.get("status") != "confirmed" or not identity.get("actor_id"):
                return None
            actor_id = identity["actor_id"]
            if actor_id not in keys:
                keys[actor_id] = f"s{len(keys)}"
                actor = actors.get(actor_id, {})
                speakers[keys[actor_id]] = [actor.get("name") or identity.get("name", ""), actor.get("image_url", ""),
                                            identity.get("role") == "host"]
            return keys[actor_id]

        lines = []
        for segment in data.get("segments", []):
            part = segment.get("part", 1) - 1
            start, end = float(segment["start"]), float(segment["end"])
            if not any(p == part and start < high + MARGIN_SECONDS and end > low - MARGIN_SECONDS for p, low, high in spans):
                continue
            fallback = key_of(segment.get("speaker"))
            pieces = split_lines(segment.get("text", ""))
            length = sum(len(piece.replace(BREAK, "")) for piece in pieces) or 1
            at = start
            for piece in pieces:
                until = at + (end - start) * len(piece.replace(BREAK, "")) / length
                # Keep only lines inside an answer span; a segment can straddle a span's edge.
                if any(p == part and low - MARGIN_SECONDS <= at < high for p, low, high in spans):
                    speaker = key_of(turns.speaker(part, at, until)) or fallback or ""
                    lines.append([part, round(at, 1), speaker, piece])
                at = until
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
