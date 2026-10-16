import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CHUNK_CHARS, PROMPT_PROTOCOL_MAX_CHARS } from '../../src/shared/constants';
import { locate } from '../../src/shared/anchor';
import { PROMPT_FRAME_CHARS, estimateJob } from '../../src/server/checks/estimate';
import { isUnitLevelError } from '../../src/server/checks/job-runner';
import { assemblePrompt, promptBudget, targetHeader, type PromptParts } from '../../src/server/checks/prompt';
import { TYPO_PROTOCOL } from '../../src/server/checks/protocol';
import { insertJob, insertUnits } from '../../src/server/checks/repo';
import { planUnits, type PlanInput } from '../../src/server/checks/units';
import { DomainError } from '../../src/server/errors';
import { LlmError } from '../../src/server/llm/errors';
import { bodyHash } from '../../src/server/manuscript/repo';
import { MAX_TARGET_HEADER_CHARS } from '../../src/server/static-data';
import type { SqliteDatabase } from '../../src/server/storage/sqlite';
import { makeManuscript, type ManuscriptFixture } from '../helpers/manuscript';

let f: ManuscriptFixture;
let workId: string;
let db: SqliteDatabase;
/** 卷 → 章节 id（按顺序）。 */
let vols: { id: string; chapters: string[] }[];

function write(chapterId: string, body: string): void {
  const rev = f.ms.getChapter(workId, chapterId).rev;
  f.ms.saveChapterBody(workId, chapterId, { body, baseRev: rev });
}

/** 两卷：第 1 卷 4 章（第 2 章为空），第 2 卷 3 章。第 1 卷第 1 章 6000 字（错别字分块 2500 → 3 块）。 */
beforeEach(() => {
  f = makeManuscript();
  const work = f.ms.createWork({ title: '测试书' });
  workId = work.id;
  const tree = f.ms.getTree(workId);
  const v1 = tree.volumes[0]!;
  const c1 = v1.chapters[0]!.id;
  const v2 = f.ms.createVolume(workId, { title: '第二卷' });
  const chapterIds1 = [c1];
  for (let i = 0; i < 3; i++) chapterIds1.push(f.ms.createChapter(workId, { volumeId: v1.id, title: `第${i + 2}章` }).id);
  const chapterIds2: string[] = [];
  for (let i = 0; i < 3; i++) chapterIds2.push(f.ms.createChapter(workId, { volumeId: v2.id, title: `第${i + 5}章` }).id);
  vols = [
    { id: v1.id, chapters: chapterIds1 },
    { id: v2.id, chapters: chapterIds2 },
  ];
  write(c1, `${'甲'.repeat(1999)}\n`.repeat(3));
  [...chapterIds1.slice(2), ...chapterIds2].forEach((id, i) => write(id, `正文${i}。`.repeat(10)));
  db = f.pool.get(workId);
});
afterEach(() => f.cleanup());

const plan = (patch: Partial<PlanInput> = {}) =>
  planUnits(db, { workId, type: 'typo', skillId: 'builtin:typo-check', scope: { kind: 'work', id: workId }, onlyChanged: false, ...patch });

