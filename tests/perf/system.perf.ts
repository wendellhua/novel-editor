import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mockTypoContent } from '../../scripts/lib/mock-typo.ts';
import { DIST } from '../../scripts/lib/project.ts';
import { rawRequest } from '../../scripts/lib/smoke-runner.ts';
import { makeTempDir } from '../helpers/tmp';
import { entriesInText, mentionBlocks, settingBlocks } from '../../src/server/bible/context';
import { bodyHash } from '../../src/server/manuscript/repo';
import { tocChapters } from '../../src/server/manuscript/toc';
import { tx } from '../../src/server/storage/tx';
import { LIMITS } from '../../src/shared/constants';
import { countWords } from '../../src/shared/text';
import type { Chapter, Job, JobEstimate, LlmProfile } from '../../src/shared/types';
import { startTestApp, type TestApp } from '../helpers/app';
import { makeManuscript } from '../helpers/manuscript';
import { completion, startMockLlm, type MockLlm } from '../helpers/mock-llm';
import { createRandom } from '../helpers/random';

/**
 * T18 性能与稳健性验收（经由真实 HTTP 服务）：300 万字、3000 章的合成作品。
 * - §1.1 指标在 HTTP 层达标（含 JSON 序列化），以及 M3 新增、随作品规模增长的路径；
 * - 用 mock 模型跑完一次作品级错别字检查（3000 个单元），进程堆内存没有持续增长；
 * - 连续保存（时钟加速：2 小时、每 10 s 一次）不出错，版本数量符合保留策略。
 */
const VOLUMES = 30;
const CHAPTERS = 3000;
const CHAPTER_CHARS = 1000;
const BIG = 50_000;
const HAN = '天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏闰余成岁律吕调阳云腾致雨露结为霜金生丽水玉出昆冈剑号巨阙珠称夜光';
const NAMES = ['林远', '苏晴', '赵铁', '玄机子', '青云门', '落霞镇', '玄冰剑'];

function text(rand: () => number, chars: number, sprinkle: boolean): string {
  let out = '';
  for (let i = 0; i < chars; i++) {
    const r = rand();
    if (sprinkle && r < 0.004) out += NAMES[Math.floor(rand() * NAMES.length)];
    else if (sprinkle && r < 0.0045) out += '在接再厉';
    else out += r < 0.08 ? '，。'[Math.floor(rand() * 2)] : HAN[Math.floor(rand() * HAN.length)];
    if (i % 400 === 399) out += '\n';
  }
  return out;
}

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? Number.NaN;
async function timeIt(runs: number, fn: () => Promise<unknown>): Promise<number> {
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    await fn();
    samples.push(performance.now() - t0);
  }
  return median(samples);
}

setFlagsFromString('--expose_gc');
const gc = runInNewContext('gc') as () => void;
const heapMb = (): number => {
  gc();
  gc();
  return process.memoryUsage().heapUsed / 1024 / 1024;
};

let t: TestApp;
let llm: MockLlm;
let profile: LlmProfile;
let W = '';
let workId = '';
const report: Record<string, string> = {};

async function ok<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await t.call(method, path, body);
  if (res.status >= 400) throw new Error(`${method} ${path} → ${res.status} ${res.body.slice(0, 300)}`);
  return res.json as T;
}

beforeAll(async () => {
  llm = await startMockLlm((req) => completion(mockTypoContent(req.body)));
  t = await startTestApp();
  profile = await ok<LlmProfile>('POST', '/api/llm/profiles', { name: 'Mock', baseUrl: llm.baseUrl, model: 'mock', maxConcurrency: 4 });
  workId = (await ok<{ id: string }>('POST', '/api/works', { title: '性能验收' })).id;
  W = `/api/works/${workId}`;
  const db = t.app.services.pool.get(workId);
  const rand = createRandom(18);
  const t0 = performance.now();
  tx(db, () => {
    db.exec('DELETE FROM chapter; DELETE FROM volume;');
    const v = db.prepare('INSERT INTO volume(id, title, seq, created_at, updated_at) VALUES (?, ?, ?, 1, 1)');
    const c = db.prepare('INSERT INTO chapter(id, volume_id, title, seq, body, word_count, body_hash, rev, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, 1)');
    for (let i = 0; i < VOLUMES; i++) {
      v.run(`v${i}`, `第${i + 1}卷`, i);
      for (let k = 0; k < CHAPTERS / VOLUMES; k++) {
        const n = i * (CHAPTERS / VOLUMES) + k;
        const body = text(rand, n === 0 ? BIG : CHAPTER_CHARS, true);
        c.run(`c${n}`, `v${i}`, `第${n + 1}章`, k, body, countWords(body), bodyHash(body));
      }
    }
    // 设定库：300 个条目（含 7 个高频名称），每条 4 个事实
    const e = db.prepare("INSERT INTO bible_entry (id, kind, name, aliases, summary, created_at, updated_at) VALUES (?, ?, ?, '[]', '', 1, 1)");
    const f = db.prepare("INSERT INTO bible_fact (id, entry_id, attribute, value, mutable, chapter_id, quote, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, '', 1, 1)");
    for (let i = 0; i < 300; i++) {
      const name = i < NAMES.length ? (NAMES[i] as string) : `配角${i}号`;
      e.run(`e${i}`, i % 3 === 0 ? 'character' : 'other', name);
      for (let k = 0; k < 4; k++) f.run(`f${i}-${k}`, `e${i}`, k % 2 === 0 ? '境界' : '位置', `值${k}`, k % 2, `c${(i * 7 + k * 500) % CHAPTERS}`);
    }
  });
  t.app.services.fts.flushNow(workId);
  report['合成数据'] = `${CHAPTERS} 章 / ${((CHAPTERS - 1) * CHAPTER_CHARS + BIG) / 10000} 万字，设定库 300 条目，用时 ${((performance.now() - t0) / 1000).toFixed(1)} s`;
}, 600_000);

