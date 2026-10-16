import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createBook, modelFromEnv, runJob, startBaselineApp, type Call } from './lib/baseline.ts';
import { BIBLE_SAMPLE, EXPECTED_ENTRIES } from './lib/bible-sample.ts';
import { CACHE } from './lib/project.ts';

/**
 * 设定抽取的真实模型冒烟（T16 验证）：对 10 章样书执行抽取 → 全部接受（与已有条目同名的合并）→
 * 检查主要角色与设定是否进入设定库、事实是否带章节标签。需要真实的模型服务（会产生少量费用）：
 *
 *   NE_LLM_BASE_URL=https://api.deepseek.com NE_LLM_API_KEY=sk-... NE_LLM_MODEL=deepseek-chat npm run baseline:bible
 *
 * 结果写到 .cache/bible-baseline.json。
 */
interface Candidate {
  id: string;
  op: string;
  targetEntryId: string | null;
  payload: { name?: string };
}
interface Entry {
  id: string;
  name: string;
  kind: string;
  aliases: string[];
}
interface Fact {
  attribute: string;
  value: string;
  mutable: boolean;
  chapterId: string | null;
  quote: string;
}

/** 像界面上的「全部接受」一样处理候选：冲突时改为合并到冲突的条目，直到没有待审核的候选。 */
async function acceptAll(call: Call, B: string): Promise<{ accepted: number; merged: number }> {
  let accepted = 0;
  let merged = 0;
  for (let round = 0; round < 50; round++) {
    const pending = await call<Candidate[]>('GET', `${B}/candidates?status=pending`);
    if (pending.length === 0) break;
    try {
      accepted += (await call<{ accepted: number }>('POST', `${B}/candidates/decide`, { decisions: pending.map((c) => ({ id: c.id, action: 'accept' })) })).accepted;
    } catch (err) {
      const body = JSON.parse((err as { body?: string }).body ?? '{}') as { error?: { code?: string; entryId?: string; candidateId?: string } };
      const e = body.error;
      if (e?.code !== 'NAME_CONFLICT' || e.entryId === undefined || e.candidateId === undefined) throw err;
      await call('POST', `${B}/candidates/decide`, { decisions: [{ id: e.candidateId, action: 'merge', mergeIntoEntryId: e.entryId }] });
      merged++;
    }
  }
  return { accepted, merged };
}

const outFile = process.env.NE_BASELINE_OUT ?? join(CACHE, 'bible-baseline.json');
const m = modelFromEnv('baseline:bible');
let exitCode = 0;
const app = await startBaselineApp(m).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
try {
  const { W, workId, ids } = await createBook(app.call, '设定基线', BIBLE_SAMPLE);
  const B = `${W}/bible`;
  const started = Date.now();
  const job = await runJob(app.call, W, { type: 'bible_extract', scope: { kind: 'work', id: workId }, profileId: app.profileId });
  const candidates = await app.call<Candidate[]>('GET', `${B}/candidates?status=pending`);
  const decided = await acceptAll(app.call, B);
  const entries = await app.call<Entry[]>('GET', `${B}/entries`);
  const facts = (await Promise.all(entries.map(async (e) => (await app.call<Fact[]>('GET', `${B}/entries/${e.id}/facts`)).map((f) => ({ ...f, entry: e.name }))))).flat();
  const bodies = new Map(ids.map((id, i) => [id, BIBLE_SAMPLE[i]!.body]));
  const has = (name: string): boolean => entries.some((e) => e.name === name || e.aliases.includes(name));
  const found = EXPECTED_ENTRIES.filter(has);
  const chapterNo = new Map(ids.map((id, i) => [id, i + 1]));
  const lin = entries.find((e) => e.name === '林远' || e.aliases.includes('林远'));
  const report = {
    date: new Date().toISOString(),
    model: m.model,
    baseUrl: m.baseUrl,
    jsonMode: app.jsonMode,
    seconds: Math.round((Date.now() - started) / 1000),
    tokens: { prompt: job.promptTokens, completion: job.completionTokens },
    failedUnits: job.failedUnits,
    candidates: candidates.length,
    accepted: decided.accepted,
    mergedOnConflict: decided.merged,
    entries: entries.length,
    expected: EXPECTED_ENTRIES.length,
    expectedFound: found.length,
    missing: EXPECTED_ENTRIES.filter((n) => !has(n)),
    facts: facts.length,
    factsWithChapter: facts.filter((f) => f.chapterId !== null).length,
    quotesVerbatim: facts.every((f) => f.quote === '' || (f.chapterId !== null && (bodies.get(f.chapterId) ?? '').includes(f.quote))),
    linYuanTimeline: facts
      .filter((f) => lin !== undefined && f.entry === lin.name && f.mutable)
      .map((f) => `${f.attribute}=${f.value}（第 ${chapterNo.get(f.chapterId ?? '') ?? '?'} 章）`),
    entryList: entries.map((e) => `${e.name}[${e.kind}]${e.aliases.length > 0 ? `（${e.aliases.join('、')}）` : ''}`),
  };
  writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    `\n模型 ${m.model}（${app.jsonMode}）：候选 ${report.candidates} 条，接受 ${report.accepted}（冲突合并 ${report.mergedOnConflict}），` +
      `设定库 ${report.entries} 个条目、${report.facts} 条事实（带章节 ${report.factsWithChapter}），主要设定命中 ${report.expectedFound}/${report.expected}，用时 ${report.seconds} s`,
  );
  if (report.missing.length > 0) console.log(`未出现：${report.missing.join('、')}`);
  console.log(`林远的可变事实：${report.linYuanTimeline.join('；') || '（无）'}`);
  console.log(`条目：${report.entryList.join('、')}`);
  console.log(`\n结果已写入 ${outFile}`);
  if (!report.quotesVerbatim) throw new Error('INV-8 违反：有事实的引文不是来源章节的逐字子串');
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  exitCode = 1;
} finally {
  await app.close();
}
process.exit(exitCode);