describe('units：执行单元规划（F3 第 1、2 步）', () => {
  it('作品范围：按卷序、章序展开，空章跳过，长章按 CHUNK_CHARS 切块且首尾相接', () => {
    const p = plan();
    const order = p.units.map((u) => u.chapterId);
    const expected = [vols[0]!.chapters[0]!, ...vols[0]!.chapters.slice(2), ...vols[1]!.chapters];
    expect([...new Set(order)]).toEqual(expected);
    expect(p.chapters).toBe(6);
    const first = p.units.filter((u) => u.chapterId === expected[0]);
    expect(first.map((u) => u.chunkIndex)).toEqual([0, 1, 2]);
    expect(first.every((u) => u.end - u.start <= CHUNK_CHARS.typo)).toBe(true);
    expect(first.map((u) => [u.start, u.end])).toEqual([
      [0, 2000],
      [2000, 4000],
      [4000, 6000],
    ]);
    expect(p.chars).toBe(6000 + 5 * 40);
    expect(p.units.every((u) => u.phase === 'main')).toBe(true);
  });

  it('分卷与章节范围；不存在、已删除或作品 id 不符的范围 → NOT_FOUND', () => {
    expect(new Set(plan({ scope: { kind: 'volume', id: vols[1]!.id } }).units.map((u) => u.chapterId))).toEqual(new Set(vols[1]!.chapters));
    expect(plan({ scope: { kind: 'chapter', id: vols[1]!.chapters[0]! } }).units).toHaveLength(1);
    expect(plan({ scope: { kind: 'chapter', id: vols[0]!.chapters[1]! } }).units, '空章没有单元').toHaveLength(0);
    f.ms.deleteChapter(workId, vols[1]!.chapters[0]!);
    for (const scope of [
      { kind: 'chapter', id: vols[1]!.chapters[0]! },
      { kind: 'volume', id: 'nope' },
      { kind: 'work', id: 'other-work' },
    ] as const) {
      expect(() => plan({ scope }), JSON.stringify(scope)).toThrow(DomainError);
    }
  });

  it('onlyChanged：跳过上次同类型、同技能且全部单元完成、哈希一致的章节', () => {
    const [a, , b, c] = vols[0]!.chapters as [string, string, string, string];
    const fakeJob = (id: string, skillId: string) =>
      insertJob(db, {
        id,
        type: 'typo',
        skill_id: skillId,
        scope_kind: 'work',
        scope_id: workId,
        profile_id: 'p',
        only_changed: 0,
        options: '{}',
        status: 'done',
        total_units: 0,
        done_units: 0,
        failed_units: 0,
        prompt_tokens: 0,
        completion_tokens: 0,
        error: null,
        created_at: 1,
        started_at: null,
        finished_at: null,
      });
    const hash = (id: string): string => bodyHash(f.ms.getChapter(workId, id).body);
    fakeJob('j1', 'builtin:typo-check');
    insertUnits(db, 'j1', [
      { phase: 'main', chapterId: b, chunkIndex: 0, start: 0, end: 40, bodyHash: hash(b) },
      { phase: 'main', chapterId: c, chunkIndex: 0, start: 0, end: 40, bodyHash: 'old-hash' },
      { phase: 'main', chapterId: a, chunkIndex: 0, start: 0, end: 2000, bodyHash: hash(a) },
      { phase: 'main', chapterId: a, chunkIndex: 1, start: 2000, end: 4000, bodyHash: hash(a) },
    ]);
    db.exec("UPDATE job_unit SET status = 'done'");
    db.prepare("UPDATE job_unit SET status = 'pending' WHERE chapter_id = ? AND chunk_index = 1").run(a);
    const p = plan({ onlyChanged: true });
    const chapters = new Set(p.units.map((u) => u.chapterId));
    expect(chapters.has(b), 'b 未改动 → 跳过').toBe(false);
    expect(chapters.has(c), 'c 哈希不同 → 检查').toBe(true);
    expect(chapters.has(a), 'a 有未完成单元 → 检查').toBe(true);
    expect(p.skippedChapters).toBe(1);
    expect(plan({ onlyChanged: true, skillId: 'local:x' }).skippedChapters, '技能不同不算检查过').toBe(0);
    write(b, '改过了');
    expect(plan({ onlyChanged: true }).skippedChapters, '改动后不再跳过').toBe(0);
  });

  it('一致性检查：为每个待查章节的前 3 章（全书顺序）中缺少有效摘要缓存的章节生成 summary 单元', () => {
    const all = [...vols[0]!.chapters, ...vols[1]!.chapters];
    const target = all[5]!;
    const cache = (id: string, hash: string) =>
      db.prepare("INSERT INTO chapter_analysis (chapter_id, kind, body_hash, result, model, created_at) VALUES (?, 'summary', ?, '{}', 'm', 1)").run(id, hash);
    cache(all[3]!, bodyHash(f.ms.getChapter(workId, all[3]!).body));
    cache(all[4]!, 'stale');
    const p = plan({ type: 'setting', scope: { kind: 'chapter', id: target } });
    expect(p.units.map((u) => `${u.phase}:${all.indexOf(u.chapterId)}`)).toEqual(['summary:2', 'summary:4', 'main:5']);
  });

  it('审稿：summary → main → reduce；reduce 单元 chapter_id 为空串', () => {
    const p = plan({ type: 'review', scope: { kind: 'volume', id: vols[1]!.id } });
    const phases = p.units.map((u) => u.phase);
    expect(phases.indexOf('main')).toBeGreaterThan(phases.lastIndexOf('summary'));
    expect(p.units.at(-1)).toEqual({ phase: 'reduce', chapterId: '', chunkIndex: 0, start: 0, end: 0, bodyHash: '' });
  });
});

