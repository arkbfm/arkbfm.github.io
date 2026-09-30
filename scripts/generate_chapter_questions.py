"""Write questions for each chapter (up to three for long ones), answered by that chapter's talk.

The three questions in each post's front matter are the hand-picked headline ones; these add the rest of
the archive to the listening feed. An LLM (OpenCode Go, gpt-5.6-luna) reads a chapter's heading, notes and
transcript, and returns questions plus the words where the answer starts; the start is found in the
transcript and the end is where the talk moves on, as for the headline questions. Episodes whose notes
have no timed chapters are cut into fixed-length windows of their transcript instead.

Answers are cached in transcripts/work, so reruns only ask about new or changed chapters.

    <python> scripts/generate_chapter_questions.py [--limit N]   # writes _data/chapter_questions.json
"""

import argparse
import hashlib
import json
import math
import os
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_question_related import (  # noqa: E402
    JUDGE_ENV, JUDGE_KEY, JUDGE_MODEL, ROOT, UsageLimitError, ask_judge, load_episodes, load_simple_env, notes_text,
    transcript_texts,
)
from locate_questions import (  # noqa: E402
    LEAD_SECONDS, SNAP_SECONDS, answer_end, bigrams, hms, normalize, terms_of,
)

OUTPUT = ROOT / "_data" / "chapter_questions.json"
CACHE = ROOT / "transcripts" / "work" / "chapter_questions_llm.json"
MIN_CHAPTER_SECONDS = 120
# Longer chapters hold more separate answers: one question, two from this length, three from the next.
TWO_QUESTION_SECONDS = 6 * 60
THREE_QUESTION_SECONDS = 15 * 60
WINDOW_SECONDS = 12 * 60
TRANSCRIPT_CHARS = 3600

WRITER_SYSTEM = """あなたはポッドキャスト「あらB.fm」のアーカイブ編集者です。
ある回の1つの章（見出し・メモ・文字起こし）を読み、リスナーが「この答えを聴きたい」と思う問いを作ります。
ルール:
- 1問30字前後、疑問形。答えは書かない（聴きたくなる問いにする）
- その章で実際に話されている内容だけから作る。固有名詞はメモや文字起こしの表記に合わせる
- 下に挙げる「この回の既存の問い」と同じ内容の問いは作らない
- 宣伝・告知・音声の不具合だけなど、問いが立たない章なら questions を空にする
- phrase は、その問いの答えが話され始める箇所の文字起こしの表現を、原文のまま10〜20字で抜き出す
JSON だけを返してください: {"questions":[{"text":"問い","phrase":"原文の抜き出し"}]}"""


def chapter_units(episode: dict, raw_segments: list[tuple[int, float, str]]) -> list[dict]:
    """Timed chapters with their span and talk; windows of the transcript when the notes have no times."""
    units = []
    chapters = episode["chapters"]
    part_ends = {}
    for part, start, _ in raw_segments:
        part_ends[part] = max(part_ends.get(part, 0), start)
    if chapters:
        for index, chapter in enumerate(chapters):
            if not chapter["playable"]:
                continue
            following = chapters[index + 1] if index + 1 < len(chapters) else None
            end = following["s"] if following and following["p"] == chapter["p"] else part_ends.get(chapter["p"], chapter["s"])
            units.append({"p": chapter["p"], "s": chapter["s"], "end": end, "title": chapter["title"],
                          "notes": notes_text(chapter["raw"]), "generic": chapter["generic"]})
    elif raw_segments:
        for part in sorted(part_ends):
            start = 0
            while start < part_ends[part]:
                units.append({"p": part, "s": start, "end": min(start + WINDOW_SECONDS, part_ends[part]),
                              "title": "", "notes": "", "generic": False})
                start += WINDOW_SECONDS
    for unit in units:
        talk = "".join(text for part, start, text in raw_segments if part == unit["p"] and unit["s"] <= start < unit["end"])
        if len(talk) > TRANSCRIPT_CHARS:
            # The opening says what the chapter is about; a middle slice shows where it goes.
            half = TRANSCRIPT_CHARS // 2
            middle = len(talk) // 2
            talk = talk[:half] + "……（中略）……" + talk[middle:middle + half]
        unit["talk"] = talk
    return units


