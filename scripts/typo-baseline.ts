import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CACHE, DIST } from './lib/project.ts';
import { rawRequest } from './lib/smoke-runner.ts';
import { KNOWN_ERRORS, TYPO_SAMPLE, correctedSample, knownErrorRanges } from './lib/typo-sample.ts';

/**
 * 错别字检查的真实模型基线（T14 验证）：用构建产物启动服务，对埋了 20 处已知错误的样章跑一次错别字检查，
 * 统计召回数与误报数，再执行「采纳全部」核对修正结果。需要真实的模型服务（会产生少量费用）：
 *
 *   NE_LLM_BASE_URL=https://api.deepseek.com NE_LLM_API_KEY=sk-... NE_LLM_MODEL=deepseek-chat npm run baseline:typo
 *
 * Key 只通过环境变量传给本机服务，不写入仓库；结果写到 .cache/typo-baseline.json。
 */
const env = (name: string): string => {
  const v = process.env[name]?.trim() ?? '';
  if (v === '') {
    console.error(`缺少环境变量 ${name}。用法：NE_LLM_BASE_URL=… NE_LLM_API_KEY=… NE_LLM_MODEL=… npm run baseline:typo`);
    process.exit(2);
  }
  return v;
};
const baseUrl = env('NE_LLM_BASE_URL');
const model = env('NE_LLM_MODEL');
const apiKey = process.env.NE_LLM_API_KEY?.trim() ?? '';
/** 测试用：指定服务端产物与结果文件位置。 */
const serverCjs = process.env.NE_SERVER_CJS ?? join(DIST, 'server.cjs');
const reportFile = process.env.NE_BASELINE_OUT ?? join(CACHE, 'typo-baseline.json');

const readJson = (file: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const dataDir = mkdtempSync(join(tmpdir(), 'ne-baseline-'));
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', serverCjs, '--data-dir', dataDir, '--no-browser'], { windowsHide: true });
let output = '';
child.stdout.on('data', (c: Buffer) => (output += c.toString('utf8')));
child.stderr.on('data', (c: Buffer) => (output += c.toString('utf8')));

let exitCode = 0;
try {
  const t0 = Date.now();
  while (readJson(join(dataDir, 'instance.json'))?.pid !== child.pid) {
    if (Date.now() - t0 > 15_000 || child.exitCode !== null) throw new Error(`服务未能启动（请先 npm run build）：\n${output}`);
    await sleep(50);
  }
  const port = readJson(join(dataDir, 'instance.json'))?.port as number;
  const secret = readJson(join(dataDir, 'config.json'))?.authSecret as string;
  const nonce = (JSON.parse((await rawRequest(port, { method: 'POST', path: '/api/system/nonce', headers: { 'X-Auth-Secret': secret } })).body) as { nonce: string }).nonce;
  const cookie = (await rawRequest(port, { path: `/auth?n=${nonce}` })).headers['set-cookie']?.[0]?.split(';')[0] ?? '';
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await rawRequest(port, {
      method,
      path,
      timeoutMs: 600_000,
      headers: { Cookie: cookie, Origin: `http://127.0.0.1:${port}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status >= 400) throw new Error(`${method} ${path} → ${res.status} ${res.body.slice(0, 500)}`);
    return (res.body === '' ? undefined : JSON.parse(res.body)) as T;
  };

  const profile = await call<{ id: string }>('POST', '/api/llm/profiles', { name: '基线', baseUrl, apiKey, model });
  const probe = await call<{ ok: boolean; jsonMode: string; latencyMs: number; error: string | null }>('POST', `/api/llm/profiles/${profile.id}/test`);
  if (!probe.ok) throw new Error(`测试连接失败：${probe.error ?? ''}`);
  console.log(`测试连接：${probe.jsonMode}，${probe.latencyMs} ms`);

  const work = await call<{ id: string }>('POST', '/api/works', { title: '错别字基线' });
  const W = `/api/works/${work.id}`;
  const tree = await call<{ volumes: { chapters: { id: string }[] }[] }>('GET', `${W}/tree`);
  const chapterId = tree.volumes[0]!.chapters[0]!.id;
  await call('PUT', `${W}/chapters/${chapterId}/body`, { body: TYPO_SAMPLE, baseRev: 0 });

  const started = Date.now();
  let job = await call<{ id: string; status: string; error: string | null; promptTokens: number; completionTokens: number }>('POST', `${W}/jobs`, {
    type: 'typo',
    scope: { kind: 'chapter', id: chapterId },
    profileId: profile.id,
  });
  while (job.status === 'queued' || job.status === 'running') {
    await sleep(500);
    job = await call('GET', `${W}/jobs/${job.id}`);
  }
  if (job.status !== 'done') throw new Error(`任务未完成：${job.status} ${job.error ?? ''}`);

  const issues = await call<{ id: string; target: string; replacement: string | null; category: string; start: number; end: number; message: string }[]>('GET', `${W}/issues?jobId=${job.id}`);
  const ranges = knownErrorRanges();
  const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }): boolean => a.start < b.end && b.start < a.end;
  const found = ranges.map((r) => ({ ...r, hits: issues.filter((i) => overlaps(i, r)) }));
  const falsePositives = issues.filter((i) => !ranges.some((r) => overlaps(i, r)));

  await call('POST', `${W}/issues/apply`, { issueIds: issues.filter((i) => i.replacement !== null).map((i) => i.id) });
  const fixed = (await call<{ body: string }>('GET', `${W}/chapters/${chapterId}`)).body;
  const corrected = KNOWN_ERRORS.filter((e) => fixed.includes(e.context.replace(e.wrong, e.right)));

  const recall = found.filter((f) => f.hits.length > 0).length;
  const report = {
    date: new Date().toISOString(),
    model,
    baseUrl,
    jsonMode: probe.jsonMode,
    seconds: Math.round((Date.now() - started) / 1000),
    tokens: { prompt: job.promptTokens, completion: job.completionTokens },
    known: KNOWN_ERRORS.length,
    recall,
    falsePositives: falsePositives.length,
    correctedAfterApplyAll: corrected.length,
    fullyCorrect: fixed === correctedSample(),
    missed: found.filter((f) => f.hits.length === 0).map((f) => `${f.error.context}（${f.error.wrong}→${f.error.right}）`),
    falsePositiveDetails: falsePositives.map((i) => `${i.target}→${i.replacement ?? ''}：${i.message}`),
  };
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\n模型 ${model}（${probe.jsonMode}）：召回 ${recall}/${KNOWN_ERRORS.length}，误报 ${falsePositives.length}，采纳全部后改对 ${corrected.length}/${KNOWN_ERRORS.length}，用时 ${report.seconds} s，用量 ${job.promptTokens} + ${job.completionTokens} token`);
  if (report.missed.length > 0) console.log(`漏报：${report.missed.join('、')}`);
  if (report.falsePositiveDetails.length > 0) console.log(`误报：\n  ${report.falsePositiveDetails.join('\n  ')}`);
  console.log(`\n结果已写入 ${reportFile}`);
  await call('POST', '/api/system/shutdown');
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  exitCode = 1;
} finally {
  if (child.exitCode === null) child.kill();
  await sleep(300);
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
process.exit(exitCode);
