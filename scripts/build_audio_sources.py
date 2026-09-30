"""Map each episode to its audio files (url and length) from the show's RSS feed: _data/audio_sources.json.

The listening feed plays these files directly (not Spotify's embed), which lets it change speed, keep
playing with the screen locked and show captions in its own player. Items are matched by episode number:
"Ep. 166 ..." for a post whose slug is 166, "Ep. 152-1/-2/-3" for a post published as three audio parts,
"Ep. 63.5" for slug 63_5. The feed's duration is compared with the transcript's last timestamp, so an
audio file that no longer lines up with the captions (re-uploaded, ads inserted) is reported.

    python scripts/build_audio_sources.py
"""

import html
import json
import re
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from locate_questions import POSTS, ROOT, split_front  # noqa: E402

FEED = "https://anchor.fm/s/319a2820/podcast/rss"
OUTPUT = ROOT / "_data" / "audio_sources.json"
TRANSCRIPTS = ROOT / "transcripts" / "proofread"
# Allowed difference between the feed's duration and the transcript's end before reporting a mismatch.
TOLERANCE_SECONDS = 90


def tag(item: str, name: str) -> str:
    match = re.search(rf"<{name}[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?</{name}>", item, re.S)
    return html.unescape(match.group(1).strip()) if match else ""


def seconds(value: str) -> int:
    total = 0
    for part in value.split(":"):
        total = total * 60 + int(part or 0)
    return total


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    with urllib.request.urlopen(urllib.request.Request(FEED, headers={"User-Agent": "arkbfm-site/1.0"}), timeout=60) as response:
        feed = response.read().decode("utf-8")
    items = {}
    for item in re.findall(r"<item>(.*?)</item>", feed, re.S):
        number = re.match(r"Ep\.\s*([\d.]+(?:-\d+)?)", tag(item, "title"))
        enclosure = re.search(r'<enclosure url="([^"]+)"', item)
        if number and enclosure:
            items[number.group(1)] = {"url": html.unescape(enclosure.group(1)), "duration": seconds(tag(item, "itunes:duration") or "0")}

    sources, missing, mismatched = {}, [], []
    for path in sorted(POSTS.glob("*.md")):
        match = re.match(r"\d{4}-\d{2}-\d{2}-(.+)\.md$", path.name)
        if not match:
            continue
        slug = match.group(1)
        front, _, _ = split_front(path.read_bytes().decode("utf-8"))
        audio = re.search(r"^audio_url:[ \t]*(.*)$", front, re.MULTILINE)
        parts = len([value for value in audio.group(1).split(",") if value.strip()]) if audio else 0
        if not parts:
            continue
        number = slug.replace("_", ".")
        if parts == 1:
            # A post split into "-1" on the site may be a single item in the feed (and the other way round).
            found = [items.get(number) or items.get(re.sub(r"-1$", "", number))]
        else:
            found = [items.get(f"{number}-{index}") for index in range(1, parts + 1)]
        if not all(found):
            missing.append(slug)
            continue
        # [url, seconds] per audio part: the player skips questions that start past the end of their file.
        sources[slug] = [[item["url"], item["duration"]] for item in found]

        transcript = TRANSCRIPTS / f"Ep{slug}.json"
        if transcript.exists():
            ends = {}
            for segment in json.loads(transcript.read_text(encoding="utf-8")).get("segments", []):
                ends[segment.get("part", 1)] = max(ends.get(segment.get("part", 1), 0), segment["end"])
            for index, item in enumerate(found, 1):
                if item["duration"] and index in ends and abs(item["duration"] - ends[index]) > TOLERANCE_SECONDS:
                    mismatched.append(f"{slug} part {index}: feed {item['duration']}s, transcript ends {int(ends[index])}s")

    OUTPUT.write_text(json.dumps(sources, ensure_ascii=False, indent=1) + "\n", encoding="utf-8", newline="\n")
    print(f"{len(sources)} episodes with audio; missing: {missing or 'none'}")
    for line in mismatched:
        print("  duration mismatch:", line)


if __name__ == "__main__":
    main()
