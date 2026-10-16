import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mockTypoContent, targetTextOf } from '../../scripts/lib/mock-typo.ts';
import { rawRequest } from '../../scripts/lib/smoke-runner.ts';
import { openDatabase } from '../../src/server/storage/sqlite';
import type { Chapter, Job, LlmProfile, WorkTree } from '../../src/shared/types';
import { TEST_BUILD_DIR } from '../global-setup';
import { completion, startMockLlm, type MockLlm, type MockRequest } from '../helpers/mock-llm';
import { makeTempDir } from '../helpers/tmp';

interface Server {
  child: ChildProcess;
  exited: Promise<number | null>;
  call<T>(method: string, path: string, body?: unknown, status?: number): Promise<T>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 启动构建产物 server.cjs 并登录（与真实双击启动同一条代码路径）。 */
async function startServer(dataDir: string): Promise<Server> {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(TEST_BUILD_DIR, 'server.cjs'), '--data-dir', dataDir, '--no-browser'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  child.stdout?.on('data', (c: Buffer) => (output += c.toString('utf8')));
  child.stderr?.on('data', (c: Buffer) => (output += c.toString('utf8')));
  const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
  const t0 = Date.now();
  while (readJson(join(dataDir, 'instance.json'))?.pid !== child.pid) {
    if (Date.now() - t0 > 15_000 || child.exitCode !== null) throw new Error(`服务未就绪：\n${output}`);
    await sleep(50);
  }
  const port = readJson(join(dataDir, 'instance.json'))?.port as number;
  const secret = readJson(join(dataDir, 'config.json'))?.authSecret as string;
  const nonce = (JSON.parse((await rawRequest(port, { method: 'POST', path: '/api/system/nonce', headers: { 'X-Auth-Secret': secret } })).body) as { nonce: string })
    .nonce;
  const cookie = (await rawRequest(port, { path: `/auth?n=${nonce}` })).headers['set-cookie']?.[0]?.split(';')[0] ?? '';
  return {
    child,
    exited,
    async call<T>(method: string, path: string, body?: unknown, status = 200): Promise<T> {
      const res = await rawRequest(port, {
        method,
        path,
        headers: { Cookie: cookie, Origin: `http://127.0.0.1:${port}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.status !== status) throw new Error(`${method} ${path} → ${res.status} ${res.body.slice(0, 300)}`);
      return (res.body === '' ? undefined : JSON.parse(res.body)) as T;
    },
  };
}

/** 强杀：Windows 上为 TerminateProcess，不会执行任何退出清理。 */
async function kill(s: Server): Promise<void> {
  s.child.kill('SIGKILL');
  await s.exited;
}

async function waitJob(s: Server, path: string, pred: (j: Job) => boolean): Promise<Job> {
  const t0 = Date.now();
  for (;;) {
    const job = await s.call<Job>('GET', path);
    if (pred(job)) return job;
    if (Date.now() - t0 > 20_000) throw new Error(`等待任务超时：${JSON.stringify(job)}`);
    await sleep(30);
  }
}

const markerOf = (req: MockRequest): string => /【C(\d+)】/.exec(targetTextOf(req.body.messages?.find((m) => m.role === 'user')?.content ?? ''))?.[1] ?? '?';

let tmp: ReturnType<typeof makeTempDir>;
let llm: MockLlm;
beforeAll(async () => {
  tmp = makeTempDir('ne-jobs-proc-');
  llm = await startMockLlm((req) => ({ ...completion(mockTypoContent(req.body)), delayMs: 150 }));
});
afterAll(async () => {
  await llm.close();
  tmp.cleanup();
});

describe('真实进程：任务在强杀与重启后的状态（T13 验证）', () => {
  it('暂停后强杀 → 重启仍为 paused；运行中强杀 → 重启变为 paused；恢复后完成且不重复执行已完成单元（INV-18）', async () => {
    let s = await startServer(tmp.dir);
    const profile = await s.call<LlmProfile>('POST', '/api/llm/profiles', { name: 'Mock', baseUrl: llm.baseUrl, model: 'm', maxConcurrency: 1 });
    const work = await s.call<{ id: string }>('POST', '/api/works', { title: '强杀测试' });
    const W = `/api/works/${work.id}`;
    const tree = await s.call<WorkTree>('GET', `${W}/tree`);
    const volumeId = tree.volumes[0]!.id;
    const ids = [tree.volumes[0]!.chapters[0]!.id];
    for (let i = 1; i < 8; i++) ids.push((await s.call<Chapter>('POST', `${W}/chapters`, { volumeId, title: `第${i + 1}章` })).id);
    for (const [i, id] of ids.entries()) await s.call('PUT', `${W}/chapters/${id}/body`, { body: `【C${i}】他在接再厉，终于练成第${i}式。`, baseRev: 0 });
    const req = { type: 'typo', scope: { kind: 'work', id: work.id }, profileId: profile.id };

    // ---------- 1. 跑到一半暂停 → 强杀 → 重启 → paused → 恢复 → 完成 ----------
    const job1 = await s.call<Job>('POST', `${W}/jobs`, req);
    const J1 = `${W}/jobs/${job1.id}`;
    await waitJob(s, J1, (j) => j.doneUnits >= 3);
    const paused = await s.call<Job>('POST', `${J1}/pause`);
    expect(paused.status).toBe('paused');
    const doneAtPause = llm.requests.slice(0, paused.doneUnits).map(markerOf);
    await kill(s);

    s = await startServer(tmp.dir);
    expect((await s.call<Job>('GET', J1)).status, '暂停的任务重启后仍为 paused').toBe('paused');
    const mark1 = llm.requests.length;
    await s.call('POST', `${J1}/resume`);
    const done1 = await waitJob(s, J1, (j) => j.status === 'done');
    expect(done1).toMatchObject({ totalUnits: 8, doneUnits: 8, failedUnits: 0 });
    const resumed1 = llm.requests.slice(mark1).map(markerOf);
    for (const m of doneAtPause) expect(resumed1, `暂停前已完成的 C${m} 不应重复执行`).not.toContain(m);
    expect(new Set([...doneAtPause, ...resumed1]).size).toBe(8);
    const db1 = openDatabase(join(tmp.dir, 'works', `${work.id}.novel`), { readOnly: true });
    try {
      const n = db1.prepare('SELECT count(*) AS n, count(DISTINCT chapter_id) AS c FROM issue WHERE job_id = ?').get(job1.id) as { n: number; c: number };
      expect([n.n, n.c], '任务 1 每章恰好一条问题').toEqual([8, 8]);
    } finally {
      db1.close();
    }
    // 删除任务 1（连同问题），否则任务 2 的结果会与之去重（§7.4.3 第 5 步），无法检验「强杀后不重复写入」
    await s.call('DELETE', J1, undefined, 204);

    // ---------- 2. 运行中强杀 → 重启 → paused（上一个进程遗留的 running）→ 恢复 → 完成 ----------
    const job2 = await s.call<Job>('POST', `${W}/jobs`, req);
    const J2 = `${W}/jobs/${job2.id}`;
    const mark2 = llm.requests.length;
    const running = await waitJob(s, J2, (j) => j.doneUnits >= 3 && j.status === 'running');
    await kill(s);
    const sentBeforeKill = llm.requests.slice(mark2).map(markerOf);

    s = await startServer(tmp.dir);
    const after = await s.call<Job>('GET', J2);
    expect(after.status, '运行中被杀的任务重启后为 paused').toBe('paused');
    expect(after.doneUnits).toBeGreaterThanOrEqual(running.doneUnits);
    const committed = sentBeforeKill.slice(0, after.doneUnits);
    const mark3 = llm.requests.length;
    await s.call('POST', `${J2}/resume`);
    const done2 = await waitJob(s, J2, (j) => j.status === 'done');
    expect(done2).toMatchObject({ totalUnits: 8, doneUnits: 8, failedUnits: 0 });
    const resumed2 = llm.requests.slice(mark3).map(markerOf);
    for (const m of committed) expect(resumed2, `强杀前已提交的 C${m} 不应重复执行`).not.toContain(m);
    expect(resumed2.length).toBe(8 - after.doneUnits);

    await s.call('POST', '/api/system/shutdown', undefined, 204);
    expect(await s.exited).toBe(0);

    // 每个任务每章恰好一条问题：被杀时未提交的单元重新执行，但不会写重复（结果与单元状态同事务提交）
    const db = openDatabase(join(tmp.dir, 'works', `${work.id}.novel`), { readOnly: true });
    try {
      const rows = db.prepare('SELECT job_id AS j, count(*) AS n, count(DISTINCT chapter_id) AS c FROM issue GROUP BY job_id').all() as { j: string; n: number; c: number }[];
      expect(rows.map((r) => [r.j, r.n, r.c])).toEqual([[job2.id, 8, 8]]);
      const units = db.prepare("SELECT count(*) AS n FROM job_unit WHERE status != 'done'").get() as { n: number };
      expect(units.n).toBe(0);
    } finally {
      db.close();
    }
  }, 90_000);
});
