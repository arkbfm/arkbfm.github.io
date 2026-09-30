"""For each episode question, find where other episodes talk about the same subject.

Every timed chapter of every episode is a document: its heading, the notes under it and the start of
its transcript. Retrieval works like PageIndex, reasoning over a table of contents rather than trusting
similarity alone:

1. Documents and questions are embedded with a Japanese sentence-embedding model
   (cl-nagoya/ruri-v3-310m) to shortlist the closest chapters, one per other episode.
2. An LLM (OpenCode Go, gpt-5.6-luna) reads the question and the shortlist's headings, notes and opening
   talk, and keeps only chapters that discuss the same subject, with a short reason and a phrase to find
   where that talk starts.

A spot starts where the chapter's transcript first mentions that phrase (or at that episode's own
question on the subject) and ends where the talk moves on.

Needs sentence-transformers and OPENCODE_GO_API_KEY (read from pod-digest/.env), or with --provider openai
OPENAI_API_KEY (podclip/.env), capped at OPENAI_DAILY_TOKENS per UTC day. Embeddings and verdicts are cached
in transcripts/work, so reruns only embed and judge what changed; a run stopped by a limit resumes there.

    <python with sentence-transformers> scripts/build_question_related.py [--provider openai] [--limit N]
"""

import argparse
import hashlib
import json
import math
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from locate_questions import (  # noqa: E402
    LEAD_SECONDS, POSTS, ROOT, SNAP_SECONDS, STOP, TERM_RE, answer_end, chapters_of, hms,
    load_segments, normalize, read_questions, seconds_of, split_front,
)

OUTPUT = ROOT / "_data" / "question_related.json"
# Every clip (headline and chapter questions) by id, in the compact form the listening feed reads.
CLIP_OUTPUT = ROOT / "_data" / "clip_related.json"
CHAPTER_QUESTIONS = ROOT / "_data" / "chapter_questions.json"
CACHE = ROOT / "transcripts" / "work" / "question_related_embeddings.npz"
MODEL = "cl-nagoya/ruri-v3-310m"
# ruri-v3 is trained with these prefixes for asymmetric search.
QUERY_PREFIX = "検索クエリ: "
DOCUMENT_PREFIX = "検索文書: "
SPOTS_PER_QUESTION = 3
# A chapter question starting this close to where the shared subject comes up is taken to be about it.
NEAR_CLIP_SECONDS = 180
# How many of the closest chapters (one per episode) the judge reads for each question: the first run used
# CANDIDATES; questions judged later get the compact prompt.
CANDIDATES = 20
COMPACT_CANDIDATES = 10
# The judge: a Responses API. OpenCode Go by default (the account the transcript proofreading uses);
# --provider openai switches to OpenAI's free daily tokens, capped by OPENAI_DAILY_TOKENS below.
PROVIDERS = {
    "opencode": {"endpoint": "https://opencode.ai/zen/go/v1/responses", "model": "gpt-5.6-luna",
                 "key": "OPENCODE_GO_API_KEY", "env": Path(r"C:\Users\araki\work\pod-digest\.env")},
    "openai": {"endpoint": "https://api.openai.com/v1/responses", "model": "gpt-5.6-terra",
               "key": "OPENAI_API_KEY", "env": Path(r"C:\Users\araki\work\podclip\.env")},
}
JUDGE_ENDPOINT = PROVIDERS["opencode"]["endpoint"]
JUDGE_MODEL = PROVIDERS["opencode"]["model"]
JUDGE_KEY = PROVIDERS["opencode"]["key"]
JUDGE_ENV = PROVIDERS["opencode"]["env"]
JUDGE_SESSION = str(uuid.uuid4())
JUDGE_CACHE = ROOT / "transcripts" / "work" / "question_related_judged.json"
# OpenAI's complimentary tokens reset daily (UTC); stay under them with room for one request in flight.
OPENAI_DAILY_TOKENS = 2_400_000
OPENAI_LEDGER = ROOT / "transcripts" / "work" / "openai-daily-usage.json"
OPENAI_MAX_OUTPUT_TOKENS = 2048
# Catch-all corners list many things in passing; they need a clearly closer match to be offered.
GENERIC_RE = re.compile(r"近況|お便り|おたより|おすすめ|オススメ|宣伝|アナウンス|Myことば|Myミーム|ニュース|振り返り|自己紹介|編集後記|Editorial|次回|コレ買え|これ買え")
GENERIC_PENALTY = 0.03
TRANSCRIPT_CHARS = 600


