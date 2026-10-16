import type { Migration } from './types';

const JOB_TYPES = "'typo','review','setting','character','ai_flavor','inspiration','expand','bible_extract','memory'";
const ISSUE_CATEGORIES = "'typo','punctuation','grammar','review','setting','character','ai_flavor'";
const REVISION_REASONS = "'auto','manual','before_fix','before_restore','before_expand'";

/**
 * schema v2（docs/ARCHITECTURE.md §6.1、ADR-011）：创作辅助与剧情记忆。
 * - 重建 job（新任务类型 + options）、issue（ai_flavor 类问题）、chapter_revision（before_expand 版本）：
 *   SQLite 不能修改 CHECK 约束，只能新建表 → 按 rowid 顺序复制 → 删除旧表 → 改名，并重建索引（外键已由 migrate 关闭）；
 * - 新增 expansion（智能扩写结果）、plot_memory_entry（剧情记忆的增量记录与快照）、plot_memory_chapter（每章已纳入的进度）。
 */
export const migration002: Migration = {
  version: 2,
  name: 'creative-assist',
  rebuildsTables: true,
  up(db) {
    db.exec(`
CREATE TABLE job_v2 (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN (${JOB_TYPES})),
  skill_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('work','volume','chapter')),
  scope_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  only_changed INTEGER NOT NULL DEFAULT 0,
  options TEXT NOT NULL DEFAULT '{}',
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
INSERT INTO job_v2 (id, type, skill_id, scope_kind, scope_id, profile_id, only_changed, status, total_units, done_units, failed_units,
  prompt_tokens, completion_tokens, error, created_at, started_at, finished_at)
  SELECT id, type, skill_id, scope_kind, scope_id, profile_id, only_changed, status, total_units, done_units, failed_units,
    prompt_tokens, completion_tokens, error, created_at, started_at, finished_at FROM job ORDER BY rowid;
DROP TABLE job;
ALTER TABLE job_v2 RENAME TO job;

CREATE TABLE issue_v2 (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES job(id) ON DELETE CASCADE,
  chapter_id TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN (${ISSUE_CATEGORIES})),
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
INSERT INTO issue_v2 SELECT id, job_id, chapter_id, category, severity, excerpt, target, start_offset, end_offset, replacement,
  message, evidence, body_hash, status, created_at, updated_at FROM issue ORDER BY rowid;
DROP TABLE issue;
ALTER TABLE issue_v2 RENAME TO issue;
CREATE INDEX idx_issue_chapter ON issue(chapter_id, status);

CREATE TABLE chapter_revision_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chapter_id TEXT NOT NULL REFERENCES chapter(id) ON DELETE CASCADE,
  rev INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  word_count INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN (${REVISION_REASONS})),
  created_at INTEGER NOT NULL
);
INSERT INTO chapter_revision_v2 SELECT id, chapter_id, rev, title, body, word_count, reason, created_at FROM chapter_revision ORDER BY id;
DROP TABLE chapter_revision;
ALTER TABLE chapter_revision_v2 RENAME TO chapter_revision;
CREATE INDEX idx_revision_chapter ON chapter_revision(chapter_id, created_at);

-- 智能扩写：每个扩写任务一条结果；插入章末后 status = applied（不能重复插入）
CREATE TABLE expansion (
  job_id TEXT PRIMARY KEY REFERENCES job(id) ON DELETE CASCADE,
  chapter_id TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ready','applied')),
  created_at INTEGER NOT NULL,
  applied_at INTEGER
);

-- 剧情记忆（ADR-011）：每次增量更新一行，记录本次纳入的章节、新增事件与更新后的全书状态快照；不随任务删除
CREATE TABLE plot_memory_entry (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE,
  job_id TEXT NOT NULL DEFAULT '',
  chapter_ids TEXT NOT NULL,
  label TEXT NOT NULL,
  chars INTEGER NOT NULL,
  events TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- 每章已纳入剧情记忆的进度：covered_chars 之前的正文已记录；anchor 是已纳入部分末尾的原文，改稿后据此找回接续位置
CREATE TABLE plot_memory_chapter (
  chapter_id TEXT PRIMARY KEY REFERENCES chapter(id) ON DELETE CASCADE,
  covered_chars INTEGER NOT NULL,
  anchor TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`);
  },
};
