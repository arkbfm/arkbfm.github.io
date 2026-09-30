#!/usr/bin/env python3
"""Render share images with the question itself (images/og/q/<page>.jpg) for the headline questions.

A shared question page then shows the question in large type in social feeds, instead of the episode's
image. Only headline questions get one (about 660 images); chapter questions keep the episode image, to
keep the repository small. Reuses the episode images' fonts and look (build_og_images.py). Existing
images are kept unless --force is given; images of questions that no longer exist are removed.

    python scripts/build_question_images.py [--force]
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_clip_pages import page_name  # noqa: E402
from build_og_images import (  # noqa: E402
    ARTWORK, DISPLAY_FONT, HEIGHT, INK, KANA_FONT, TEAL, WHITE, WIDTH, circle, ja_font, load_actors, strip_emoji,
)
from locate_questions import POSTS, ROOT, read_questions, split_front  # noqa: E402

OUTPUT = ROOT / "images" / "og" / "q"
STAMPS = ROOT / "transcripts" / "work" / "question_images.json"
# Characters that must not start a line (Japanese line-breaking rules).
NO_LINE_START = set("、。，．・：；？！゛゜ヽヾゝゞ々ー」』）］｝〉》】〕’”…‥?!)]}")
TEXT_LEFT, TEXT_RIGHT = 84, WIDTH - 84


def wrap(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.FreeTypeFont, width: int) -> list[str]:
    lines, line = [], ""
    for char in text:
        if line and draw.textlength(line + char, font=font) > width and char not in NO_LINE_START:
            lines.append(line)
            line = char
        else:
            line += char
    if line:
        lines.append(line)
    return lines


def render(question: str, episode: dict, actors: dict, artwork: Image.Image) -> Image.Image:
    canvas = Image.new("RGB", (WIDTH, HEIGHT), TEAL)
    canvas.paste(artwork.crop((80, 0, 540, 360)).resize((260, 203)), (0, 0))
    canvas.paste(artwork.crop((1080, 1030, 1400, 1400)).resize((200, 231)), (WIDTH - 200, HEIGHT - 231))
    draw = ImageDraw.Draw(canvas)

    # Logo top-right, like the site header.
    kana_font = ImageFont.truetype(str(KANA_FONT), 40)
    latin_font = ImageFont.truetype(str(DISPLAY_FONT), 42)
    logo_x = WIDTH - 270
    draw.text((logo_x, 76), "あら", font=kana_font, fill=WHITE, anchor="ls")
    draw.text((logo_x + draw.textlength("あら", font=kana_font) + 4, 76), "B.fm", font=latin_font, fill=WHITE, anchor="ls")

    # "Q" badge, then the question as large as three lines allow.
    draw.ellipse((TEXT_LEFT, 120, TEXT_LEFT + 76, 196), fill=INK)
    draw.text((TEXT_LEFT + 38, 160), "Q", font=ImageFont.truetype(str(DISPLAY_FONT), 50), fill=WHITE, anchor="mm")
    text = strip_emoji(question)
    for size in range(86, 38, -4):
        font = ja_font(size)
        lines = wrap(draw, text, font, TEXT_RIGHT - TEXT_LEFT)
        if len(lines) <= 3:
            break
    y = 220
    for line in lines:
        draw.text((TEXT_LEFT, y), line, font=font, fill=WHITE, stroke_width=4, stroke_fill=INK)
        y += int(font.size * 1.3)

    # Episode line and faces along the bottom.
    names = [strip_emoji(actors.get(guest, {}).get("name", guest)) for guest in episode["guests"]]
    who = ("・".join(names) + " と あらB") if names else "あらB"
    label = f"Ep.{episode['number']} {episode['subtitle']}"
    draw.text((TEXT_LEFT, HEIGHT - 110), label, font=ja_font(34), fill=INK)
    draw.text((TEXT_LEFT, HEIGHT - 64), who, font=ja_font(28), fill=INK)
    faces = [guest for guest in episode["guests"] if actors.get(guest, {}).get("image_url")][:3] + ["ark_B"]
    size, step = 84, 64
    # Faces stay left of the cream splat in the corner.
    x = WIDTH - 320 - step * (len(faces) - 1)
    for index, actor_id in enumerate(faces):
        path = ROOT / actors[actor_id]["image_url"].lstrip("/")
        if path.exists():
            framed = circle(Image.open(path), size, ring=6)
            canvas.paste(framed, (x + step * index, HEIGHT - 150), framed)
    return canvas


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--force", action="store_true", help="re-render existing images")
    args = parser.parse_args()

    actors = load_actors()
    artwork = Image.open(ARTWORK).convert("RGB")
    episodes = {ep["slug"]: ep for ep in json.loads((ROOT / "_data" / "episode_index.json").read_text(encoding="utf-8"))}
    OUTPUT.mkdir(parents=True, exist_ok=True)
    # The file name does not change when the wording does, so remember which text each image shows.
    stamps = json.loads(STAMPS.read_text(encoding="utf-8")) if STAMPS.exists() else {}
    wanted, rendered = set(), 0
    for path in sorted(POSTS.glob("*.md")):
        match = re.match(r"\d{4}-\d{2}-\d{2}-(.+)\.md$", path.name)
        if not match or match.group(1) not in episodes:
            continue
        slug = match.group(1)
        front, _, _ = split_front(path.read_bytes().decode("utf-8"))
        for index, question in enumerate(read_questions(front), 1):
            if not (question.get("time") and question.get("end")):
                continue
            name = page_name(f"{slug}.{index}") + ".jpg"
            wanted.add(name)
            target = OUTPUT / name
            if target.exists() and not args.force and stamps.get(name) == question["text"]:
                continue
            render(question["text"], episodes[slug], actors, artwork).save(target, "JPEG", quality=70, optimize=True, progressive=True)
            stamps[name] = question["text"]
            rendered += 1
    for stale in OUTPUT.iterdir():
        if stale.name not in wanted:
            stale.unlink()
    STAMPS.write_text(json.dumps({name: text for name, text in stamps.items() if name in wanted}, ensure_ascii=False, indent=1),
                      encoding="utf-8")
    print(f"rendered {rendered} image(s); {len(wanted)} in {OUTPUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
