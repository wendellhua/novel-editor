import type { SqliteDatabase } from '../storage/sqlite';

/** 目录中的一章（不含正文，避免把全书正文读进内存）。rid 是全文索引使用的行号。 */
export interface TocChapter {
  id: string;
  rid: number;
  title: string;
  seq: number;
  volume: { seq: number; title: string };
}

/** 全部未删除章节，按卷序、章序排列（与目录树、检查规划的顺序一致）。 */
export function tocChapters(db: SqliteDatabase): TocChapter[] {
  const rows = db
    .prepare(
      `SELECT c.id, c.rid, c.title, c.seq, v.seq AS vseq, v.title AS vtitle FROM chapter c JOIN volume v ON v.id = c.volume_id
       WHERE c.deleted_at IS NULL AND v.deleted_at IS NULL ORDER BY v.seq, v.created_at, c.seq, c.created_at`,
    )
    .all() as { id: string; rid: number; title: string; seq: number; vseq: number; vtitle: string }[];
  return rows.map((r) => ({ id: r.id, rid: r.rid, title: r.title, seq: r.seq, volume: { seq: r.vseq, title: r.vtitle } }));
}

/** 「第1卷 卷名 · 第3章 章名」。 */
export const chapterLabel = (c: TocChapter): string => `第${c.volume.seq + 1}卷 ${c.volume.title} · 第${c.seq + 1}章 ${c.title}`;

/** 短标签「第1卷第3章」（用于事实来源等）。 */
export const chapterShortLabel = (c: TocChapter): string => `第${c.volume.seq + 1}卷第${c.seq + 1}章`;
