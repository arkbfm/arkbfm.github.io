"""Put back headline questions that review_questions.py rewrote because their time pointed at other talk.

Some headline questions (written from show-note headings) were located at the wrong place, so the review
saw a mismatch and rewrote the question to fit whatever was playing there. The question was right and the
time was wrong: this asks an LLM, given the original question and the episode's chapters (heading, notes,
opening talk), where the answer is actually discussed. When it finds a place, the original question comes
back with a new time and end; when it does not, the review's rewrite stays.

Reads the review report (transcripts/work/question_review_report.md) for candidates, so run it right after
`review_questions.py --apply`.

    <python> scripts/relocate_headlines.py [--provider opencode --model gpt-6-luna --key-env OPENCODE_GO_API_KEY2]
"""

import argparse
import hashlib
import json
import re
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import review_questions as review  # noqa: E402
from build_question_related import notes_text  # noqa: E402
from locate_questions import (  # noqa: E402
    LEAD_SECONDS, POSTS, ROOT, SNAP_SECONDS, answer_end, bigrams, hms, normalize, read_questions, split_front,
    terms_of, write_questions,
)

CACHE = ROOT / "transcripts" / "work" / "relocate_headlines.json"
LOG = ROOT / "transcripts" / "work" / "relocate_headlines_report.md"
# Reasons the review gave when the talk at the time was about something else, not when the wording was off.
MISMATCH_RE = re.compile(r"不一致|ではなく|話ではない|話題と|語られ|別の話|異なる|ではない")
WINDOW_SECONDS = 12 * 60

LOCATE_SYSTEM = """あなたはポッドキャスト「あらB.fm」の編集者です。
ある回の「問い」の答えが、回のどこで話されているかを探します。章の一覧（開始時刻・見出し・メモ・話し始めの文字起こし）を読み、
問いの答えを実際に話している章を1つ選んでください。見出しやメモに問いの話題があれば、その章が有力です。
どの章でも話されていなければ found を false にしてください。
phrase には、その章の中で答えが話され始める所を探すための、話題を表す語（メモや文字起こしに出てくる表記）を入れてください。
JSON だけを返してください: {"found":true,"chapter":章番号,"phrase":"語"}"""


def seconds(value: str) -> int:
    return sum(int(part) * unit for part, unit in zip(value.split(":"), (3600, 60, 1)))


def candidates() -> list[dict]:
    """Headline fixes from the review report whose reason says the talk was elsewhere."""
    found = []
    pattern = re.compile(r"^- 修正 `([^`]+)\.(\d+)` (.+) → \*\*(.+)\*\*（(.*)）$")
    for line in review.REPORT.read_text(encoding="utf-8").splitlines():
        match = pattern.match(line)
        if match and MISMATCH_RE.search(match.group(5)):
            found.append({"slug": match.group(1), "number": int(match.group(2)), "original": match.group(3),
                          "fixed": match.group(4), "reason": match.group(5)})
    return found


