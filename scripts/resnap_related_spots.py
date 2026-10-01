"""Move the published related spots that play a span of a chapter (not a question) onto utterance starts,
the way build_question_related.py now places new ones, without judging anything again.

Spots used to start three seconds before the first mention of the shared subject, or at the show notes'
chapter timestamp when that mention came within SNAP_SECONDS of it; both often landed mid-utterance, on
the tail of the previous subject. The mention is recovered from that rule and the start is placed again
with utterance_start(). Ends stay as they were.

    <python with numpy> scripts/resnap_related_spots.py
"""

import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_question_related import CLIP_OUTPUT, OUTPUT, load_episodes, utterance_start  # noqa: E402
from locate_questions import hms, seconds_of  # noqa: E402

# The lead the old rule started before a mention.
OLD_LEAD_SECONDS = 3


def resnap(episodes: dict, slug: str, part: int, chapter_title: str, time: str) -> str | None:
    """The new start for a span spot, or None when it cannot be placed (or is a question's own time)."""
    episode = episodes.get(slug)
    if not episode:
        return None
    old = seconds_of(time)
    # A spot at one of the episode's questions plays that question's answer; it already starts where it should.
    if any(q.get("s") == old and q["p"] == part for q in episode["questions"] + episode["extras"]):
        return None
    chapters = [c for c in episode["chapters"] if c["p"] == part and c["title"] == chapter_title and c["s"] <= old]
    if not chapters:
        return None
    chapter = chapters[-1]
    position = episode["chapters"].index(chapter)
    following = episode["chapters"][position + 1] if position + 1 < len(episode["chapters"]) else None
    high = following["s"] if following and following["p"] == part else math.inf
    talk = [seg for seg in episode["segments"] if seg["p"] == part and chapter["s"] <= seg["start"] < high]
    mention = None
    if old != chapter["s"]:
        mention = next((seg for seg in talk if int(seg["start"]) == old + OLD_LEAD_SECONDS), None)
        if mention is None:
            mention = next((seg for seg in reversed(talk) if seg["start"] <= old + OLD_LEAD_SECONDS + 1), None)
    return hms(utterance_start(chapter, talk, mention))


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    episodes = {episode["slug"]: episode for episode in load_episodes()}
    moved = kept = skipped = 0
    shifts = []

    def apply(slug: str, part_number, chapter: str, time: str, end: str) -> str:
        nonlocal moved, kept, skipped
        new = resnap(episodes, slug, int(part_number or 1) - 1, chapter, time)
        if new is None or seconds_of(new) >= seconds_of(end) - 30:
            skipped += 1
            return time
        if new == time:
            kept += 1
        else:
            moved += 1
            shifts.append(seconds_of(new) - seconds_of(time))
        return new

    clip_related = json.loads(CLIP_OUTPUT.read_text(encoding="utf-8"))
    for spots in clip_related.values():
        for spot in spots:
            if "i" not in spot:
                spot["t"] = apply(spot["s"], spot.get("p"), spot["c"], spot["t"], spot["e"])
    related = json.loads(OUTPUT.read_text(encoding="utf-8"))
    for questions in related.values():
        for spots in questions:
            for spot in spots:
                if "id" not in spot and "q" not in spot:
                    spot["time"] = apply(spot["slug"], spot.get("part"), spot["chapter"], spot["time"], spot["end"])

    OUTPUT.write_text(json.dumps(related, ensure_ascii=False, indent=1) + "\n", encoding="utf-8", newline="\n")
    CLIP_OUTPUT.write_text(json.dumps(clip_related, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8", newline="\n")
    shifts.sort()
    median = shifts[len(shifts) // 2] if shifts else 0
    print(f"moved {moved}, already on an utterance {kept}, left as they were {skipped}; median shift {median}s")


if __name__ == "__main__":
    main()
