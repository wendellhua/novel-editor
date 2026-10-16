import { createServer } from 'node:http';
import { LIMITS } from '../shared/constants';
import type { AppConfig } from '../shared/types';
import type { AssetReader } from './assets';
import { createAuth, type Auth } from './http/auth';
import { registerSystemRoutes } from './http/routes/system';
import { registerWorkRoutes } from './http/routes/works';
import { Router } from './http/router';
import { createRequestHandler } from './http/server';
import { createEventHub, type EventHub } from './http/sse';
import { registerLlmRoutes } from './http/routes/llm';
import { registerBibleRoutes } from './http/routes/bible';
import { registerIssueRoutes } from './http/routes/issues';
import { registerJobRoutes } from './http/routes/jobs';
import { registerSkillRoutes } from './http/routes/skills';
import { registerMemoryRoutes } from './http/routes/memory';
import { PlotMemoryService } from './memory';
import { Bible } from './bible';
import { Checks } from './checks';
import { IssueFixer } from './checks/fix';
import { Issues } from './checks/issues';
import { Llm, type LlmOptions } from './llm';
import { Manuscript } from './manuscript';
import { Skills } from './skills';
import { HubClient, type HubClientOptions } from './skills/hub-client';
import { validateStaticData } from './static-data';
import { DailyBackupScheduler } from './storage/daily-backup';
import { WorkDbPool } from './storage/db-pool';
import { FtsIndexer } from './storage/fts';
import { loadLlmConfig, saveLlmConfig } from './system/config';
import type { Logger } from './system/logger';
import type { DataPaths } from './system/paths';
import { LOOPBACK, listenWithFallback } from './system/port';

export interface StartAppOptions {
  paths: DataPaths;
  config: AppConfig;
  log: Logger;
  assets: AssetReader;
  onShutdownRequested: () => void;
  heartbeatMs?: number;
  ftsDelayMs?: number;
  /** 测试用：替换 fetch、缩短重试间隔。 */
  llm?: Pick<LlmOptions, 'fetch' | 'retryDelaysMs' | 'sleep' | 'statusThrottleMs' | 'probe'>;
  /** 测试用：指向本地 mock 的 SkillHub。 */
  hub?: Pick<HubClientOptions, 'baseUrl' | 'fetch'>;
  /** 内置技能的资源读取器，默认与前端资源共用 assets（打包后都在 appRoot / SEA 中）。 */
  builtinAssets?: AssetReader;
  /** job.updated 进度推送的最小间隔（默认 250 ms）。 */
  progressThrottleMs?: number;
  /** 正文保存后多久检查剧情记忆是否需要更新（默认 3 s）。 */
  memoryDebounceMs?: number;
}

export interface AppServices {
  pool: WorkDbPool;
  manuscript: Manuscript;
  skills: Skills;
  backups: DailyBackupScheduler;
  fts: FtsIndexer;
  llm: Llm;
  checks: Checks;
  issues: Issues;
  fixer: IssueFixer;
  bible: Bible;
  memory: PlotMemoryService;
}

export interface RunningApp {
  port: number;
  origin: string;
  auth: Auth;
  events: EventHub;
  router: Router;
  services: AppServices;
  /** 浏览器入口：带一次性 nonce 的 /auth 地址（F1 第 7 步）。 */
  launchUrl(): string;
  close(): Promise<void>;
}

