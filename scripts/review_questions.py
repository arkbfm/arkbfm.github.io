"""Have an LLM check every question before it is published, then apply its verdicts.

Questions were written by an LLM (the headline ones from show notes, the chapter ones from transcripts),
and each becomes a public share page, so a stronger model (OpenAI gpt-5.6-sol) reads them in batches of
the same episode together with the opening of each answer's transcript, and returns for each one:

- ok:   fits the talk and is fine to publish
- fix:  off from the talk, unclear, or a misspelt name, with a rewritten question
- hide: should not headline a public page (see REVIEW_SYSTEM); headline questions get a fix instead,
        since their numbers are fixed by the episode page and related spots

Verdicts are cached in transcripts/work/question_review.json. With --apply they are written back: fixed
text into the front matter and _data/chapter_questions.json, hidden chapter questions marked
"hidden: true" (they keep their number so ids stay stable) and dropped from _data/themes.json. Every
change is listed in transcripts/work/question_review_report.md for a human to look over.

Each OpenAI key is capped per UTC day by the same ledger build_question_related.py keeps; when one key
reaches its cap the next --key-env is used, and a later run resumes where this one stopped.

    <python> scripts/review_questions.py --key-env OPENAI_API_KEY2 --key-env OPENAI_API_KEY [--apply]
"""

import argparse
import hashlib
import json
import os
import re
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_question_related as related  # noqa: E402
from locate_questions import POSTS, ROOT, read_questions, split_front, write_questions  # noqa: E402

MODEL = "gpt-5.6-sol"
BATCH = 12
EXCERPT_CHARS = 800
CACHE = ROOT / "transcripts" / "work" / "question_review.json"
REPORT = ROOT / "transcripts" / "work" / "question_review_report.md"
CHAPTER_QUESTIONS = ROOT / "_data" / "chapter_questions.json"
THEMES = ROOT / "_data" / "themes.json"

REVIEW_SYSTEM = """あなたはポッドキャスト「あらB.fm」の編集者です。AIが作った「問い」を、公開前に点検します。
問いはそれぞれ公開の共有ページの見出しになり、SNSでも共有されます。
各問いを、その答えの冒頭の文字起こし（音声認識なので誤字を含む）と照らして判定してください。
渡すのは答えの冒頭だけです。答えがその先で話されている可能性があるので、冒頭に出てこないだけでは fix にしないでください。
問いの面白さ（聴きたくなる具体性）は大事なので、無難な言い回しに薄めないでください。
- ok: 話されている内容に合っていて、公開して問題ない
- fix: 冒頭の内容と明らかに食い違う、誇張している、固有名詞や表記の誤り、意味が通じない。30字前後・疑問形・答えを書かない問いに直す
- hide: 番組で本人が話したことでも、問いとして切り出して見出しにすると本人や第三者が困りうるもの。
  例: 出演者や家族・知人の健康や病歴の詳細、家族や恋愛の私的な事情、第三者への批判、性的な話題、
  住所や勤務先・配属先など個人の特定につながる情報、
  所属組織の内情（人事・評価・異動・人員削減・社内の不満・特定できる同僚）。職種や働き方の一般論は ok
  ただし本人が啓発や経験談として前向きに語っている話題の、一般的な問い（例:「多発性硬化症とはどんな病気？」）は ok でよい
fix の判断では、出演者名・作品名・製品名の表記（文字起こしの誤変換に引きずられた表記）も必ず確かめてください。
headline が true の問いには hide を使わず、同じ答えに合う差し替えの問いを fix で出してください。
JSON だけを返してください: {"results":[{"n":番号,"verdict":"ok|fix|hide","text":"fix のときの問い","reason":"20字以内"}]}"""


def text_key(clip_id: str, text: str) -> str:
    return clip_id + ":" + hashlib.sha1(text.encode("utf-8")).hexdigest()[:12]


def load_clips() -> list[dict]:
    chapter_questions = json.loads(CHAPTER_QUESTIONS.read_text(encoding="utf-8"))
    clips = []
    # load_episodes drops hidden chapter questions; this reads chapter_questions.json itself so every
    # question (hidden ones included) keeps its id.
    for episode in related.load_episodes():
        slug = episode["slug"]
        talk = related.transcript_texts(slug)

        def excerpt(part: int, start: int) -> str:
            text = "".join(words for p, at, words in talk if p == part and at >= start - 2)
            return text[:EXCERPT_CHARS]

        for index, question in enumerate(episode["questions"], 1):
            if question.get("s") is not None:
                clips.append({"id": f"{slug}.{index}", "slug": slug, "episode": episode["title"], "headline": True,
                              "text": question["text"], "chapter": "", "excerpt": excerpt(question["p"], question["s"])})
        for index, question in enumerate(chapter_questions.get(slug, []), 1):
            start = sum(int(part) * unit for part, unit in zip(question["time"].split(":"), (3600, 60, 1)))
            clips.append({"id": f"{slug}.c{index}", "slug": slug, "episode": episode["title"], "headline": False,
                          "text": question["text"], "chapter": question.get("chapter", ""),
                          "excerpt": excerpt(question.get("part", 1) - 1, start)})
    return clips


