"""Sort every clip (headline and chapter questions) into themes for the home page's theme map.

Like the related spots, this reasons over the archive instead of trusting similarity alone (clustering
embeddings grouped questions by their wording, e.g. "things starting with マ"). An LLM (OpenCode Go,
gpt-5.6-luna) first reads the headline questions plus a sample of chapter questions and proposes the
themes; then it assigns every clip to one of them in batches. Answers are cached in transcripts/work.

    <python> scripts/build_themes.py   # writes _data/themes.json
"""

import argparse
import hashlib
import json
import os
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_question_related as related  # noqa: E402
from build_question_related import ROOT, ask_judge, chapter_of, load_episodes, load_simple_env  # noqa: E402

OUTPUT = ROOT / "_data" / "themes.json"
CACHE = ROOT / "transcripts" / "work" / "themes_llm.json"
SAMPLE_EXTRAS = 500
BATCH = 100

TAXONOMY_SYSTEM = """あなたはポッドキャスト「あらB.fm」のアーカイブ編集者です。
番組の「問い」の一覧を読み、リスナーがトップページでテーマを選んで、そのテーマの話を次々に聴くためのテーマ分類を作ります。
- テーマは16〜20個。一覧全体を漏れなく覆い、大きさが極端に偏らないようにする
- 話題の中身でまとめる（言い回しや文字の並びではまとめない）。「その他」「雑談」のような受け皿は作らない
- label は押したくなる12字以内の名詞句、lead はどんな話が聴けるかの35字以内の一文、emoji は1文字
JSON だけを返してください: {"themes":[{"label":"…","lead":"…","emoji":"…"}]}"""

ASSIGN_SYSTEM = """あなたはポッドキャスト「あらB.fm」のアーカイブ編集者です。
番号付きの「問い」それぞれを、与えられたテーマ一覧のうち最も合うテーマ番号に振り分けてください。
問いの後ろの（）はその問いが話される章の見出しです。どれにも合わなければ 0 にしてください。
JSON だけを返してください: {"assign":[問い1のテーマ番号, 問い2のテーマ番号, ...]}（問いと同じ数・同じ順）"""


def seconds(value: str) -> int:
    hours, minutes, secs = (int(part) for part in value.split(":"))
    return hours * 3600 + minutes * 60 + secs


def cached_ask(cache: dict, system: str, prompt: str, required: str) -> dict:
    key = hashlib.sha1((related.JUDGE_MODEL + system + prompt).encode("utf-8")).hexdigest()
    if key not in cache:
        for provider in related.PROVIDERS.values():
            load_simple_env(provider["env"])
        if related.JUDGE_KEY not in os.environ:
            raise SystemExit(f"{related.JUDGE_KEY} is not set")
        cache[key] = ask_judge(prompt, system=system, required=required, kind=list)
        CACHE.write_text(json.dumps(cache, ensure_ascii=False), encoding="utf-8")
    return cache[key]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--keep-themes", action="store_true",
                        help="reuse the themes in _data/themes.json (ids and names) and only reassign clips, e.g. after "
                             "review_questions.py changed wording; a new taxonomy would change what shared theme links mean")
    parser.add_argument("--provider", choices=sorted(related.PROVIDERS), default="opencode")
    parser.add_argument("--key-env")
    parser.add_argument("--model")
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    related.select_provider(args.provider, args.key_env)
    if args.model:
        related.JUDGE_MODEL = args.model
    cache = json.loads(CACHE.read_text(encoding="utf-8")) if CACHE.exists() else {}

    clips = []
    for episode in load_episodes():
        for question in episode["questions"] + episode["extras"]:
            if question.get("s") is None or not question.get("end"):
                continue
            chapter = chapter_of(episode, question["p"], question["s"])
            clips.append({"id": question["id"], "slug": episode["slug"], "text": question["text"],
                          "chapter": chapter["title"] if chapter else "", "headline": question["id"].split(".")[-1].isdigit(),
                          "minutes": (seconds(question["end"]) - question["s"]) / 60})

    if args.keep_themes:
        themes = sorted(json.loads(OUTPUT.read_text(encoding="utf-8")), key=lambda theme: int(theme["id"][1:]))
        print(f"keeping {len(themes)} themes from {OUTPUT.name}", file=sys.stderr)
    else:
        # Stage 1: themes from all headline questions and a fixed sample of chapter questions.
        sample = [clip["text"] for clip in clips if clip["headline"]]
        extras = [clip["text"] for clip in clips if not clip["headline"]]
        sample += random.Random(0).sample(extras, min(SAMPLE_EXTRAS, len(extras)))
        themes = cached_ask(cache, TAXONOMY_SYSTEM, "\n".join(f"- {text}" for text in sample), "themes")["themes"]
        for number, theme in enumerate(themes, 1):
            theme["id"] = f"t{number}"
        print(f"{len(themes)} themes proposed from {len(sample)} questions", file=sys.stderr)

    # Stage 2: every clip into one theme, a batch at a time.
    listing = "\n".join(f"{number}. {theme['emoji']} {theme['label']}: {theme['lead']}" for number, theme in enumerate(themes, 1))
    members = [[] for _ in themes]
    unassigned = 0
    for offset in range(0, len(clips), BATCH):
        batch = clips[offset:offset + BATCH]
        prompt = "テーマ一覧:\n" + listing + "\n\n問い:\n" + "\n".join(
            f"{number}. {clip['text']}（{clip['chapter'] or '見出しなし'}）" for number, clip in enumerate(batch, 1))
        assign = cached_ask(cache, ASSIGN_SYSTEM, prompt, "assign")["assign"]
        for clip, number in zip(batch, assign + [0] * (len(batch) - len(assign))):
            try:
                number = int(number)
            except (TypeError, ValueError):
                number = 0
            if 1 <= number <= len(themes):
                members[number - 1].append(clip)
            else:
                unassigned += 1
        print(f"  assigned {min(offset + BATCH, len(clips))}/{len(clips)}", file=sys.stderr, flush=True)

    output = []
    for theme, group in zip(themes, members):
        if not group:
            continue
        # Headline questions first: they are the hand-picked way into a theme.
        group.sort(key=lambda clip: not clip["headline"])
        output.append({
            "id": theme["id"],
            "label": theme["label"],
            "lead": theme["lead"],
            "emoji": theme.get("emoji", ""),
            "minutes": round(sum(clip["minutes"] for clip in group)),
            "episodes": len({clip["slug"] for clip in group}),
            "samples": [clip["text"] for clip in group if clip["headline"]][:6] or [clip["text"] for clip in group][:6],
            "clips": [clip["id"] for clip in group],
        })
    output.sort(key=lambda theme: -len(theme["clips"]))
    OUTPUT.write_text(json.dumps(output, ensure_ascii=False, indent=1) + "\n", encoding="utf-8", newline="\n")
    for theme in output:
        print(f"{theme['emoji']} {theme['label']} ({len(theme['clips'])}本, {theme['minutes']}分, {theme['episodes']}回) - {theme['lead']}")
    print(f"{unassigned} clips fit no theme")


if __name__ == "__main__":
    main()
