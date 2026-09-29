#!/usr/bin/env python3
"""Build the private D1 migration for human-confirmed names on each search turn."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from build_import import chunks, quote, speaker_turns

ROOT = Path(__file__).resolve().parents[1]
TRANSCRIPTS = ROOT / "transcripts"
OUTPUT = Path(__file__).resolve().parent / "speaker-turns-migration.sql"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--updates-only", action="store_true", help="Existing speaker_turns column")
    args = parser.parse_args()
    manifest = json.loads((TRANSCRIPTS / "manifest.json").read_text(encoding="utf-8"))
    count = 0
    with OUTPUT.open("w", encoding="utf-8", newline="\n") as output:
        if not args.updates_only:
            output.write("ALTER TABLE segments ADD COLUMN speaker_turns TEXT;\n")
        for episode in manifest["episodes"]:
            path = TRANSCRIPTS / "proofread" / f"Ep{episode['id']}.json"
            if not path.exists():
                continue
            transcript = json.loads(path.read_text(encoding="utf-8"))
            identities = transcript.get("speaker_identities", {})
            for chunk_id, chunk in enumerate(chunks(transcript["segments"])):
                turns = speaker_turns(chunk, identities)
                output.write(
                    f"UPDATE segments SET speaker_turns={quote(turns)} "
                    f"WHERE episode={quote(episode['id'])} AND segment_id={chunk_id};\n"
                )
                count += 1
        output.write("SELECT count(*) AS speaker_turns_rows FROM segments WHERE speaker_turns IS NOT NULL;\n")
    print(f"wrote {OUTPUT.name}: {count} chunks")


if __name__ == "__main__":
    main()