def batch_prompt(batch: list[dict]) -> str:
    lines = [f"回: {batch[0]['episode']}", ""]
    for number, clip in enumerate(batch, 1):
        lines.append(f"[{number}] 問い: {clip['text']}")
        lines.append(f"    headline: {'true' if clip['headline'] else 'false'} / 章: {clip['chapter'] or '-'}")
        lines.append(f"    答えの冒頭: {clip['excerpt'] or '（文字起こしなし）'}")
    return "\n".join(lines)


def use(provider: str, key: str, model: str) -> None:
    related.select_provider(provider, key)
    related.JUDGE_MODEL = model
    # Second accounts' keys may live in either project's .env.
    for name in related.PROVIDERS:
        related.load_simple_env(related.PROVIDERS[name]["env"])


def review(clips: list[dict], keys: list[str], workers: int, limit: int | None = None,
           provider: str = "openai", model: str = MODEL) -> dict:
    cache = json.loads(CACHE.read_text(encoding="utf-8")) if CACHE.exists() else {}
    todo = [clip for clip in clips if text_key(clip["id"], clip["text"]) not in cache]
    batches = []
    for clip in todo:
        if batches and batches[-1][0]["slug"] == clip["slug"] and len(batches[-1]) < BATCH:
            batches[-1].append(clip)
        else:
            batches.append([clip])
    if limit is not None:
        batches = batches[:limit]
    print(f"{len(todo)} of {len(clips)} questions to review; {len(batches)} batches this run", file=sys.stderr)
    if not batches:
        return cache

    related.OPENAI_MAX_OUTPUT_TOKENS = 4096
    lock = threading.Lock()
    for key in keys:
        use(provider, key, model)
        if key not in os.environ:
            print(f"  {key} is not set; skipped", file=sys.stderr)
            continue
        stopped = threading.Event()

        def check(batch: list[dict]) -> None:
            if stopped.is_set() or all(text_key(clip["id"], clip["text"]) in cache for clip in batch):
                return
            try:
                answer = related.ask_judge(batch_prompt(batch), system=REVIEW_SYSTEM, required="results", kind=list)
            except related.UsageLimitError as error:
                if not stopped.is_set():
                    print(f"  {key}: {error}", file=sys.stderr)
                stopped.set()
                return
            except RuntimeError as error:
                print(f"  skipped a batch of {batch[0]['slug']}: {error}", file=sys.stderr)
                return
            with lock:
                for result in answer["results"]:
                    try:
                        clip = batch[int(result["n"]) - 1]
                    except (KeyError, ValueError, IndexError, TypeError):
                        continue
                    verdict = result.get("verdict") if result.get("verdict") in ("ok", "fix", "hide") else "ok"
                    if clip["headline"] and verdict == "hide":
                        verdict = "fix" if result.get("text") else "ok"
                    cache[text_key(clip["id"], clip["text"])] = {
                        "verdict": verdict, "text": str(result.get("text", "")).strip(),
                        "reason": str(result.get("reason", "")).strip(), "model": model,
                    }
                CACHE.write_text(json.dumps(cache, ensure_ascii=False, indent=1), encoding="utf-8")
                done = sum(1 for clip in clips if text_key(clip["id"], clip["text"]) in cache)
                if done % 120 < BATCH:
                    print(f"  {done}/{len(clips)} reviewed", file=sys.stderr, flush=True)

        with ThreadPoolExecutor(max_workers=workers) as pool:
            list(pool.map(check, batches))
        if not stopped.is_set():
            break
    return cache


