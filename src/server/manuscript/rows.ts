import type { Chapter, ChapterNode, RevisionMeta, RevisionReason, Work } from '../../shared/types';

/** 数据库行（snake_case）。只在 repository 层与 camelCase DTO 互相转换（§6 命名约定）。 */
export interface WorkRow {
  id: string;
  title: string;
  author: string;
  genre: string;
  synopsis: string;
  created_at: number;
  updated_at: number;
}

export interface VolumeRow {
  id: string;
  title: string;
  seq: number;
  deleted_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface ChapterRow {
  rid: number;
  id: string;
  volume_id: string;
  title: string;
  seq: number;
  body: string;
  word_count: number;
  body_hash: string;
  rev: number;
  deleted_at: number | null;
  created_at: number;
  updated_at: number;
}

export type ChapterNodeRow = Pick<ChapterRow, 'id' | 'volume_id' | 'title' | 'seq' | 'word_count' | 'updated_at'>;

export interface RevisionRow {
  id: number;
  chapter_id: string;
  rev: number;
  title: string;
  body: string;
  word_count: number;
  reason: RevisionReason;
  created_at: number;
}

export function toWork(r: WorkRow): Work {
  return {
    id: r.id,
    title: r.title,
    author: r.author,
    genre: r.genre,
    synopsis: r.synopsis,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function toChapter(r: ChapterRow): Chapter {
  return {
    id: r.id,
    volumeId: r.volume_id,
    title: r.title,
    seq: r.seq,
    body: r.body,
    rev: r.rev,
    wordCount: r.word_count,
    updatedAt: r.updated_at,
  };
}

export function toChapterNode(r: ChapterNodeRow): ChapterNode {
  return { id: r.id, volumeId: r.volume_id, title: r.title, seq: r.seq, wordCount: r.word_count, updatedAt: r.updated_at };
}

export function toRevisionMeta(r: Omit<RevisionRow, 'title' | 'body'>): RevisionMeta {
  return { id: r.id, chapterId: r.chapter_id, rev: r.rev, reason: r.reason, wordCount: r.word_count, createdAt: r.created_at };
}
