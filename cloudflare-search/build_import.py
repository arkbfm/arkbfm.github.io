#!/usr/bin/env python3
"""Generate a private D1 import file from local proofread transcripts."""
from __future__ import annotations

import json
from pathlib import Path
import re
from collections import Counter


ROOT = Path(__file__).resolve().parents[1]
HERE = Path(__file__).resolve().parent
TRANSCRIPTS = ROOT / "transcripts"
OUTPUT = HERE / "import.sql"
VECTOR_DOCUMENTS = HERE / "vector-documents.json"
AUDIO_MIGRATION = HERE / "audio-migration.sql"
METADATA_MIGRATION = HERE / "metadata-migration.sql"
BATCH_SIZE = 5
DICTIONARY_BATCH_SIZE = 20
CHUNK_CHARS = 800


def quote(value) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, (int, float)):
        return str(value)
    return "'" + str(value).replace("\x00", "").replace("'", "''") + "'"


def chunks(segments: list[dict]):
    chunk = []
    for segment in segments:
        if chunk and (segment.get("part", 1) != chunk[0].get("part", 1)
                      or sum(len(item["text"]) for item in chunk) >= CHUNK_CHARS):
            yield chunk
            chunk = []
        chunk.append(segment)
    if chunk:
        yield chunk


def frontmatter(source: str, key: str) -> str:
    match = re.search(rf"^{re.escape(key)}:\s*(.*)$", source, re.MULTILINE)
    return match.group(1).strip().strip('"') if match else ""