def words(text: str) -> set[str]:
    """Content words: no single characters (a quoted 「ば」 matches everything) and no bare hiragana."""
    found = set()
    for match in TERM_RE.finditer(text):
        term = normalize(match.group(1) or match.group(0))
        if len(term) >= 2 and term not in STOP and not re.fullmatch(r"[ぁ-ん]+", term):
            found.add(term)
    return found


def notes_text(raw: str) -> str:
    lines = [re.sub(r"^\s*(?:##\s+\S+\s+|[*-]\s+)", "", line) for line in raw.splitlines()]
    return " ".join(line.strip() for line in lines if line.strip() and not line.startswith("http"))


def load_episodes() -> list[dict]:
    episodes = []
    chapter_questions = json.loads(CHAPTER_QUESTIONS.read_text(encoding="utf-8")) if CHAPTER_QUESTIONS.exists() else {}
    for path in sorted(POSTS.glob("*.md")):
        match = re.match(r"\d{4}-\d{2}-\d{2}-(.+)\.md$", path.name)
        if not match:
            continue
        slug = match.group(1)
        front, rest, _ = split_front(path.read_bytes().decode("utf-8"))
        audio = re.search(r"^audio_url:[ \t]*(.*)$", front, re.MULTILINE)
        parts = len([value for value in audio.group(1).split(",") if value.strip()]) if audio else 0
        if not parts:
            continue
        title = re.search(r"^title:[ \t]*(.*)$", front, re.MULTILINE)
        title = re.sub(r"\s*\([^)]*\)\s*$", "", title.group(1).strip().strip("'\"")) if title else slug
        segments = load_segments(slug)
        raw_segments = transcript_texts(slug)
        part_ends = {}
        for seg in segments:
            part_ends[seg["p"]] = max(part_ends.get(seg["p"], 0), seg["end"])
        chapters = chapters_of(rest, parts)
        for index, chapter in enumerate(chapters):
            following = chapters[index + 1] if index + 1 < len(chapters) else None
            high = following["s"] if following and following["p"] == chapter["p"] else math.inf
            spoken = "".join(text for part, start, text in raw_segments if part == chapter["p"] and chapter["s"] <= start < high)
            chapter["words"] = words(chapter["raw"])
            chapter["generic"] = bool(GENERIC_RE.search(chapter["title"]))
            chapter["spoken"] = spoken[:TRANSCRIPT_CHARS]
            chapter["document"] = DOCUMENT_PREFIX + chapter["title"] + "。" + notes_text(chapter["raw"]) + " " + chapter["spoken"]
            # Show notes sometimes run past the audio; such a chapter cannot be played.
            chapter["playable"] = not part_ends or chapter["s"] < part_ends.get(chapter["p"], math.inf)
        questions = read_questions(front)
        for index, question in enumerate(questions):
            question["id"] = f"{slug}.{index + 1}"
        # Chapter questions (generate_chapter_questions.py) join the headline ones as clips of their own.
        extras = [dict(question) for question in chapter_questions.get(slug, [])]
        for index, question in enumerate(extras):
            question["id"] = f"{slug}.c{index + 1}"
        # Questions hidden by review_questions.py keep their ids (numbered above) but take no part.
        extras = [question for question in extras if not question.get("hidden")]
        for question in questions + extras:
            question["words"] = words(question["text"])
            question["p"] = int(question.get("part") or 1) - 1
            question["s"] = seconds_of(question["time"]) if question.get("time") else None
        episodes.append({
            "slug": slug,
            "base": re.split(r"[-_.]", slug)[0],
            "parts": parts,
            "title": title,
            "chapters": chapters,
            "segments": segments,
            "questions": questions,
            "extras": extras,
        })
    return episodes


def transcript_texts(slug: str) -> list[tuple[int, float, str]]:
    """Segments with their original spacing, which reads better to the embedding model than normalized text."""
    for folder in ("proofread", "raw"):
        path = ROOT / "transcripts" / folder / f"Ep{slug}.json"
        if path.exists():
            data = json.loads(path.read_text(encoding="utf-8"))
            return [(seg.get("part", 1) - 1, seg["start"], seg.get("text", "")) for seg in data.get("segments", [])]
    return []


