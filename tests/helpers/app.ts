import { join } from 'node:path';
import { ROOT } from '../../scripts/lib/project.ts';
import { rawRequest, type RawResponse } from '../../scripts/lib/smoke-runner.ts';
import { startApp, type RunningApp } from '../../src/server/app';
import { createAssetReader } from '../../src/server/assets';
import { sanitizeAppConfig } from '../../src/server/system/config';
import { createSilentLogger } from '../../src/server/system/logger';
import { dataPaths, ensureDataDirs, type DataPaths } from '../../src/server/system/paths';
import { makeTempDir } from './tmp';

export interface TestApp {
  app: RunningApp;
  paths: DataPaths;
  cookie: string;
  /** 服务端写入的全部日志行（已脱敏），用于检查 INV-17。 */
  log: ReturnType<typeof createSilentLogger>;
  /** 带 Cookie 与同源 Origin 的 JSON 请求。 */
  call(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<RawResponse & { json: unknown }>;
  shutdownRequested: number;
  cleanup(): Promise<void>;
}

export interface TestAppOptions {
  ftsDelayMs?: number;
  hubBaseUrl?: string;
  /** 复用已有数据目录（模拟重启）；此时 cleanup 不删除目录。 */
  dataDir?: string;
  progressThrottleMs?: number;
  /** 剧情记忆的防抖（默认 10 分钟：测试里不会自动触发，需要时调用 services.memory.flushScheduled()）。 */
  memoryDebounceMs?: number;
}

/** 启动真实服务（随机端口、临时数据目录、测试前端资源）并完成登录。 */
export async function startTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const tmp = options.dataDir === undefined ? makeTempDir('ne-app-') : { dir: options.dataDir, cleanup: () => undefined };
  const paths = dataPaths(tmp.dir);
  ensureDataDirs(paths);
  const state = { shutdownRequested: 0 };
  const log = createSilentLogger();
  const app = await startApp({
    paths,
    config: { ...sanitizeAppConfig({}).value, port: 0 },
    log,
    assets: createAssetReader(join(ROOT, 'tests', 'fixtures')),
    onShutdownRequested: () => state.shutdownRequested++,
    heartbeatMs: 50,
    ftsDelayMs: options.ftsDelayMs ?? 20,
    llm: { retryDelaysMs: [5, 10, 20], statusThrottleMs: 10 },
    // 不连真实 SkillHub：默认指向一个必然连不上的本机端口
    hub: { baseUrl: options.hubBaseUrl ?? 'http://127.0.0.1:1' },
    builtinAssets: createAssetReader(ROOT),
    progressThrottleMs: options.progressThrottleMs ?? 10,
    memoryDebounceMs: options.memoryDebounceMs ?? 600_000,
  });
  const nonce = new URL(app.launchUrl()).searchParams.get('n') ?? '';
  const auth = await rawRequest(app.port, { path: `/auth?n=${nonce}` });
  const cookie = auth.headers['set-cookie']?.[0]?.split(';')[0] ?? '';

  const call: TestApp['call'] = async (method, path, body, headers = {}) => {
    const res = await rawRequest(app.port, {
      method,
      path,
      headers: {
        Cookie: cookie,
        Origin: `http://127.0.0.1:${app.port}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body),
    });
    let json: unknown;
    try {
      json = res.body === '' ? undefined : JSON.parse(res.body);
    } catch {
      json = undefined;
    }
    return { ...res, json };
  };

  return {
    app,
    paths,
    cookie,
    log,
    call,
    get shutdownRequested() {
      return state.shutdownRequested;
    },
    cleanup: async () => {
      await app.close();
      tmp.cleanup();
    },
  };
}