describe('estimate：预估', () => {
  it('每个单元 = 阶段开销 + 片段标题 + 片段正文；chapters / chars / units 来自规划', () => {
    const p = plan();
    const e = estimateJob(p, { main: 1000 });
    expect(e).toEqual({
      chapters: 6,
      chars: p.chars,
      units: p.units.length,
      skippedChapters: 0,
      estimatedInputTokens: p.chars + p.units.length * (1000 + PROMPT_FRAME_CHARS),
    });
  });
});

describe('prompt：组装与预算裁剪（§7.4.1）', () => {
  const parts: PromptParts = {
    protocol: '①协议',
    skillRules: '②规则',
    setting: [
      { text: '③【林惊羽】人物·不变：青云门弟子', trimmable: false, order: 0 },
      { text: '③【林惊羽】境界（第3章）：玉清三层', trimmable: true, order: 3 },
      { text: '③【林惊羽】境界（第8章）：玉清五层', trimmable: true, order: 8 },
      { text: '③【林惊羽】位置（第5章）：大竹峰', trimmable: true, order: 5 },
    ],
    recap: [
      { text: '④第7章：……', trimmable: true, order: 7 },
      { text: '④第8章：……', trimmable: true, order: 8 },
      { text: '④第9章：……', trimmable: true, order: 9 },
    ],
    mentions: [
      { text: '⑤【林惊羽】第2章：……前后各八十字……', trimmable: true, order: 2 },
      { text: '⑤【林惊羽】第6章：……前后各八十字……', trimmable: true, order: 6 },
    ],
    target: { header: targetHeader({ seq: 0, title: '第一卷' }, { seq: 9, title: '第十章' }, 0, 2), text: '⑥待查正文' },
  };

  it('预算充足时不裁剪；结构快照', () => {
    const r = assemblePrompt(parts, 100_000);
    expect(r.trimmed).toEqual([]);
    expect(r.overBudget).toBe(false);
    expect(r.messages).toMatchSnapshot();
  });

  it('逐步缩小预算：裁剪顺序依次为 ⑤ → ④ → ③，同一部分内先裁较早的；不可裁剪的段落永远保留（快照）', () => {
    const full = assemblePrompt(parts, 100_000).inputChars;
    const fixed = assemblePrompt(parts, 0);
    expect(fixed.overBudget).toBe(true);
    expect(fixed.trimmed.map((t) => t.section)).toEqual(['mentions', 'mentions', 'recap', 'recap', 'recap', 'setting', 'setting', 'setting']);
    expect(fixed.trimmed.map((t) => t.text.slice(0, 18))).toMatchSnapshot();
    expect(fixed.messages[1]?.content).toContain('人物·不变');
    expect(fixed.messages[1]?.content).not.toContain('## 前情提要');
    // 每一个中间预算都恰好裁掉「刚好放得下」所需的段落数，且裁剪序列是完整序列的前缀
    const seq = fixed.trimmed.map((t) => t.text);
    for (let budget = full; budget >= fixed.inputChars; budget -= 7) {
      const r = assemblePrompt(parts, budget);
      expect(r.inputChars <= budget || r.overBudget).toBe(true);
      expect(r.trimmed.map((t) => t.text)).toEqual(seq.slice(0, r.trimmed.length));
    }
  });

  it('promptBudget = contextTokens − maxOutputTokens − 1000；⑥ 标题格式', () => {
    expect(promptBudget({ contextTokens: 64_000, maxOutputTokens: 4096 })).toBe(58_904);
    expect(parts.target.header).toBe('【第1卷 第一卷 · 第10章 第十章 · 片段 1/2】');
    expect(TYPO_PROTOCOL.length + MAX_TARGET_HEADER_CHARS).toBeLessThanOrEqual(PROMPT_PROTOCOL_MAX_CHARS);
  });
});

