import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SUMMARY_MAX_CHARS, cleanSummary, readSummary, saveSummaryChunk } from '../../src/server/checks/analysis';
import { fitSections, type ReduceSection } from '../../src/server/checks/context';
import { chapterComments, saveChapterComment, saveOverallReport } from '../../src/server/checks/report';
import { migrate } from '../../src/server/storage/migrations';
import { openDatabase, type SqliteDatabase } from '../../src/server/storage/sqlite';
import { createRandom } from '../helpers/random';

let db: SqliteDatabase;
beforeEach(() => {
  db = openDatabase(':memory:');
  migrate(db, '0.0.0-test');
  db.exec(`INSERT INTO volume (id, title, seq, created_at, updated_at) VALUES ('v', '卷', 0, 1, 1);
    INSERT INTO chapter (id, volume_id, title, seq, body, body_hash, word_count, rev, created_at, updated_at) VALUES ('c', 'v', '章', 0, '正文', 'h1', 2, 1, 1, 1);
    INSERT INTO job (id, type, skill_id, scope_kind, scope_id, profile_id, status, created_at) VALUES ('j', 'review', 's', 'work', 'w', 'p', 'running', 1);`);
});
afterEach(() => db.close());

const save = (bodyHash: string, index: number, count: number, text: string): boolean =>
  saveSummaryChunk(db, { chapterId: 'c', bodyHash, index, count, text, model: 'm', now: 1 });
const hashOf = (): string => (db.prepare("SELECT body_hash FROM chapter_analysis WHERE chapter_id = 'c'").get() as { body_hash: string }).body_hash;

describe('摘要缓存（chapter_analysis）', () => {
  it('单片段直接生效；多片段乱序写入，凑齐后按顺序合并，凑齐前保留上一个完整版本', () => {
    expect(save('h1', 0, 1, '  第一版\n摘要  ')).toBe(true);
    expect(readSummary(db, 'c')).toEqual({ summary: '第一版 摘要', bodyHash: 'h1' });
    expect(save('h2', 2, 3, '丙')).toBe(false);
    expect(save('h2', 0, 3, '甲')).toBe(false);
    expect(readSummary(db, 'c'), '未凑齐时仍是上一个完整版本').toEqual({ summary: '第一版 摘要', bodyHash: 'h1' });
    expect(save('h2', 1, 3, '乙')).toBe(true);
    expect(readSummary(db, 'c')).toEqual({ summary: '甲 乙 丙', bodyHash: 'h2' });
  });

  it('片段数或正文版本变化时重新收集；损坏的 JSON 视为没有缓存', () => {
    save('h2', 0, 2, '甲');
    save('h3', 1, 3, '新乙');
    save('h3', 0, 3, '新甲');
    expect(hashOf()).toBe('');
    save('h3', 2, 3, '新丙');
    expect(readSummary(db, 'c')).toEqual({ summary: '新甲 新乙 新丙', bodyHash: 'h3' });
    db.prepare("UPDATE chapter_analysis SET result = 'oops' WHERE chapter_id = 'c'").run();
    expect(readSummary(db, 'c')).toBeNull();
    expect(save('h4', 1, 2, '乙')).toBe(false);
    expect(save('h4', 0, 2, '甲')).toBe(true);
  });

  it('cleanSummary 合并空白并按码点截断', () => {
    expect(cleanSummary('a\n\n b\t c')).toBe('a b c');
    const long = '😀'.repeat(SUMMARY_MAX_CHARS + 5);
    expect([...cleanSummary(long)]).toHaveLength(SUMMARY_MAX_CHARS + 1);
  });
});

describe('逐章评语分节（job_report）', () => {
  const md = (): string => chapterComments(db, 'j').get('c') ?? '';

  it('多片段按片段号排序；片段数变化时丢弃旧分节；模型输出中的分节标记被去掉加粗；空评语不写', () => {
    saveChapterComment(db, 'j', 'c', 2, 3, '三');
    saveChapterComment(db, 'j', 'c', 0, 3, '一\n\n**片段 9/9**\n多行');
    expect(md()).toBe('**片段 1/3**\n\n一\n\n片段 9/9\n多行\n\n**片段 3/3**\n\n三');
    saveChapterComment(db, 'j', 'c', 1, 3, '二');
    expect(md().match(/^\*\*片段 \d\/3\*\*$/gm)).toEqual(['**片段 1/3**', '**片段 2/3**', '**片段 3/3**']);
    saveChapterComment(db, 'j', 'c', 1, 2, '新二');
    expect(md()).toBe('**片段 2/2**\n\n新二');
    saveChapterComment(db, 'j', 'c', 0, 1, '整章');
    expect(md()).toBe('整章');
    saveChapterComment(db, 'j', 'c', 0, 1, '   ');
    expect(md()).toBe('整章');
    saveOverallReport(db, 'j', '  ## 总体\n');
    expect(chapterComments(db, 'j').size, '整体报告不算逐章评语').toBe(1);
  });
});

describe('fitSections：汇总输入放进预算', () => {
  const sections = (n: number, len: number): ReduceSection[] => Array.from({ length: n }, (_, i) => ({ heading: `### 第${i + 1}章`, body: '字'.repeat(len + i) }));

  it('放得下时原样拼接', () => {
    const s = sections(3, 10);
    const r = fitSections(s, 10_000);
    expect(r).toEqual({ text: s.map((x) => `${x.heading}\n${x.body}`).join('\n\n'), truncated: 0, omitted: 0 });
  });

  it('属性：任意预算下结果不超过预算；截断时用满到只差最后一档；章节过多时省略并注明', () => {
    const rand = createRandom(5);
    for (let k = 0; k < 300; k++) {
      const n = 1 + Math.floor(rand() * 60);
      const s = sections(n, Math.floor(rand() * 400));
      const budget = Math.floor(rand() * 12_000);
      const r = fitSections(s, budget);
      expect(r.text.length, JSON.stringify({ n, budget })).toBeLessThanOrEqual(Math.max(budget, 0) + (r.omitted === n ? 20 : 0));
      // cap 已是最大：再大一档时每个被截断的章最多多 1 个字，就会超出预算
      if (r.omitted === 0 && r.truncated > 0) expect(r.text.length).toBeGreaterThan(budget - r.truncated);
      if (r.omitted > 0) expect(r.text).toContain(`（另有 ${r.omitted} 章因篇幅省略）`);
    }
  });
});
