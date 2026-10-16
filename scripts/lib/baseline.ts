import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DIST } from './project.ts';
import { rawRequest } from './smoke-runner.ts';

/**
 * 真实模型基线脚本（npm run baseline:*）共用：读取模型环境变量，用构建产物在临时数据目录启动服务并登录，
 * 创建模型配置并测试连接。Key 只通过环境变量传给本机服务，不写入仓库。
 */
export interface BaselineModel {
  baseUrl: string;
  model: string;
  apiKey: string;
}

export function modelFromEnv(script: string): BaselineModel {
  const need = (name: string): string => {
    const v = process.env[name]?.trim() ?? '';
    if (v === '') {
      console.error(`缺少环境变量 ${name}。用法：NE_LLM_BASE_URL=… NE_LLM_API_KEY=… NE_LLM_MODEL=… npm run ${script}`);
      process.exit(2);
    }
    return v;
  };
  return { baseUrl: need('NE_LLM_BASE_URL'), model: need('NE_LLM_MODEL'), apiKey: process.env.NE_LLM_API_KEY?.trim() ?? '' };
}

export type Call = <T>(method: string, path: string, body?: unknown) => Promise<T>;

export interface BaselineApp {
  call: Call;
  profileId: string;
  jsonMode: string;
  /** 关闭服务并删除临时数据目录。 */
  close(): Promise<void>;
}

const readJson = (file: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
};
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function startBaselineApp(m: BaselineModel, serverCjs: string = process.env.NE_SERVER_CJS ?? join(DIST, 'server.cjs')): Promise<BaselineApp> {
  const dataDir = mkdtempSync(join(tmpdir(), 'ne-baseline-'));
  const child: ChildProcess = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', serverCjs, '--data-dir', dataDir, '--no-browser'], { windowsHide: true });
  let output = '';
  child.stdout?.on('data', (c: Buffer) => (output += c.toString('utf8')));
  child.stderr?.on('data', (c: Buffer) => (output += c.toString('utf8')));
  const close = async (): Promise<void> => {
    if (child.exitCode === null) child.kill();
    await sleep(300);
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  };
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
    const call: Call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
      const res = await rawRequest(port, {
        method,
        path,
        timeoutMs: 600_000,
        headers: { Cookie: cookie, Origin: `http://127.0.0.1:${port}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.status >= 400) throw Object.assign(new Error(`${method} ${path} → ${res.status} ${res.body.slice(0, 500)}`), { status: res.status, body: res.body });
      return (res.body === '' ? undefined : JSON.parse(res.body)) as T;
    };
    const profile = await call<{ id: string }>('POST', '/api/llm/profiles', { name: '基线', baseUrl: m.baseUrl, apiKey: m.apiKey, model: m.model });
    const probe = await call<{ ok: boolean; jsonMode: string; latencyMs: number; error: string | null }>('POST', `/api/llm/profiles/${profile.id}/test`);
    if (!probe.ok) throw new Error(`测试连接失败：${probe.error ?? ''}`);
    console.log(`测试连接：${probe.jsonMode}，${probe.latencyMs} ms`);
    return {
      call,
      profileId: profile.id,
      jsonMode: probe.jsonMode,
      close: async () => {
        await call('POST', '/api/system/shutdown').catch(() => undefined);
        await close();
      },
    };
  } catch (err) {
    await close();
    throw err;
  }
}

/** 新建作品并按顺序写入各章正文（第一章用默认章节）。返回作品路径前缀与章节 id。 */
export async function createBook(call: Call, title: string, chapters: readonly { title: string; body: string }[]): Promise<{ W: string; workId: string; ids: string[] }> {
  const work = await call<{ id: string }>('POST', '/api/works', { title });
  const W = `/api/works/${work.id}`;
  const tree = await call<{ volumes: { id: string; chapters: { id: string }[] }[] }>('GET', `${W}/tree`);
  const volumeId = tree.volumes[0]!.id;
  const ids = [tree.volumes[0]!.chapters[0]!.id];
  for (let i = 1; i < chapters.length; i++) ids.push((await call<{ id: string }>('POST', `${W}/chapters`, { volumeId, title: chapters[i]!.title })).id);
  await call('PATCH', `${W}/chapters/${ids[0]}`, { title: chapters[0]!.title });
  for (const [i, id] of ids.entries()) await call('PUT', `${W}/chapters/${id}/body`, { body: chapters[i]!.body, baseRev: 0 });
  return { W, workId: work.id, ids };
}

/** 创建任务并轮询到结束；没有完成时抛错。 */
export async function runJob(call: Call, W: string, body: object): Promise<{ id: string; status: string; promptTokens: number; completionTokens: number; failedUnits: number }> {
  let job = await call<{ id: string; status: string; error: string | null; promptTokens: number; completionTokens: number; failedUnits: number }>('POST', `${W}/jobs`, body);
  while (job.status === 'queued' || job.status === 'running') {
    await sleep(500);
    job = await call('GET', `${W}/jobs/${job.id}`);
  }
  if (job.status !== 'done') throw new Error(`任务未完成：${job.status} ${job.error ?? ''}`);
  return job;
}
