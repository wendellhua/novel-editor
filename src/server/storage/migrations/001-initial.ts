import type { Migration } from './types';

/** schema v1（docs/ARCHITECTURE.md §6.1）。列名 snake_case；时间为毫秒时间戳；文本偏移为 UTF-16 码元。 */
export const migration001: Migration = {
  version: 1,
  name: 'initial',
  up(db) {
    db.exec(`
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE work (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT '',
  genre TEXT NOT NULL DEFAULT '',
  synopsis TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE volume (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  seq INTEGER NOT NULL,
  deleted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE chapter (
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  volume_id TEXT NOT NULL REFERENCES volume(id),
  title TEXT NOT NULL,
  seq INTEGER NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  word_count INTEGER NOT NULL DEFAULT 0,
  body_hash TEXT NOT NULL,
  rev INTEGER NOT NULL DEFAULT 0,
  deleted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_chapter_volume ON chapter(volume_id, seq);

CREATE TABLE chapter_revision (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chapter_id TEXT NOT NULL REFERENCES chapter(id) ON DELETE CASCADE,
  rev INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  word_count INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('auto','manual','before_fix','before_restore')),
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_revision_chapter ON chapter_revision(chapter_id, created_at);

-- 全文索引延迟构建（ADR-003 修订）：正文变化只登记脏行，由 storage/fts.ts 在后台或查询前批量重建。
-- contentless_delete=1 允许只凭 rowid 删除旧索引，不需要旧正文。
CREATE VIRTUAL TABLE chapter_fts USING fts5(body, content='', contentless_delete=1, tokenize='trigram');
CREATE TABLE chapter_fts_dirty (rid INTEGER PRIMARY KEY);
CREATE TRIGGER chapter_fts_ai AFTER INSERT ON chapter BEGIN
  INSERT INTO chapter_fts(rowid, body) VALUES (new.rid, new.body);
END;
CREATE TRIGGER chapter_fts_ad AFTER DELETE ON chapter BEGIN
  DELETE FROM chapter_fts WHERE rowid = old.rid;
  DELETE FROM chapter_fts_dirty WHERE rid = old.rid;
END;
CREATE TRIGGER chapter_fts_au AFTER UPDATE OF body ON chapter BEGIN
  INSERT OR IGNORE INTO chapter_fts_dirty(rid) VALUES (new.rid);
END;

CREATE TABLE chapter_analysis (
  chapter_id TEXT NOT NULL REFERENCES chapter(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('summary','bible_extract')),
  body_hash TEXT NOT NULL,
  result TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (chapter_id, kind)
);

CREATE TABLE bible_entry (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('character','location','faction','item','rule','other')),
  name TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT '[]',
  summary TEXT NOT NULL DEFAULT '',
  first_chapter_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE bible_fact (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL REFERENCES bible_entry(id) ON DELETE CASCADE,
  attribute TEXT NOT NULL,
  value TEXT NOT NULL,
  mutable INTEGER NOT NULL DEFAULT 0 CHECK (mutable IN (0,1)),
  chapter_id TEXT,
  quote TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_fact_entry ON bible_fact(entry_id);

CREATE TABLE bible_candidate (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  op TEXT NOT NULL CHECK (op IN ('new_entry','new_fact','new_alias')),
  target_entry_id TEXT,
  payload TEXT NOT NULL,
  chapter_id TEXT NOT NULL,
  quote TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','accepted','rejected')),
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);

CREATE TABLE job (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('typo','review','setting','character','bible_extract')),
  skill_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('work','volume','chapter')),
  scope_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  only_changed INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('queued','running','paused','done','failed','cancelled')),
  total_units INTEGER NOT NULL DEFAULT 0,
  done_units INTEGER NOT NULL DEFAULT 0,
  failed_units INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);

CREATE TABLE job_unit (
  job_id TEXT NOT NULL REFERENCES job(id) ON DELETE CASCADE,
  phase TEXT NOT NULL CHECK (phase IN ('summary','main','reduce')),
  chapter_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  range_start INTEGER NOT NULL,
  range_end INTEGER NOT NULL,
  body_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','done','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  PRIMARY KEY (job_id, phase, chapter_id, chunk_index)
);

CREATE TABLE issue (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES job(id) ON DELETE CASCADE,
  chapter_id TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('typo','punctuation','grammar','review','setting','character')),
  severity TEXT NOT NULL CHECK (severity IN ('error','warning','info')),
  excerpt TEXT NOT NULL,
  target TEXT NOT NULL,
  start_offset INTEGER NOT NULL,
  end_offset INTEGER NOT NULL,
  replacement TEXT,
  message TEXT NOT NULL,
  evidence TEXT NOT NULL DEFAULT '',
  body_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','applied','ignored','stale')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_issue_chapter ON issue(chapter_id, status);

CREATE TABLE job_report (
  job_id TEXT NOT NULL REFERENCES job(id) ON DELETE CASCADE,
  chapter_id TEXT NOT NULL DEFAULT '',
  markdown TEXT NOT NULL,
  PRIMARY KEY (job_id, chapter_id)
);
`);
  },
};
