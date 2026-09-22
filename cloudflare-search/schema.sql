DROP TABLE IF EXISTS segments_fts;
DROP TABLE IF EXISTS segments;
DROP TABLE IF EXISTS episodes_fts;
DROP TABLE IF EXISTS episodes;
DROP TABLE IF EXISTS search_aliases;
DROP TABLE IF EXISTS search_vocabulary;

CREATE TABLE segments (
  rowid INTEGER PRIMARY KEY,
  episode TEXT NOT NULL,
  title TEXT NOT NULL,
  post TEXT NOT NULL,
  spotify_id TEXT NOT NULL,
  part INTEGER NOT NULL,
  segment_id INTEGER NOT NULL,
  start REAL NOT NULL,
  end REAL NOT NULL,
  speaker TEXT,
  text TEXT NOT NULL,
  UNIQUE (episode, segment_id)
);

CREATE INDEX segments_episode_idx ON segments (episode, part, start);
CREATE VIRTUAL TABLE segments_fts USING fts5(
  text,
  content='segments',
  content_rowid='rowid',
  tokenize='trigram'
);

CREATE TABLE episodes (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT NOT NULL,
  show_notes TEXT NOT NULL,
  published_at TEXT NOT NULL,
  actors TEXT NOT NULL
);
CREATE VIRTUAL TABLE episodes_fts USING fts5(
  title, description, show_notes,
  content='episodes',
  content_rowid='rowid',
  tokenize='trigram'
);
CREATE TABLE search_aliases (term TEXT NOT NULL, replacement TEXT NOT NULL);
CREATE TABLE search_vocabulary (term TEXT PRIMARY KEY, frequency INTEGER NOT NULL);