def chapter_of(episode: dict, part: int, second: int) -> dict | None:
    found = None
    for chapter in episode["chapters"]:
        if chapter["p"] == part and chapter["s"] <= second:
            found = chapter
    return found


def embed(texts: list[str]) -> np.ndarray:
    """Normalized embeddings, reusing cached ones by text hash."""
    keys = [hashlib.sha1(text.encode("utf-8")).hexdigest() for text in texts]
    cached = {}
    if CACHE.exists():
        with np.load(CACHE) as data:
            cached = dict(zip(data["keys"].tolist(), data["vectors"]))
    missing = sorted({key: text for key, text in zip(keys, texts) if key not in cached}.items())
    if missing:
        from sentence_transformers import SentenceTransformer

        model = SentenceTransformer(MODEL)
        print(f"embedding {len(missing)} texts", file=sys.stderr)
        vectors = model.encode([text for _, text in missing], batch_size=16, normalize_embeddings=True, show_progress_bar=True)
        cached.update(zip([key for key, _ in missing], vectors))
        CACHE.parent.mkdir(parents=True, exist_ok=True)
        np.savez(CACHE, keys=np.array(list(cached)), vectors=np.array(list(cached.values())))
    return np.array([cached[key] for key in keys])


def spot_in(episode: dict, chapter: dict, shared: list[str]) -> dict:
    """Where in the chapter the shared subject comes up, and where that talk ends.

    `shared` is in priority order: the first term that the chapter's talk mentions decides the start.
    """
    for index, question in enumerate(episode["questions"]):
        # Land on the episode's own question when it is about the shared subject, so its banner makes sense.
        if (question["s"] is not None and question["p"] == chapter["p"]
                and chapter_of(episode, question["p"], question["s"]) is chapter
                and question["words"] & set(shared)):
            return {"time": question["time"], "end": question.get("end"), "q": index + 1}

    chapters = episode["chapters"]
    position = chapters.index(chapter)
    following = chapters[position + 1] if position + 1 < len(chapters) else None
    high = following["s"] if following and following["p"] == chapter["p"] else math.inf
    start = chapter["s"]
    talk = [seg for seg in episode["segments"] if seg["p"] == chapter["p"] and chapter["s"] <= seg["start"] < high]
    for term in shared:
        first = next((seg for seg in talk if term in seg["text"]), None)
        if first:
            start = max(chapter["s"], int(first["start"]) - LEAD_SECONDS)
            if start - chapter["s"] < SNAP_SECONDS:
                start = chapter["s"]
            break
    end = answer_end(start, chapter["p"], chapters, episode["segments"], shared)
    return {"time": hms(start), "end": hms(end)}


def clip_in(episode: dict, chapter: dict, terms: list[str], near: int) -> dict | None:
    """The episode's question (headline or chapter) answered in this chapter that best fits the shared subject:
    one whose wording shares a term, else one starting close to where the subject comes up. None when the
    chapter's questions are about something else, so the spot plays the subject itself."""
    inside = [clip for clip in episode["questions"] + episode["extras"]
              if clip.get("s") is not None and clip.get("end") and clip["p"] == chapter["p"]
              and chapter_of(episode, clip["p"], clip["s"]) is chapter]
    if not inside:
        return None
    for term in terms:
        for clip in inside:
            if term in normalize(clip["text"]):
                return clip
    closest = min(inside, key=lambda clip: abs(clip["s"] - near))
    return closest if abs(closest["s"] - near) <= NEAR_CLIP_SECONDS else None


JUDGE_SYSTEM = """あなたはポッドキャスト「あらB.fm」のアーカイブ編集者です。
リスナーがある回の「問い」への答えを聴き終えたあと、同じテーマを別の回で話している箇所へ案内します。
候補の章（別の回）から、問いと同じテーマか、問いの論点と深く関わる話題を話している章を選んでください。
問いへの別の角度からの答えや、背景になる考え方を話している章も含めます（例: 「FIREのあとも働く理由」に対して「お金と人生の話」）。
単語が一致するだけ、ジャンルが近いだけ（例: どちらもゲームの話）の章は選ばないでください。該当がなければ空で構いません。
JSON だけを返してください: {"picks":[{"id":候補番号,"reason":"共通点を30字以内で","phrase":"その章の文字起こしで話題が始まる所を探すための語句（章の本文に出てくる語）"}]}
picks は関連の強い順に最大3件。"""


