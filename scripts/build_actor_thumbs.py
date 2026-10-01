#!/usr/bin/env python3
"""Write small square copies of the performers' images (images/actors/s/<same name>) for the faces on cards and in the feed.
The originals run up to 1000px and 300 KB, but the site shows them at 72px or less; the share-image scripts and the
guest page header keep using the originals. A copy is rewritten only when its original is newer, so run it after adding
or replacing an image in images/actors/. Requires Pillow.
    python scripts/build_actor_thumbs.py
"""
from __future__ import annotations

import re
from pathlib import Path

from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parents[1]
ACTORS = ROOT / "images" / "actors"
OUTPUT = ACTORS / "s"
# Twice the largest size shown (72px), for high-density screens.
SIZE = 144


def referenced() -> list[str]:
    """Image file names that _config.yml's actors point at."""
    config = (ROOT / "_config.yml").read_text(encoding="utf-8")
    return sorted(set(re.findall(r"image_url: /images/actors/(\S+)", config)))


def main() -> None:
    OUTPUT.mkdir(exist_ok=True)
    wanted = set()
    written = 0
    for name in referenced():
        source = ACTORS / name
        if not source.exists():
            print(f"missing: {source.relative_to(ROOT)}")
            continue
        target = OUTPUT / name
        wanted.add(name)
        if target.exists() and target.stat().st_mtime >= source.stat().st_mtime:
            continue
        image = ImageOps.exif_transpose(Image.open(source))
        # The site crops faces to a circle with object-fit: cover, so a centered square loses nothing it shows.
        thumb = ImageOps.fit(image, (SIZE, SIZE), Image.LANCZOS)
        if source.suffix.lower() == ".png":
            thumb.save(target, optimize=True)
        else:
            thumb.convert("RGB").save(target, quality=85, optimize=True, progressive=True)
        written += 1
    for path in OUTPUT.iterdir():
        if path.name not in wanted:
            path.unlink()
    total = sum(path.stat().st_size for path in OUTPUT.iterdir())
    print(f"wrote {written} of {len(wanted)} thumbnail(s); {total // 1024} KB in {OUTPUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
