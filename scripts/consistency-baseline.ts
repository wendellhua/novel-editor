import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createBook, modelFromEnv, runJob, startBaselineApp, type Call } from './lib/baseline.ts';
import { CONSISTENCY_SAMPLE, CONTRADICTIONS, REASONABLE, SEED, locateMarker } from './lib/consistency-sample.ts';
import { CACHE } from './lib/project.ts';

/**
 * 一致性检查的真实模型基线（T17 验证）：对埋了 6 处矛盾、另有 3 处合理变化的样书，用预先建好的设定库
 * 运行设定一致性与角色一致性检查，统计检出数与「把合理变化误报为矛盾」的数量；再对比设定库为空（关闭专名白名单）
 * 与建好设定库（开启白名单）时，错别字检查把专有名词误判为错字的数量。需要真实的模型服务（会产生少量费用）：
 *
 *   NE_LLM_BASE_URL=https://api.deepseek.com NE_LLM_API_KEY=sk-... NE_LLM_MODEL=deepseek-chat npm run baseline:consistency
 *
 * 结果写到 .cache/consistency-baseline.json。
 */
interface Issue {
  id: string;
  chapterId: string;
  category: string;
  target: string;
  start: number;
  end: number;
  message: string;
  evidence: string;
}

const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }): boolean => a.start < b.end && b.start < a.end;

async function seedBible(call: Call, W: string, ids: readonly string[]): Promise<void> {
  for (const e of SEED) {
    const entry = await call<{ id: string }>('POST', `${W}/bible/entries`, { kind: e.kind, name: e.name, aliases: e.aliases, summary: e.summary });
    for (const f of e.facts) {
      await call('POST', `${W}/bible/entries/${entry.id}/facts`, { attribute: f.attribute, value: f.value, mutable: f.mutable, chapterId: ids[f.chapter], quote: f.quote });
    }
  }
}

/** 专有名词在样书中出现的全部位置（按章节）。 */
function nameRanges(ids: readonly string[]): Map<string, { start: number; end: number }[]> {
  const names = SEED.flatMap((e) => [e.name, ...e.aliases]);
  const out = new Map<string, { start: number; end: number }[]>();
  CONSISTENCY_SAMPLE.forEach((c, i) => {
    const list: { start: number; end: number }[] = [];
    for (const n of names) for (let at = c.body.indexOf(n); at >= 0; at = c.body.indexOf(n, at + 1)) list.push({ start: at, end: at + n.length });
    out.set(ids[i] as string, list);
  });
  return out;
}

async function typoRun(call: Call, profileId: string, withBible: boolean): Promise<{ total: number; properNoun: number; details: string[] }> {
  const { W, workId, ids } = await createBook(call, withBible ? '白名单开' : '白名单关', CONSISTENCY_SAMPLE);
  if (withBible) await seedBible(call, W, ids);
  const job = await runJob(call, W, { type: 'typo', scope: { kind: 'work', id: workId }, profileId });
  const issues = await call<Issue[]>('GET', `${W}/issues?jobId=${job.id}`);
  const ranges = nameRanges(ids);
  const hitsName = (i: Issue): boolean => (ranges.get(i.chapterId) ?? []).some((r) => overlaps(i, r));
  return { total: issues.length, properNoun: issues.filter(hitsName).length, details: issues.filter(hitsName).map((i) => `${i.target}：${i.message}`) };
}

const outFile = process.env.NE_BASELINE_OUT ?? join(CACHE, 'consistency-baseline.json');
const m = modelFromEnv('baseline:consistency');
let exitCode = 0;
const app = await startBaselineApp(m).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
try {
  const { W, workId, ids } = await createBook(app.call, '一致性基线', CONSISTENCY_SAMPLE);
  await seedBible(app.call, W, ids);
  const started = Date.now();
  const jobs = [];
  for (const type of ['setting', 'character']) jobs.push(await runJob(app.call, W, { type, scope: { kind: 'work', id: workId }, profileId: app.profileId }));
  const issues = (await Promise.all(jobs.map((j) => app.call<Issue[]>('GET', `${W}/issues?jobId=${j.id}`)))).flat();
  const at = (mk: (typeof CONTRADICTIONS)[number]) => {
    const p = locateMarker(mk);
    return { chapterId: ids[p.chapter] as string, start: p.start, end: p.end };
  };
  // 判定按「问题与关键文字所在的整句」重叠计算：模型框选的 target 常比关键文字略宽或略窄
  const hit = (mk: (typeof CONTRADICTIONS)[number]) => {
    const p = at(mk);
    const body = CONSISTENCY_SAMPLE[ids.indexOf(p.chapterId)]!.body;
    const cs = body.indexOf(mk.context);
    const span = { start: cs, end: cs + mk.context.length };
    return issues.filter((i) => i.chapterId === p.chapterId && overlaps(i, span));
  };
  const detected = CONTRADICTIONS.map((c) => ({ ...c, issues: hit(c) }));
  const reasonable = REASONABLE.map((r) => ({ ...r, issues: hit(r) }));
  const marked = new Set([...detected, ...reasonable].flatMap((x) => x.issues.map((i) => i.id)));
  const others = issues.filter((i) => !marked.has(i.id));

  const typoOff = await typoRun(app.call, app.profileId, false);
  const typoOn = await typoRun(app.call, app.profileId, true);

  const report = {
    date: new Date().toISOString(),
    model: m.model,
    baseUrl: m.baseUrl,
    jsonMode: app.jsonMode,
    seconds: Math.round((Date.now() - started) / 1000),
    tokens: jobs.map((j) => ({ prompt: j.promptTokens, completion: j.completionTokens })),
    contradictions: CONTRADICTIONS.length,
    detected: detected.filter((d) => d.issues.length > 0).length,
    missed: detected.filter((d) => d.issues.length === 0).map((d) => `${d.id} ${d.note}`),
    reasonableChanges: REASONABLE.length,
    reasonableFlagged: reasonable.filter((r) => r.issues.length > 0).length,
    reasonableFlaggedDetails: reasonable.flatMap((r) => r.issues.map((i) => `${r.id} ${i.category}「${i.target}」：${i.message}`)),
    otherIssues: others.length,
    otherIssueDetails: others.map((i) => `${i.category}「${i.target}」：${i.message}（${i.evidence}）`),
    typoWhitelist: { off: typoOff, on: typoOn },
  };
  writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    `\n模型 ${m.model}（${app.jsonMode}）：检出矛盾 ${report.detected}/${report.contradictions}，合理变化被误报 ${report.reasonableFlagged}/${report.reasonableChanges}，其他问题 ${report.otherIssues} 条，用时 ${report.seconds} s`,
  );
  if (report.missed.length > 0) console.log(`漏报：${report.missed.join('；')}`);
  if (report.reasonableFlaggedDetails.length > 0) console.log(`误报合理变化：\n  ${report.reasonableFlaggedDetails.join('\n  ')}`);
  console.log(`错别字检查的专名误报：关闭白名单 ${typoOff.properNoun} 条（共 ${typoOff.total} 条问题），开启白名单 ${typoOn.properNoun} 条（共 ${typoOn.total} 条问题）`);
  console.log(`\n结果已写入 ${outFile}`);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  exitCode = 1;
} finally {
  await app.close();
}
process.exit(exitCode);