def load_simple_env(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        key, sep, value = line.strip().partition("=")
        if sep and not key.startswith("#") and key.strip() not in os.environ:
            os.environ[key.strip()] = value.strip().strip("'\"")


class UsageLimitError(RuntimeError):
    """The provider refused for billing or rate limits, or the daily token cap is reached: retrying only
    burns time until the window resets."""


class DailyBudget:
    """Tokens used per UTC day, kept in a ledger shared by every run, with a hard cap checked before sending."""

    def __init__(self, path: Path, limit: int) -> None:
        self.path = path
        self.limit = limit
        self.lock = threading.Lock()
        self.days = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}

    @staticmethod
    def today() -> str:
        return time.strftime("%Y-%m-%d", time.gmtime())

    def reserve(self, instructions: str, prompt: str) -> int:
        # UTF-8 bytes bound the token count from above; add the output cap and protocol overhead.
        worst = len(instructions.encode("utf-8")) + len(prompt.encode("utf-8")) + OPENAI_MAX_OUTPUT_TOKENS + 2048
        with self.lock:
            used = self.days.get(self.today(), 0)
            if used + worst > self.limit:
                raise UsageLimitError(f"daily token cap reached ({used}/{self.limit} used on {self.today()} UTC)")
            # Hold the worst case until the real usage is known, so parallel requests cannot overshoot.
            self.days[self.today()] = used + worst
        return worst

    def settle(self, reserved: int, usage: dict) -> None:
        with self.lock:
            actual = int(usage.get("total_tokens", 0) or 0) if usage else reserved
            self.days[self.today()] = self.days.get(self.today(), 0) - reserved + actual
            self.path.write_text(json.dumps(self.days, indent=1), encoding="utf-8")


BUDGET: DailyBudget | None = None


def select_provider(name: str, key_env: str | None = None) -> None:
    """Use a provider, optionally with another account's key (e.g. OPENAI_API_KEY2); each OpenAI account has
    its own daily allowance, so each key keeps its own ledger."""
    global JUDGE_ENDPOINT, JUDGE_MODEL, JUDGE_KEY, JUDGE_ENV, BUDGET
    provider = PROVIDERS[name]
    JUDGE_ENDPOINT, JUDGE_MODEL, JUDGE_ENV = provider["endpoint"], provider["model"], provider["env"]
    JUDGE_KEY = key_env or provider["key"]
    ledger = OPENAI_LEDGER if JUDGE_KEY == provider["key"] else OPENAI_LEDGER.with_name(f"openai-daily-usage-{JUDGE_KEY}.json")
    BUDGET = DailyBudget(ledger, OPENAI_DAILY_TOKENS) if name == "openai" else None


def ask_judge(prompt: str, system: str = JUDGE_SYSTEM, required: str = "picks", kind: type = list) -> dict:
    """One Responses API call to the selected provider, retried with backoff; returns the parsed JSON answer."""
    payload = {"model": JUDGE_MODEL, "instructions": system, "input": prompt, "reasoning": {"effort": "low"}}
    headers = {
        "Authorization": f"Bearer {os.environ[JUDGE_KEY]}",
        "Content-Type": "application/json",
        "User-Agent": "arkbfm-question-related/1.0",
    }
    if BUDGET is None:
        headers["x-opencode-session"] = JUDGE_SESSION
    else:
        payload.update({"max_output_tokens": OPENAI_MAX_OUTPUT_TOKENS, "store": False})
    for attempt in range(4):
        reserved = BUDGET.reserve(system, prompt) if BUDGET else 0
        usage = {"total_tokens": 0}
        request = urllib.request.Request(JUDGE_ENDPOINT, data=json.dumps(payload, ensure_ascii=False).encode("utf-8"), headers=headers, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=180) as response:
                body = json.loads(response.read().decode("utf-8"))
            usage = body.get("usage") or {"total_tokens": reserved}
            text = body.get("output_text") or "".join(
                part.get("text", "") for item in body.get("output", []) for part in item.get("content", []) or []
                if part.get("type") == "output_text")
            answer = json.loads(text[text.index("{"):text.rindex("}") + 1])
            if isinstance(answer.get(required), kind):
                return answer
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")[:300]
            # 402, or a 429 about quota, means the allowance is spent; a plain 429 is a per-minute rate limit.
            if error.code == 402 or (error.code == 429 and "quota" in detail):
                raise UsageLimitError(f"HTTP {error.code}: {detail[:120]}") from error
            print(f"  retry {attempt + 1}: HTTP {error.code} {detail[:100]}", file=sys.stderr)
        except (urllib.error.URLError, TimeoutError, ValueError, KeyError) as error:
            print(f"  retry {attempt + 1}: {str(error)[:120]}", file=sys.stderr)
        finally:
            if BUDGET:
                BUDGET.settle(reserved, usage)
        time.sleep(5 * 2 ** attempt)
    raise RuntimeError("judge did not return a usable answer")