def main() -> None:
    manifest = json.loads((TRANSCRIPTS / "manifest.json").read_text(encoding="utf-8"))
    manifest_posts = {episode["post"] for episode in manifest["episodes"]}
    rows = []
    segment_keys = set()
    episode_audio = {}
    episode_rows = []
    for episode in manifest["episodes"]:
        path = TRANSCRIPTS / "proofread" / f"Ep{episode['id']}.json"
        if not path.exists():
            continue
        transcript = json.loads(path.read_text(encoding="utf-8"))
        post = (ROOT / episode["post"]).read_text(encoding="utf-8-sig")
        match = re.search(r"^audio_url:\s*(.+)$", post, re.MULTILINE)
        spotify_ids = [value.strip() for value in match.group(1).split(",")] if match else []
        assert spotify_ids, f"audio_url not found: {episode['post']}"
        episode_audio[episode["id"]] = spotify_ids
        slug = re.sub(r"^\d{4}-\d{2}-\d{2}-|\.md$", "", Path(episode["post"]).name)
        body = post.split("---", 2)[-1]
        actor_block = re.search(r"^actor_ids:\s*\n((?:\s+- .+\n?)+)", post, re.MULTILINE)
        actors = ", ".join(re.findall(r"^\s+-\s+(.+)$", actor_block.group(1), re.MULTILINE)) if actor_block else ""
        episode_rows.append((
            episode["id"], episode["title"], slug, frontmatter(post, "description"),
            body, episode["date"][:10], actors,
        ))
        for chunk_id, chunk in enumerate(chunks(transcript["segments"])):
            key = (episode["id"], chunk_id)
            assert key not in segment_keys, f"duplicate segment: {key}"
            segment_keys.add(key)
            speakers = {segment.get("speaker") for segment in chunk}
            rows.append((
                episode["id"], episode["title"], episode["post"],
                spotify_ids[min(int(chunk[0].get("part", 1)) - 1, len(spotify_ids) - 1)],
                int(chunk[0].get("part", 1)), chunk_id,
                float(chunk[0]["start"]), float(chunk[-1]["end"]),
                speakers.pop() if len(speakers) == 1 else None,
                " ".join(segment["text"] for segment in chunk),
            ))

    for post_path in sorted((ROOT / "_posts").glob("[0-9]*.md")):
        relative = post_path.relative_to(ROOT).as_posix()
        if relative in manifest_posts:
            continue
        post = post_path.read_text(encoding="utf-8-sig")
        slug = re.sub(r"^\d{4}-\d{2}-\d{2}-|\.md$", "", post_path.name)
        actor_block = re.search(r"^actor_ids:\s*\n((?:\s+- .+\n?)+)", post, re.MULTILINE)
        actors = ", ".join(re.findall(r"^\s+-\s+(.+)$", actor_block.group(1), re.MULTILINE)) if actor_block else ""
        episode_rows.append((
            slug, frontmatter(post, "title"), slug, frontmatter(post, "description"),
            post.split("---", 2)[-1], frontmatter(post, "date")[:10], actors,
        ))

    assert rows, "no proofread transcript segments found"
    assert len({row[0] for row in episode_rows}) == len(episode_rows), "duplicate episode id"

    with OUTPUT.open("w", encoding="utf-8", newline="\n") as output:
        output.write((HERE / "schema.sql").read_text(encoding="utf-8") + "\n")
        columns = "episode,title,post,spotify_id,part,segment_id,start,end,speaker,text"
        for index in range(0, len(rows), BATCH_SIZE):
            values = ",\n".join("(" + ",".join(map(quote, row)) + ")" for row in rows[index:index + BATCH_SIZE])
            output.write(f"INSERT INTO segments ({columns}) VALUES\n{values};\n")
        output.write("INSERT INTO segments_fts(segments_fts) VALUES('rebuild');\n")
    with AUDIO_MIGRATION.open("w", encoding="utf-8", newline="\n") as output:
        output.write("ALTER TABLE segments ADD COLUMN spotify_id TEXT;\n")
        for episode, spotify_ids in episode_audio.items():
            for part, spotify_id in enumerate(spotify_ids, 1):
                output.write(
                    f"UPDATE segments SET spotify_id={quote(spotify_id)} "
                    f"WHERE episode={quote(episode)} AND part={part};\n"
                )
        output.write("SELECT count(*) AS missing_spotify_ids FROM segments WHERE spotify_id IS NULL;\n")
    aliases = []
    for line in (TRANSCRIPTS / "glossary.yml").read_text(encoding="utf-8").splitlines():
        if line.strip() and not line.lstrip().startswith("#") and ":" in line:
            term, replacement = line.split(":", 1)
            aliases.append((term.strip(), replacement.strip()))
    vocabulary = Counter(
        token.lower()
        for text in [*(row[9] for row in rows), *(" ".join((row[1], row[3], row[4])) for row in episode_rows)]
        for token in re.findall(r"[A-Za-z0-9][A-Za-z0-9.+#-]{1,31}", text)
    )
    vocabulary_rows = [row for row in vocabulary.most_common() if row[1] >= 2]
    with METADATA_MIGRATION.open("w", encoding="utf-8", newline="\n") as output:
        output.write("DROP TABLE IF EXISTS episodes_fts;\nDROP TABLE IF EXISTS episodes;\nDROP TABLE IF EXISTS search_aliases;\nDROP TABLE IF EXISTS search_vocabulary;\n")
        output.write("CREATE TABLE episodes (id TEXT PRIMARY KEY,title TEXT NOT NULL,slug TEXT NOT NULL,description TEXT NOT NULL,show_notes TEXT NOT NULL,published_at TEXT NOT NULL,actors TEXT NOT NULL);\n")
        output.write("CREATE VIRTUAL TABLE episodes_fts USING fts5(title,description,show_notes,content='episodes',content_rowid='rowid',tokenize='trigram');\n")
        output.write("CREATE TABLE search_aliases (term TEXT NOT NULL,replacement TEXT NOT NULL);\n")
        output.write("CREATE TABLE search_vocabulary (term TEXT PRIMARY KEY,frequency INTEGER NOT NULL);\n")
        columns = "id,title,slug,description,show_notes,published_at,actors"
        for index in range(0, len(episode_rows), BATCH_SIZE):
            values = ",\n".join("(" + ",".join(map(quote, row)) + ")" for row in episode_rows[index:index + BATCH_SIZE])
            output.write(f"INSERT INTO episodes ({columns}) VALUES\n{values};\n")
        if aliases:
            for index in range(0, len(aliases), DICTIONARY_BATCH_SIZE):
                values = ",\n".join("(" + ",".join(map(quote, row)) + ")" for row in aliases[index:index + DICTIONARY_BATCH_SIZE])
                output.write(f"INSERT INTO search_aliases (term,replacement) VALUES\n{values};\n")
        for index in range(0, len(vocabulary_rows), DICTIONARY_BATCH_SIZE):
            values = ",\n".join("(" + ",".join(map(quote, row)) + ")" for row in vocabulary_rows[index:index + DICTIONARY_BATCH_SIZE])
            output.write(f"INSERT INTO search_vocabulary (term,frequency) VALUES\n{values};\n")
        output.write("INSERT INTO episodes_fts(episodes_fts) VALUES('rebuild');\n")
        output.write("SELECT count(*) AS episodes FROM episodes;\n")
    documents = [
        {"id": f"s:{row[0]}:{row[5]}", "text": row[9],
         "metadata": {"kind": "segment", "episode": row[0], "segment_id": row[5]}}
        for row in rows
    ] + [
        {"id": f"e:{row[0]}", "text": "\n".join((row[1], row[3], row[4]))[:2000],
         "metadata": {"kind": "episode", "episode": row[0]}}
        for row in episode_rows
    ]
    VECTOR_DOCUMENTS.write_text(json.dumps(documents, ensure_ascii=False), encoding="utf-8")
    print(f"wrote {OUTPUT.name}: {len(rows)} segments and {len(episode_rows)} episode metadata rows")


if __name__ == "__main__":
    main()