def units_of(episode: dict, talk: list[tuple[int, float, str]]) -> list[dict]:
    """The episode's chapters, or fixed windows of its transcript when the notes have no times."""
    part_ends = {}
    for part, start, _ in talk:
        part_ends[part] = max(part_ends.get(part, 0), start)
    units = []
    chapters = [chapter for chapter in episode["chapters"] if chapter["playable"]]
    for index, chapter in enumerate(chapters):
        following = chapters[index + 1] if index + 1 < len(chapters) else None
        end = following["s"] if following and following["p"] == chapter["p"] else part_ends.get(chapter["p"], chapter["s"])
        units.append({"p": chapter["p"], "s": chapter["s"], "end": end, "title": chapter["title"], "notes": notes_text(chapter["raw"])})
    if not units:
        for part in sorted(part_ends):
            for start in range(0, int(part_ends[part]) + 1, WINDOW_SECONDS):
                units.append({"p": part, "s": start, "end": min(start + WINDOW_SECONDS, part_ends[part]), "title": "", "notes": ""})
    for unit in units:
        unit["opening"] = "".join(text for part, start, text in talk if part == unit["p"] and unit["s"] <= start < unit["end"])[:260]
    return units


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--provider", default="opencode")
    parser.add_argument("--model", default="gpt-6-luna")
    parser.add_argument("--key-env", default="OPENCODE_GO_API_KEY2")
    parser.add_argument("--workers", type=int, default=6)
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")

    todo = candidates()
    episodes = {episode["slug"]: episode for episode in review.related.load_episodes()}
    cache = json.loads(CACHE.read_text(encoding="utf-8")) if CACHE.exists() else {}
    review.use(args.provider, args.key_env, args.model)

    jobs = []
    for item in todo:
        episode = episodes[item["slug"]]
        units = units_of(episode, review.related.transcript_texts(item["slug"]))
        lines = [f"回: {episode['title']}", f"問い: {item['original']}", "章:"]
        for number, unit in enumerate(units, 1):
            part = f"パート{unit['p'] + 1} " if episode["parts"] > 1 else ""
            lines.append(f"[{number}] {part}{hms(unit['s'])} {unit['title'] or '（見出しなし）'} メモ: {unit['notes'][:160] or '-'} 冒頭: {unit['opening'][:160]}")
        prompt = "\n".join(lines)
        key = hashlib.sha1((args.model + LOCATE_SYSTEM + prompt).encode("utf-8")).hexdigest()
        jobs.append((item, episode, units, key, prompt))

    def ask(job):
        _, _, _, key, prompt = job
        if key not in cache:
            cache[key] = review.related.ask_judge(prompt, system=LOCATE_SYSTEM, required="found", kind=bool)
        return job

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        list(pool.map(ask, jobs))
    CACHE.write_text(json.dumps(cache, ensure_ascii=False, indent=1), encoding="utf-8")

    review_cache = json.loads(review.CACHE.read_text(encoding="utf-8"))
    themes = json.loads(review.THEMES.read_text(encoding="utf-8"))
    log = ["# 看板の問いの再配置", ""]
    moved = kept = 0
    for item, episode, units, key, _ in jobs:
        answer = cache[key]
        try:
            unit = units[int(answer.get("chapter")) - 1] if answer.get("found") else None
        except (TypeError, ValueError, IndexError):
            unit = None
        if unit is None:
            kept += 1
            log.append(f"- そのまま `{item['slug']}.{item['number']}` {item['fixed']}（元: {item['original']} は見つからず）")
            continue
        # Start where the talk first mentions the phrase or the question's words, as for every other question.
        talk = [seg for seg in episode["segments"] if seg["p"] == unit["p"] and unit["s"] <= seg["start"] < unit["end"]]
        probes = [normalize(str(answer.get("phrase", "")))] + sorted(terms_of(item["original"]), key=len, reverse=True)
        start = unit["s"]
        for probe in probes:
            first = next((seg for seg in talk if len(probe) >= 2 and probe in seg["text"]), None)
            if first:
                start = max(unit["s"], int(first["start"]) - LEAD_SECONDS)
                start = unit["s"] if start - unit["s"] < SNAP_SECONDS else start
                break
        terms = terms_of(item["original"]) or sorted(bigrams(item["original"]))
        end = answer_end(start, unit["p"], episode["chapters"], episode["segments"], terms)

        # Match the whole slug: a glob like *-1.md would also match Ep.52-1.
        path = next(path for path in POSTS.glob("*.md")
                    if (match := re.match(r"\d{4}-\d{2}-\d{2}-(.+)\.md$", path.name)) and match.group(1) == item["slug"])
        front, rest, newline = split_front(path.read_bytes().decode("utf-8"))
        questions = read_questions(front)
        question = questions[item["number"] - 1]
        question.update({"text": item["original"], "time": hms(start), "end": hms(int(end))})
        if episode["parts"] > 1:
            question["part"] = unit["p"] + 1
        path.write_bytes((write_questions(front, questions, newline) + rest).encode("utf-8"))
        # The original wording is now reviewed and placed; keep the review from rewriting it again.
        review_cache[review.text_key(f"{item['slug']}.{item['number']}", item["original"])] = {
            "verdict": "ok", "text": "", "reason": "再配置済み", "model": args.model}
        for theme in themes:
            theme["samples"] = [item["original"] if text == item["fixed"] else text for text in theme.get("samples", [])]
        moved += 1
        log.append(f"- 再配置 `{item['slug']}.{item['number']}` {item['original']} → {hms(start)}〜{hms(int(end))}「{unit['title']}」（修正案だった: {item['fixed']}）")

    review.CACHE.write_text(json.dumps(review_cache, ensure_ascii=False, indent=1), encoding="utf-8")
    review.THEMES.write_text(json.dumps(themes, ensure_ascii=False, indent=1) + "\n", encoding="utf-8", newline="\n")
    log[1:1] = [f"候補 {len(jobs)} / 再配置 {moved} / そのまま {kept}", ""]
    LOG.write_text("\n".join(log) + "\n", encoding="utf-8")
    print(f"{len(jobs)} candidates: {moved} relocated, {kept} kept as rewritten. report: {LOG}")


if __name__ == "__main__":
    main()