def excerpt(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[:limit] + "…"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, help="judge only this many uncached questions (for a trial run)")
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--provider", choices=sorted(PROVIDERS), default="opencode")
    parser.add_argument("--key-env", help="environment variable with the API key, for a second account (e.g. OPENAI_API_KEY2)")
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    select_provider(args.provider, args.key_env)

    episodes = load_episodes()
    documents = [(episode, chapter) for episode in episodes for chapter in episode["chapters"] if chapter["playable"]]
    document_vectors = embed([chapter["document"] for _, chapter in documents])
    frequency = Counter(term for _, chapter in documents for term in chapter["words"])
    idf = {term: math.log(len(documents) / count) for term, count in frequency.items()}

    # Headline questions keep their position (index) for the episode pages; chapter questions have index None.
    asked = [(episode, index, question) for episode in episodes for index, question in enumerate(episode["questions"])]
    asked += [(episode, None, question) for episode in episodes for question in episode["extras"] if question["s"] is not None]
    sources = [chapter_of(episode, question["p"], question["s"]) if question["s"] is not None else None for episode, _, question in asked]
    queries = [QUERY_PREFIX + question["text"] + (f"（{source['title']}）" if source else "") for (_, _, question), source in zip(asked, sources)]
    similarity = embed(queries) @ document_vectors.T
    penalty = np.array([GENERIC_PENALTY if chapter["generic"] else 0.0 for _, chapter in documents])

    # Stage 1: the closest chapters in meaning, one per other episode.
    shortlists = []
    for row, (episode, _, _) in enumerate(asked):
        picked, seen = [], set()
        for column in np.argsort(-(similarity[row] - penalty)):
            other, _ = documents[column]
            if other["base"] == episode["base"] or other["slug"] in seen:
                continue
            seen.add(other["slug"])
            picked.append(int(column))
            if len(picked) == CANDIDATES:
                break
        shortlists.append(picked)

    # Stage 2: an LLM reads the question and the candidates' table of contents and keeps real matches.
    def build_prompt(row: int, candidates: int, notes_chars: int, talk_chars: int) -> str:
        question, source = asked[row][2], sources[row]
        lines = [f"問い: {question['text']}"]
        if source:
            lines.append(f"問いが答えられている章: 「{source['title']}」 {excerpt(notes_text(source['raw']), 300)}")
        lines.append("候補:")
        for number, column in enumerate(shortlists[row][:candidates], 1):
            other, chapter = documents[column]
            lines.append(f"[{number}] {other['title']} ／ 章「{chapter['title']}」 メモ: {excerpt(notes_text(chapter['raw']), notes_chars)}"
                         f" 冒頭: {excerpt(chapter['spoken'], talk_chars)}")
        return "\n".join(lines)

    def prompt_for(row: int) -> tuple[str, str]:
        # The full prompt judged the first questions; a compact one (fewer, shorter candidates) costs less than
        # half the tokens for the rest. A verdict for either, from any provider's model, counts.
        full = build_prompt(row, CANDIDATES, 200, 200)
        compact = build_prompt(row, COMPACT_CANDIDATES, 100, 100)
        for prompt in (full, compact):
            for provider in PROVIDERS.values():
                key = hashlib.sha1((provider["model"] + JUDGE_SYSTEM + prompt).encode("utf-8")).hexdigest()
                if key in judged:
                    return key, prompt
        return hashlib.sha1((JUDGE_MODEL + JUDGE_SYSTEM + compact).encode("utf-8")).hexdigest(), compact

    judged = json.loads(JUDGE_CACHE.read_text(encoding="utf-8")) if JUDGE_CACHE.exists() else {}
    prompts = [prompt_for(row) for row in range(len(asked))]
    work = [(key, prompt) for key, prompt in prompts if key not in judged]
    if args.limit is not None:
        work = work[:args.limit]
    if work:
        # Second accounts' keys may live in either project's .env.
        for provider in PROVIDERS.values():
            load_simple_env(provider["env"])
        if JUDGE_KEY not in os.environ:
            raise SystemExit(f"{JUDGE_KEY} is not set (looked in {', '.join(str(p['env']) for p in PROVIDERS.values())})")
        print(f"judging {len(work)} questions with {JUDGE_MODEL}", file=sys.stderr)
        lock = threading.Lock()
        stopped = threading.Event()

        def judge(item: tuple[str, str]) -> None:
            # After a usage limit, skip the rest: their clips just go without related spots until a rerun.
            if stopped.is_set():
                return
            key, prompt = item
            try:
                answer = ask_judge(prompt)
            except UsageLimitError as error:
                if not stopped.is_set():
                    print(f"  stopping: {error}; rerun later to judge the rest", file=sys.stderr)
                stopped.set()
                return
            except RuntimeError as error:
                print(f"  skipped one question: {error}", file=sys.stderr)
                return
            with lock:
                judged[key] = answer
                JUDGE_CACHE.write_text(json.dumps(judged, ensure_ascii=False), encoding="utf-8")
                print(f"  {len(judged)} judged", file=sys.stderr, flush=True)

        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            list(pool.map(judge, work))

    related = {}
    clip_related = {}
    for row, ((episode, index, question), source) in enumerate(zip(asked, sources)):
        spots, compact = [], []
        verdict = judged.get(prompts[row][0], {"picks": []})
        for pick in verdict["picks"][:SPOTS_PER_QUESTION]:
            try:
                column = shortlists[row][int(pick["id"]) - 1]
            except (KeyError, ValueError, IndexError, TypeError):
                continue
            other, chapter = documents[column]
            wanted = question["words"] | (words(source["title"]) if source else set())
            shared = sorted((term for term in wanted if term in chapter["words"]), key=lambda term: -idf.get(term, 0))[:5]
            phrase = normalize(str(pick.get("phrase", "")))
            terms = ([phrase] if len(phrase) >= 2 else []) + shared
            reason = str(pick.get("reason", ""))[:40]
            spot = {"slug": other["slug"], "episode": other["title"], "chapter": chapter["title"], "reason": reason}
            spot.update(spot_in(other, chapter, terms))
            target = clip_in(other, chapter, terms, seconds_of(spot["time"]))
            if target:
                # Land on a question of that chapter, so the listener sees what the answer is about.
                spot.update({"time": target["time"], "end": target["end"], "id": target["id"], "question": target["text"]})
                if target["id"].split(".")[-1].isdigit():
                    spot["q"] = int(target["id"].split(".")[-1])
                else:
                    spot.pop("q", None)
            if other["parts"] > 1:
                spot["part"] = chapter["p"] + 1
            spots.append(spot)
            compact.append({"i": spot["id"], "r": reason} if "id" in spot else
                           {"s": spot["slug"], "t": spot["time"], "e": spot["end"], "p": spot.get("part"), "c": spot["chapter"], "r": reason})
        if index is not None:
            related.setdefault(episode["slug"], [[] for _ in episode["questions"]])[index] = spots
        if compact:
            clip_related[question["id"]] = compact

    related = {slug: questions for slug, questions in related.items() if any(questions)}
    OUTPUT.write_text(json.dumps(related, ensure_ascii=False, indent=1) + "\n", encoding="utf-8", newline="\n")
    CLIP_OUTPUT.write_text(json.dumps(clip_related, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8", newline="\n")
    counts = [len(spots) for spots in clip_related.values()]
    print(f"{len(clip_related)} of {len(asked)} clips with related spots, {sum(counts)} spots")


if __name__ == "__main__":
    main()