def locate(unit: dict, segments: list[dict], phrase: str, text: str) -> tuple[int, bool]:
    """The first segment in the chapter containing the phrase (or its opening words, or the question's
    words), and whether anything was found; the chapter start otherwise."""
    talk = [seg for seg in segments if seg["p"] == unit["p"] and unit["s"] <= seg["start"] < unit["end"]]
    phrase = normalize(phrase)
    for probe in (phrase, phrase[:8], *sorted(terms_of(text), key=len, reverse=True)):
        if len(probe) < 3:
            continue
        found = next((seg for seg in talk if probe in seg["text"]), None)
        if found:
            start = max(unit["s"], int(found["start"]) - LEAD_SECONDS)
            return (unit["s"] if start - unit["s"] < SNAP_SECONDS else start), True
    return unit["s"], False


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, help="ask about only this many uncached chapters (for a trial run)")
    parser.add_argument("--workers", type=int, default=4)
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")

    episodes = load_episodes()
    jobs = []
    for episode in episodes:
        raw_segments = transcript_texts(episode["slug"])
        if not raw_segments:
            continue
        existing = [question["text"] for question in episode["questions"]]
        for unit in chapter_units(episode, raw_segments):
            length = unit["end"] - unit["s"]
            if length < MIN_CHAPTER_SECONDS or len(unit["talk"]) < 200:
                continue
            wanted = 3 if length >= THREE_QUESTION_SECONDS else 2 if length >= TWO_QUESTION_SECONDS else 1
            prompt = "\n".join([
                f"回: {episode['title']}",
                f"この回の既存の問い: {' / '.join(existing) or 'なし'}",
                f"章: {unit['title'] or '（見出しなし）'}",
                f"メモ: {unit['notes'][:600] or 'なし'}",
                f"作る問いの数: 最大{wanted}問",
                f"文字起こし: {unit['talk']}",
            ])
            key = hashlib.sha1((JUDGE_MODEL + WRITER_SYSTEM + prompt).encode("utf-8")).hexdigest()
            jobs.append((episode, unit, key, prompt, wanted))

    written = json.loads(CACHE.read_text(encoding="utf-8")) if CACHE.exists() else {}
    work = [(key, prompt) for _, _, key, prompt, _ in jobs if key not in written]
    if args.limit is not None:
        work = work[:args.limit]
    if work:
        load_simple_env(JUDGE_ENV)
        if JUDGE_KEY not in os.environ:
            raise SystemExit(f"{JUDGE_KEY} is not set (looked in {JUDGE_ENV})")
        print(f"writing questions for {len(work)} of {len(jobs)} chapters", file=sys.stderr)
        lock = threading.Lock()

        stopped = threading.Event()

        def write(item: tuple[str, str]) -> None:
            if stopped.is_set():
                return
            key, prompt = item
            try:
                answer = ask_judge(prompt, system=WRITER_SYSTEM, required="questions", kind=list)
            except UsageLimitError as error:
                if not stopped.is_set():
                    print(f"  stopping: {error}; rerun later for the rest", file=sys.stderr)
                stopped.set()
                return
            except RuntimeError as error:
                print(f"  skipped one chapter: {error}", file=sys.stderr)
                return
            with lock:
                written[key] = answer
                CACHE.write_text(json.dumps(written, ensure_ascii=False), encoding="utf-8")
                if len(written) % 25 == 0:
                    print(f"  {len(written)} chapters", file=sys.stderr, flush=True)

        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            list(pool.map(write, work))

    output = {}
    located = total = 0
    for episode, unit, key, _, wanted in jobs:
        if key not in written:
            continue
        for item in written[key]["questions"][:wanted]:
            text = str(item.get("text", "")).strip()
            if not text or len(text) > 60:
                continue
            start, found = locate(unit, episode["segments"], str(item.get("phrase", "")), text)
            located += found
            total += 1
            terms = terms_of(text) or sorted(bigrams(text))
            end = min(answer_end(start, unit["p"], episode["chapters"], episode["segments"], terms), max(unit["end"], start + 90))
            clip = {"text": text, "time": hms(start), "end": hms(int(end)), "chapter": unit["title"]}
            if episode["parts"] > 1:
                clip["part"] = unit["p"] + 1
            output.setdefault(episode["slug"], []).append(clip)
    for clips in output.values():
        clips.sort(key=lambda clip: (clip.get("part", 1), clip["time"]))
    OUTPUT.write_text(json.dumps(output, ensure_ascii=False, indent=1) + "\n", encoding="utf-8", newline="\n")
    print(f"{total} chapter questions in {len(output)} episodes ({located} located in the transcript)")


if __name__ == "__main__":
    main()