afterAll(async () => {
  console.log(`\nT18 性能与稳健性（中位数）：\n${Object.entries(report).map(([k, v]) => `  ${k}：${v}`).join('\n')}\n`);
  await t.cleanup();
  await llm.close();
});

describe('§1.1 指标（HTTP 层，3000 章 / 300 万字）', () => {
  it('目录树 < 200 ms、打开 5 万字章节 < 300 ms、保存 5 万字章节 < 50 ms', async () => {
    const tree = await timeIt(7, () => ok('GET', `${W}/tree`));
    const open = await timeIt(7, () => ok('GET', `${W}/chapters/c0`));
    let rev = (await ok<Chapter>('GET', `${W}/chapters/c0`)).rev;
    const base = (await ok<Chapter>('GET', `${W}/chapters/c0`)).body;
    let i = 0;
    const save = await timeIt(9, async () => {
      i++;
      rev = (await ok<{ rev: number }>('PUT', `${W}/chapters/c0/body`, { body: `${base}${'新'.repeat(i)}`, baseRev: rev })).rev;
    });
    report['目录树（HTTP）'] = `${tree.toFixed(1)} ms`;
    report['打开 5 万字章节（HTTP）'] = `${open.toFixed(1)} ms`;
    report['保存 5 万字章节（HTTP）'] = `${save.toFixed(1)} ms`;
    expect(tree).toBeLessThan(200);
    expect(open).toBeLessThan(300);
    expect(save).toBeLessThan(50);
  });

  it('M3 路径：作品级检查预估 < 1 s；一致性检查单个片段的 ③⑤ 上下文 < 100 ms', async () => {
    const est = await timeIt(3, () => ok<JobEstimate>('POST', `${W}/jobs/estimate`, { type: 'setting', scope: { kind: 'work', id: workId }, profileId: profile.id }));
    report['作品级一致性检查预估'] = `${est.toFixed(0)} ms`;
    expect(est).toBeLessThan(1000);
    const db = t.app.services.pool.get(workId);
    const toc = tocChapters(db);
    const chunk = (await ok<Chapter>('GET', `${W}/chapters/c2999`)).body;
    let blocks = 0;
    const ctx = await timeIt(5, async () => {
      const entries = entriesInText(db, chunk);
      blocks = settingBlocks(db, entries, 'c2999', toc).length + mentionBlocks(db, entries, 'c2999', toc).length;
    });
    report['③⑤ 上下文（最后一章，300 条目）'] = `${ctx.toFixed(1)} ms，${blocks} 段`;
    expect(blocks).toBeGreaterThan(0);
    expect(ctx).toBeLessThan(100);
  });
});