/** 组合根：装配存储、业务服务、鉴权、事件中心、路由与请求管线，并按端口规则监听（F1 第 4 步）。 */
export async function startApp(options: StartAppOptions): Promise<RunningApp> {
  const { paths, config, log, assets, onShutdownRequested } = options;
  // 加载期校验（§6.5）：一次性列出全部问题；失败时尚未打开或写入任何数据文件
  validateStaticData(options.builtinAssets ?? assets);

  const backups = new DailyBackupScheduler({ backupsRoot: paths.backups, keep: LIMITS.dailyBackupKeep, log });
  const pool = new WorkDbPool({ dir: paths.works, appVersion: __APP_VERSION__, log, onOpen: backups.onOpen });
  const fts = new FtsIndexer({ pool, log, delayMs: options.ftsDelayMs });
  const auth = createAuth(config.authSecret);
  const events = createEventHub(options.heartbeatMs);
  // 剧情记忆在下面创建（依赖 checks）；正文变化时由它防抖检查是否需要更新
  let memory: PlotMemoryService | null = null;
  const manuscript = new Manuscript({
    pool,
    trashDir: paths.trash,
    appVersion: __APP_VERSION__,
    log,
    onChapterUpdated: (workId, chapterId, rev) => {
      fts.schedule(workId);
      memory?.schedule(workId);
      events.publish({ type: 'chapter.updated', workId, chapterId, rev });
    },
  });

  // llm.json 在确认单实例之后才加载（F1 第 2 步），避免两个进程同时修复并写回同一文件
  const llm = new Llm({
    ...options.llm,
    config: loadLlmConfig(paths, log),
    save: (c) => saveLlmConfig(paths, c),
    log,
    userAgent: `NovelEditor/${__APP_VERSION__}`,
    // 模型运行状态推送给所有页面（设置页、AI 检查面板）；已删除的配置不再推送
    onStatus: (profileId, status) => {
      if (llm.profiles.find(profileId) !== null) events.publish({ type: 'llm.status', profileId, status });
    },
  });

  // 内置技能在这里加载并按 §6.5 校验，不合法时启动失败
  const skills = new Skills({
    dir: paths.skills,
    assets: options.builtinAssets ?? assets,
    log,
    hub: new HubClient({
      ...options.hub,
      clientId: config.hubClientId,
      userAgent: `NovelEditor/${__APP_VERSION__}`,
      maxZipBytes: LIMITS.skillZipMaxBytes,
    }),
  });

  const checks = new Checks({ pool, llm, skills, log, manuscript, publish: (e) => events.publish(e), progressThrottleMs: options.progressThrottleMs });
  memory = new PlotMemoryService({ pool, checks, llm, log, publish: (e) => events.publish(e), debounceMs: options.memoryDebounceMs });
  const issues = new Issues({ pool, manuscript, log });
  const fixer = new IssueFixer({ pool, llm, log });
  const bible = new Bible({ pool, log, publish: (e) => events.publish(e) });

  const router = new Router();
  registerSystemRoutes(router, { auth, events, paths, requestShutdown: onShutdownRequested });
  // 删除作品前先停下它的任务：运行中的任务持有连接（pin），不释放就无法把文件移入回收站
  registerWorkRoutes(router, manuscript, { beforeDeleteWork: (workId) => checks.releaseWork(workId) });
  registerLlmRoutes(router, llm);
  registerSkillRoutes(router, skills);
  registerJobRoutes(router, checks);
  registerIssueRoutes(router, issues, fixer);
  registerBibleRoutes(router, bible);
  registerMemoryRoutes(router, memory);

  let port = 0;
  const server = createServer(
    { keepAliveTimeout: 5000 },
    createRequestHandler({ router, auth, assets, log, getPort: () => port }),
  );
  const listened = await listenWithFallback(server, config.port);
  port = listened.port;
  if (listened.fellBack) log.warn(`端口 ${config.port} 不可用，改用 ${port}`);
  const origin = `http://${LOOPBACK}:${port}`;

  return {
    port,
    origin,
    auth,
    events,
    router,
    services: { pool, manuscript, skills, backups, fts, llm, checks, issues, fixer, bible, memory },
    launchUrl: () => `${origin}/auth?n=${auth.issueNonce()}`,
    close: async () => {
      memory?.close();
      events.closeAll();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      // 运行中的任务暂停（中止模型请求、已完成单元已提交），排队中的转为 paused，并释放作品库连接
      await checks.shutdown();
      await backups.whenIdle();
      fts.flushAll();
      pool.closeAll();
    },
  };
}
