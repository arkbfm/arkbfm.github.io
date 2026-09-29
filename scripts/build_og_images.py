#!/usr/bin/env python3
"""Render per-episode share images (images/og/<slug>.jpg) from _data/episode_index.json.

Requires Pillow. Existing images are kept unless --force is given, so run
build_site_data.py first and pass --force after changing the design.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re

from PIL import Image, ImageDraw, ImageFont, ImageOps


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "images" / "og"
ARTWORK = ROOT / "images" / "artwork.png"
DISPLAY_FONT = ROOT / "fonts" / "ProjectPaintballDisplay.ttf"
KANA_FONT = ROOT / "fonts" / "ikamodoki1_0.ttf"
JA_FONT_CANDIDATES = [
    Path("C:/Windows/Fonts/YuGothB.ttc"),
    Path("/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc"),
    Path("/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc"),
]
WIDTH, HEIGHT = 1200, 630
TEAL = (41, 189, 157)
INK = (12, 46, 39)
WHITE = (255, 255, 255)


def load_actors() -> dict[str, dict]:
    config = (ROOT / "_config.yml").read_text(encoding="utf-8-sig")
    block = re.search(r"^actors:\n((?:[ \t]+.*\n|\n)+)", config, re.MULTILINE).group(1)
    actors: dict[str, dict] = {}
    current = None
    for line in block.splitlines():
        if re.match(r"^  \S", line):
            current = line.strip().rstrip(":")
            actors[current] = {}
        elif current and (match := re.match(r"^\s{4}(\w+):\s*(.*)$", line)):
            actors[current][match.group(1)] = match.group(2).strip()
    return actors


def ja_font(size: int) -> ImageFont.FreeTypeFont:
    for path in JA_FONT_CANDIDATES:
        if path.exists():
            return ImageFont.truetype(str(path), size)
    raise SystemExit("No Japanese font found; add one to JA_FONT_CANDIDATES.")


def fit_font(draw: ImageDraw.ImageDraw, text: str, path: Path, size: int, max_width: int) -> ImageFont.FreeTypeFont:
    while size > 24:
        font = ImageFont.truetype(str(path), size)
        if draw.textlength(text, font=font) <= max_width:
            return font
        size -= 4
    return ImageFont.truetype(str(path), size)


def circle(image: Image.Image, size: int, ring: int = 8) -> Image.Image:
    face = ImageOps.fit(image.convert("RGB"), (size, size), Image.LANCZOS)
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, size - 1, size - 1), fill=255)
    framed = Image.new("RGBA", (size + ring * 2, size + ring * 2), (0, 0, 0, 0))
    ImageDraw.Draw(framed).ellipse((0, 0, size + ring * 2 - 1, size + ring * 2 - 1), fill=WHITE)
    framed.paste(face, (ring, ring), mask)
    return framed


def strip_emoji(text: str) -> str:
    return "".join(char for char in text if ord(char) <= 0xFFFF).strip()


def length_label(minutes: int | None) -> str:
    if not minutes:
        return ""
    hours, rest = divmod(minutes, 60)
    return "約" + (f"{hours}時間" if hours else "") + (f"{rest}分" if rest or not hours else "")


def render(ep: dict, actors: dict, artwork: Image.Image) -> Image.Image:
    canvas = Image.new("RGB", (WIDTH, HEIGHT), TEAL)
    # The artwork's ink splats sit on the same teal, so they can be lifted straight out.
    canvas.paste(artwork.crop((80, 0, 540, 360)).resize((330, 258)), (0, 0))
    canvas.paste(artwork.crop((1080, 1030, 1400, 1400)).resize((256, 296)), (WIDTH - 256, HEIGHT - 296))
    draw = ImageDraw.Draw(canvas)

    left = 72
    number_font = ImageFont.truetype(str(DISPLAY_FONT), 190)
    draw.text((left + 6, 96), "Ep.", font=ImageFont.truetype(str(DISPLAY_FONT), 64), fill=INK)
    draw.text((left, 140), ep["number"].replace("_", "."), font=number_font, fill=WHITE, stroke_width=6, stroke_fill=INK)

    subtitle_font = fit_font(draw, ep["subtitle"], DISPLAY_FONT, 72, WIDTH - left * 2)
    draw.text((left, 356), ep["subtitle"], font=subtitle_font, fill=WHITE, stroke_width=3, stroke_fill=INK)

    # Fonts here have no emoji, so drop symbols outside the BMP (e.g. 🐐).
    names = [strip_emoji(actors.get(guest, {}).get("name", guest)) for guest in ep["guests"]]
    who = ("・".join(names) + " と あらB") if names else "あらB"
    who_font = ja_font(40)
    while draw.textlength(who, font=who_font) > WIDTH - left * 2 and who_font.size > 26:
        who_font = ja_font(who_font.size - 2)
    draw.text((left, 460), who, font=who_font, fill=INK)

    details = " · ".join(part for part in [length_label(ep.get("minutes")), f"{ep['chapter_count']}チャプター" if ep["chapter_count"] else ""] if part)
    if details:
        draw.text((left, 520), details, font=ja_font(30), fill=INK)

    # Logo: kana in the ika font, latin in the paintball font, like the site header.
    kana_font = ImageFont.truetype(str(KANA_FONT), 44)
    latin_font = ImageFont.truetype(str(DISPLAY_FONT), 46)
    logo_x = WIDTH - 290
    draw.text((logo_x, 88), "あら", font=kana_font, fill=WHITE, anchor="ls")
    draw.text((logo_x + draw.textlength("あら", font=kana_font) + 4, 88), "B.fm", font=latin_font, fill=WHITE, anchor="ls")

    # Faces stay in the top-right block above the subtitle, so long titles never collide.
    faces = [guest for guest in ep["guests"] if actors.get(guest, {}).get("image_url")][:4] + ["ark_B"]
    size = 150 if len(faces) <= 2 else 124 if len(faces) <= 3 else 100
    step = int(size * 0.8)
    x = WIDTH - 80 - size - step * (len(faces) - 1)
    y = 140
    for index, actor_id in enumerate(faces):
        path = ROOT / actors[actor_id]["image_url"].lstrip("/")
        if not path.exists():
            continue
        framed = circle(Image.open(path), size)
        offset = 0 if index % 2 == 0 else 28
        canvas.paste(framed, (x + step * index, y + offset), framed)
    return canvas


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--force", action="store_true", help="re-render existing images")
    parser.add_argument("slugs", nargs="*", help="only these episodes")
    args = parser.parse_args()

    actors = load_actors()
    artwork = Image.open(ARTWORK).convert("RGB")
    episodes = json.loads((ROOT / "_data" / "episode_index.json").read_text(encoding="utf-8"))
    OUTPUT.mkdir(parents=True, exist_ok=True)
    rendered = 0
    for ep in episodes:
        if args.slugs and ep["slug"] not in args.slugs:
            continue
        path = OUTPUT / f"{ep['slug']}.jpg"
        if path.exists() and not args.force:
            continue
        render(ep, actors, artwork).save(path, "JPEG", quality=84, optimize=True, progressive=True)
        rendered += 1
    print(f"rendered {rendered} image(s) into {OUTPUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