describe('anchor：首次锚定（§7.4.3）', () => {
  const body = '他在接再厉，终于练成。后来他又在接再厉一次。林惊羽说："好,我们走吧。"';
  const all = { start: 0, end: body.length };

  it('精确匹配：返回的 target 与原文逐字一致', () => {
    const hits = locate(body, all, '他在接再厉，终于', '在接再厉', 'typo');
    expect(hits).toEqual([{ start: 1, end: 5, excerpt: '他在接再厉，终于', target: '在接再厉' }]);
    expect(body.slice(hits[0]!.start, hits[0]!.end)).toBe('在接再厉');
  });

  it('typo / punctuation 类每个出现位置都生成一处，其他类别只取第一处', () => {
    expect(locate(body, all, '在接再厉', '在接再厉', 'typo').map((h) => h.start)).toEqual([1, 15]);
    expect(locate(body, all, '在接再厉', '在接再厉', 'review').map((h) => h.start)).toEqual([1]);
  });

  it('只在单元范围内查找', () => {
    expect(locate(body, { start: 10, end: body.length }, '在接再厉', '在接再厉', 'typo').map((h) => h.start)).toEqual([15]);
  });

  it('归一化匹配：模型改了全半角标点或加了空格，仍能映射回原文位置', () => {
    const hits = locate(body, all, '说：“好，我们 走吧', ',', 'punctuation');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.target).toBe(',');
    expect(body.slice(hits[0]!.start, hits[0]!.end)).toBe(',');
    expect(hits[0]!.excerpt).toBe('说："好,我们走吧');
  });

  it('target 不在 excerpt 中、excerpt 找不到、空值 → []', () => {
    expect(locate(body, all, '他在接再厉，终于', '练成', 'typo')).toEqual([]);
    expect(locate(body, all, '原文里没有这一句', '没有', 'typo')).toEqual([]);
    expect(locate(body, all, '', 'x', 'typo')).toEqual([]);
    expect(locate(body, all, '在接再厉', '', 'typo')).toEqual([]);
  });

  it('含代理对的正文：偏移按 UTF-16 码元', () => {
    const b = '𠀀𠀁他在接再厉';
    const hits = locate(b, { start: 0, end: b.length }, '他在接再厉', '在接', 'typo');
    expect(hits[0]).toMatchObject({ start: 5, end: 7, target: '在接' });
  });
});

describe('isUnitLevelError：单元级与任务级失败的划分', () => {
  it.each([
    ['invalid_output', undefined, true],
    ['length', undefined, true],
    ['empty', undefined, true],
    ['http', 400, true],
    ['http', 413, true],
    ['http', 422, true],
    ['http', 401, false],
    ['http', 402, false],
    ['http', 404, false],
    ['http', 429, false],
    ['http', 503, false],
    ['timeout', undefined, false],
    ['network', undefined, false],
    ['config', undefined, false],
    ['bad_response', undefined, false],
  ] as const)('%s %s → 单元级 %s', (kind, status, unitLevel) => {
    expect(isUnitLevelError(new LlmError(kind, 'x', status === undefined ? {} : { status }))).toBe(unitLevel);
  });
});
