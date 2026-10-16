import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { countWords } from '../../src/shared/text';
import { bodyHash } from '../../src/server/manuscript/repo';
import { flushFtsIndex, searchChapterRids } from '../../src/server/storage/fts';
import { tx } from '../../src/server/storage/tx';
import { makeManuscript, type ManuscriptFixture } from '../helpers/manuscript';
import { createRandom } from '../helpers/random';

/** 假设 A1：单部作品 ≤ 300 万字、≤ 3000 章、单章 ≤ 5 万字；目标见 §1.1。 */
const VOLUMES = 30;
const CHAPTERS = 3000;
const CHAPTER_CHARS = 1000;
const BIG_CHAPTER_CHARS = 50_000;

const HAN = '天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏闰余成岁律吕调阳云腾致雨露结为霜金生丽水玉出昆冈剑号巨阙珠称夜光';
const PUNCT = '，，，。。！？';

function paragraphText(rand: () => number, chars: number): string {
  let out = '';
  let line = 0;
  for (let i = 0; i < chars; i++) {
    const r = rand();
    out += r < 0.08 ? PUNCT[Math.floor(rand() * PUNCT.length)] : HAN[Math.floor(rand() * HAN.length)];
    line++;
    if (line > 60 && r < 0.03) {
      out += '\n';
      line = 0;
    }
  }
  return out;
}

function median(samples: number[]): number {
  const s = [...samples].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? Number.NaN;
}

function measure(runs: number, fn: () => void): number {
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  return median(samples);
}

let f: ManuscriptFixture;
let workId = '';
let bigChapterId = '';
const report: Record<string, string> = {};
const samples: number[] = [];

beforeAll(() => {
  f = makeManuscript();
  const w = f.ms.createWork({ title: '性能测试作品' });
  workId = w.id;
  const db = f.pool.get(workId);
  const rand = createRandom(2026);
  const t0 = performance.now();
  tx(db, () => {
    db.exec('DELETE FROM chapter; DELETE FROM volume;');
    const vStmt = db.prepare('INSERT INTO volume(id, title, seq, created_at, updated_at) VALUES (?, ?, ?, 1, 1)');
    const cStmt = db.prepare(
      'INSERT INTO chapter(id, volume_id, title, seq, body, word_count, body_hash, rev, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, 1)',
    );
    for (let v = 0; v < VOLUMES; v++) {
      const vid = `vol-${v}`;
      vStmt.run(vid, `第${v + 1}卷`, v);
      const per = CHAPTERS / VOLUMES;
      for (let c = 0; c < per; c++) {
        const n = v * per + c;
        const chars = n === 0 ? BIG_CHAPTER_CHARS : CHAPTER_CHARS;
        const body = paragraphText(rand, chars);
        cStmt.run(`ch-${n}`, vid, `第${n + 1}章`, c, body, countWords(body), bodyHash(body));
      }
    }
  });
  bigChapterId = 'ch-0';
  const stats = db.prepare('SELECT count(*) AS n, sum(length(body)) AS chars FROM chapter').get() as { n: number; chars: number };
  report['合成数据'] = `${stats.n} 章 / ${(stats.chars / 10000).toFixed(0)} 万字符，用时 ${((performance.now() - t0) / 1000).toFixed(1)} s`;
});

afterAll(() => {
  console.log(`\n性能测试结果（中位数）：\n${Object.entries(report).map(([k, v]) => `  ${k}：${v}`).join('\n')}\n`);
  f.cleanup();
});

describe('作品服务性能（§1.1 目标，A1 规模）', () => {
  it('目录树 < 200 ms', () => {
    f.pool.closeAll();
    const cold = measure(1, () => f.ms.getTree(workId));
    const warm = measure(7, () => f.ms.getTree(workId));
    const tree = f.ms.getTree(workId);
    expect(tree.volumes.flatMap((v) => v.chapters)).toHaveLength(CHAPTERS);
    report['目录树'] = `冷 ${cold.toFixed(1)} ms / 热 ${warm.toFixed(1)} ms`;
    expect(Math.max(cold, warm)).toBeLessThan(200);
  });

  it('打开 5 万字章节 < 300 ms', () => {
    const ms = measure(7, () => f.ms.getChapter(workId, bigChapterId));
    expect(f.ms.getChapter(workId, bigChapterId).body.length).toBeGreaterThanOrEqual(BIG_CHAPTER_CHARS);
    report['读取 5 万字章节'] = `${ms.toFixed(1)} ms`;
    expect(ms).toBeLessThan(300);
  });

  it('保存 5 万字章节 < 50 ms（含 FTS 重建索引、synchronous=FULL）', () => {
    let rev = f.ms.getChapter(workId, bigChapterId).rev;
    const base = f.ms.getChapter(workId, bigChapterId).body;
    let i = 0;
    const ms = measure(9, () => {
      i++;
      rev = f.ms.saveChapterBody(workId, bigChapterId, { body: `${base}${'新'.repeat(i)}`, baseRev: rev }).rev;
    });
    report['保存 5 万字章节'] = `${ms.toFixed(1)} ms`;
    expect(ms).toBeLessThan(50);
  });

  it('后台冲刷 5 万字章节的全文索引（不在保存请求路径上）', () => {
    const db = f.pool.get(workId);
    let rev = f.ms.getChapter(workId, bigChapterId).rev;
    const base = f.ms.getChapter(workId, bigChapterId).body;
    let i = 0;
    const ms = measure(7, () => {
      i++;
      rev = f.ms.saveChapterBody(workId, bigChapterId, { body: `${base}${'冲'.repeat(i)}`, baseRev: rev }).rev;
      const t0 = performance.now();
      expect(flushFtsIndex(db)).toBe(1);
      samples.push(performance.now() - t0);
    });
    report['后台冲刷 5 万字索引'] = `${median(samples).toFixed(1)} ms（保存 + 冲刷合计 ${ms.toFixed(1)} ms）`;
    expect(searchChapterRids(db, base.slice(100, 106))).toContain(1);
  });

  it('保存普通章节（1000 字）', () => {
    let rev = 1;
    let i = 0;
    const ms = measure(9, () => {
      i++;
      rev = f.ms.saveChapterBody(workId, 'ch-1500', { body: `正文${i}`.repeat(200), baseRev: rev }).rev;
    });
    report['保存 1000 字章节'] = `${ms.toFixed(1)} ms`;
    expect(ms).toBeLessThan(50);
  });

  it('作品列表与导出', async () => {
    f.pool.closeAll();
    report['作品列表（冷）'] = `${measure(1, () => f.ms.listWorks()).toFixed(1)} ms`;
    const t0 = performance.now();
    const out = await f.ms.exportWork(workId, 'txt');
    report['导出 TXT'] = `${(performance.now() - t0).toFixed(0)} ms，${(out.content.length / 10000).toFixed(0)} 万字符`;
    expect(out.content.length).toBeGreaterThan(3_000_000);
  });
});