describe('稳健性', () => {
  it('作品级错别字检查（3000+ 个单元，mock 模型）：跑完且堆内存没有持续增长；读取全部问题 < 500 ms', async () => {
    const job = await ok<Job>('POST', `${W}/jobs`, { type: 'typo', scope: { kind: 'work', id: workId }, profileId: profile.id });
    const samples: { done: number; mb: number }[] = [];
    const t0 = performance.now();
    let next = 0.1;
    for (;;) {
      const j = await ok<Job>('GET', `${W}/jobs/${job.id}`);
      const progress = (j.doneUnits + j.failedUnits) / Math.max(1, j.totalUnits);
      if (progress >= next || j.status !== 'running') {
        // mock 模型与服务在同一进程里，它记录的请求体不属于服务的内存，采样前清掉
        llm.requests.length = 0;
        samples.push({ done: j.doneUnits, mb: heapMb() });
        next += 0.1;
      }
      if (j.status !== 'running' && j.status !== 'queued') {
        expect(j.status).toBe('done');
        expect(j.failedUnits).toBe(0);
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    const seconds = (performance.now() - t0) / 1000;
    const tail = samples.slice(Math.floor(samples.length / 3));
    const growth = (tail.at(-1)?.mb ?? 0) - (tail[0]?.mb ?? 0);
    const spread = Math.max(...tail.map((s) => s.mb)) - Math.min(...tail.map((s) => s.mb));
    report['作品级错别字检查'] = `${samples.at(-1)?.done} 个单元，${seconds.toFixed(1)} s；堆内存 ${samples.map((s) => s.mb.toFixed(0)).join(' → ')} MB`;
    expect(growth, '后 2/3 进度中堆内存净增长').toBeLessThan(8);
    expect(spread).toBeLessThan(16);

    const list = await timeIt(3, () => ok<unknown[]>('GET', `${W}/issues`));
    const n = (await ok<unknown[]>('GET', `${W}/issues`)).length;
    report['读取全部问题'] = `${n} 条，${list.toFixed(0)} ms`;
    expect(n).toBeGreaterThan(1000);
    expect(list).toBeLessThan(500);
  }, 600_000);
});

describe('冷启动（构建产物）', () => {
  const serverCjs = join(DIST, 'server.cjs');
  it.skipIf(!existsSync(serverCjs))('数据目录里有 300 万字作品时，从启动进程到作品列表与目录树返回 < 2 s', async () => {
    const tmp = makeTempDir('ne-perf-start-');
    try {
      mkdirSync(join(tmp.dir, 'works'), { recursive: true });
      t.app.services.pool.get(workId).exec(`VACUUM INTO '${join(tmp.dir, 'works', `${workId}.novel`).replace(/'/g, "''")}'`);
      const t0 = performance.now();
      const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', serverCjs, '--data-dir', tmp.dir, '--no-browser'], { windowsHide: true });
      try {
        const read = (f: string): Record<string, unknown> | null => {
          try {
            return JSON.parse(readFileSync(join(tmp.dir, f), 'utf8')) as Record<string, unknown>;
          } catch {
            return null;
          }
        };
        while (read('instance.json')?.pid !== child.pid) {
          if (performance.now() - t0 > 10_000) throw new Error('服务未能启动');
          await new Promise((r) => setTimeout(r, 10));
        }
        const listening = performance.now() - t0;
        const port = read('instance.json')?.port as number;
        const secret = read('config.json')?.authSecret as string;
        const nonce = (JSON.parse((await rawRequest(port, { method: 'POST', path: '/api/system/nonce', headers: { 'X-Auth-Secret': secret } })).body) as { nonce: string }).nonce;
        const cookie = (await rawRequest(port, { path: `/auth?n=${nonce}` })).headers['set-cookie']?.[0]?.split(';')[0] ?? '';
        const works = JSON.parse((await rawRequest(port, { path: '/api/works', headers: { Cookie: cookie } })).body) as { id: string; chapterCount: number }[];
        const tree = await rawRequest(port, { path: `/api/works/${workId}/tree`, headers: { Cookie: cookie } });
        const total = performance.now() - t0;
        report['冷启动（构建产物，含 300 万字作品）'] = `监听 ${listening.toFixed(0)} ms，作品列表 + 目录树返回 ${total.toFixed(0)} ms`;
        expect(works.find((w) => w.id === workId)?.chapterCount).toBe(CHAPTERS);
        expect(tree.status).toBe(200);
        expect(total).toBeLessThan(2000);
      } finally {
        child.kill();
        await new Promise((r) => setTimeout(r, 300));
      }
    } finally {
      tmp.cleanup();
    }
  });
});

describe('连续保存（时钟加速）', () => {
  it('2 小时、每 10 s 保存一次：不出错；自动版本每 10 分钟一个；继续到 6 小时后只保留最新 30 个', () => {
    const f = makeManuscript();
    try {
      const w = f.ms.createWork({ title: '长时间保存' });
      const chapterId = f.ms.getTree(w.id).volumes[0]!.chapters[0]!.id;
      const t0 = f.clock.t;
      let rev = 0;
      let errors = 0;
      const saveFor = (seconds: number): void => {
        for (let s = 0; s < seconds; s += 10) {
          try {
            rev = f.ms.saveChapterBody(w.id, chapterId, { body: `第 ${f.clock.t - t0} 秒的内容。`.repeat(50), baseRev: rev }).rev;
          } catch {
            errors++;
          }
          f.clock.t += 10_000;
        }
      };
      const autoCount = (): number =>
        (f.pool.get(w.id).prepare("SELECT count(*) AS n FROM chapter_revision WHERE chapter_id = ? AND reason = 'auto'").get(chapterId) as { n: number }).n;
      const started = performance.now();
      saveFor(2 * 3600);
      const interval = LIMITS.autoRevisionIntervalMs / 1000;
      expect(errors).toBe(0);
      expect(rev).toBe(720);
      expect(autoCount(), '第一次保存 + 之后每 10 分钟一个').toBe(Math.floor((720 - 1) * 10 / interval) + 1);
      saveFor(4 * 3600);
      expect(errors).toBe(0);
      expect(autoCount()).toBe(LIMITS.autoRevisionKeep);
      const oldest = f.pool.get(w.id).prepare("SELECT min(created_at) AS t FROM chapter_revision WHERE chapter_id = ? AND reason = 'auto'").get(chapterId) as { t: number };
      expect(oldest.t, '最早的被清理').toBeGreaterThan(t0);
      report['连续保存 6 小时（加速）'] = `${rev} 次保存，${((performance.now() - started) / 1000).toFixed(1)} s，自动版本保留 ${autoCount()} 个`;
    } finally {
      f.cleanup();
    }
  });
});