def apply(clips: list[dict], cache: dict) -> None:
    chapter_questions = json.loads(CHAPTER_QUESTIONS.read_text(encoding="utf-8"))
    models = {}
    for clip in clips:
        result = cache.get(text_key(clip["id"], clip["text"]))
        if result:
            models[result.get("model", MODEL)] = models.get(result.get("model", MODEL), 0) + 1
    report = ["# 問いのチェック結果（" + "、".join(f"{name} {count}問" for name, count in models.items()) + "）", ""]
    fixed_headlines = {}
    hidden = set()
    counts = {"ok": 0, "fix": 0, "hide": 0, "unchecked": 0}
    for clip in clips:
        result = cache.get(text_key(clip["id"], clip["text"]))
        if not result:
            counts["unchecked"] += 1
            continue
        counts[result["verdict"]] += 1
        if result["verdict"] == "fix" and result["text"] and result["text"] != clip["text"]:
            report.append(f"- 修正 `{clip['id']}` {clip['text']} → **{result['text']}**（{result['reason']}）")
            if clip["headline"]:
                fixed_headlines.setdefault(clip["slug"], {})[int(clip["id"].split(".")[-1])] = result["text"]
            else:
                entry = chapter_questions[clip["slug"]][int(clip["id"].split(".c")[-1]) - 1]
                # Keep the generated wording, so generate_chapter_questions.py can carry this fix over when it rebuilds.
                entry.setdefault("source_text", entry["text"])
                entry["text"] = result["text"]
            # The new text is already reviewed; record it so a rerun does not ask again.
            cache[text_key(clip["id"], result["text"])] = {"verdict": "ok", "text": "", "reason": "修正済み", "model": MODEL}
        elif result["verdict"] == "hide":
            report.append(f"- 非公開 `{clip['id']}` {clip['text']}（{result['reason']}）")
            chapter_questions[clip["slug"]][int(clip["id"].split(".c")[-1]) - 1]["hidden"] = True
            hidden.add(clip["id"])

    CHAPTER_QUESTIONS.write_text(json.dumps(chapter_questions, ensure_ascii=False, indent=1) + "\n", encoding="utf-8", newline="\n")
    for path in sorted(POSTS.glob("*.md")):
        match = re.match(r"\d{4}-\d{2}-\d{2}-(.+)\.md$", path.name)
        if not match or match.group(1) not in fixed_headlines:
            continue
        front, rest, newline = split_front(path.read_bytes().decode("utf-8"))
        questions = read_questions(front)
        for number, text in fixed_headlines[match.group(1)].items():
            questions[number - 1]["text"] = text
        path.write_bytes((write_questions(front, questions, newline) + rest).encode("utf-8"))

    if THEMES.exists():
        # Theme tiles show sample question texts: drop hidden ones and follow fixed wording.
        themes = json.loads(THEMES.read_text(encoding="utf-8"))
        texts = {clip["id"]: clip["text"] for clip in clips}
        hidden_texts = {texts[clip_id] for clip_id in hidden if clip_id in texts}
        renamed = {}
        for clip in clips:
            result = cache.get(text_key(clip["id"], clip["text"]))
            if result and result["verdict"] == "fix" and result["text"]:
                renamed[clip["text"]] = result["text"]
        for theme in themes:
            theme["clips"] = [clip_id for clip_id in theme["clips"] if clip_id not in hidden]
            theme["samples"] = [renamed.get(text, text) for text in theme.get("samples", []) if text not in hidden_texts]
        THEMES.write_text(json.dumps(themes, ensure_ascii=False, indent=1) + "\n", encoding="utf-8", newline="\n")

    CACHE.write_text(json.dumps(cache, ensure_ascii=False, indent=1), encoding="utf-8")
    summary = f"OK {counts['ok']} / 修正 {counts['fix']} / 非公開 {counts['hide']} / 未チェック {counts['unchecked']}"
    report[1:1] = [summary, ""]
    REPORT.write_text("\n".join(report) + "\n", encoding="utf-8")
    print(summary)
    print(f"report: {REPORT}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--key-env", action="append", default=[], help="OpenAI key variables, used in order (default OPENAI_API_KEY)")
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--apply", action="store_true", help="write verdicts back to the posts and data files")
    parser.add_argument("--no-review", action="store_true", help="only apply what is already cached")
    parser.add_argument("--limit", type=int, help="review only this many batches (for a trial run)")
    parser.add_argument("--provider", choices=["openai", "opencode"], default="openai")
    parser.add_argument("--model", default=MODEL, help=f"reviewing model (default {MODEL})")
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")

    clips = load_clips()
    cache = json.loads(CACHE.read_text(encoding="utf-8")) if CACHE.exists() else {}
    if not args.no_review:
        default_key = "OPENAI_API_KEY" if args.provider == "openai" else "OPENCODE_GO_API_KEY"
        cache = review(clips, args.key_env or [default_key], args.workers, args.limit, args.provider, args.model)
    if args.apply:
        apply(clips, cache)


if __name__ == "__main__":
    main()
