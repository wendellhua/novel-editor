import { homedir } from 'node:os';
import { startApp, type RunningApp } from './app';
import { createAssetReader } from './assets';
import { StaticDataError } from './static-data';
import { parseArgs } from './system/args';
import { openBrowser } from './system/browser';
import { loadAppConfig, saveAppConfig } from './system/config';
import { readInstance, removeInstance, requestNonceFromInstance, writeInstance } from './system/instance';
import { createLogger, type Logger } from './system/logger';
import { dataPaths, ensureDataDirs, resolveDataDir, type DataPaths } from './system/paths';

function launch(url: string, noBrowser: boolean, log: Logger): void {
  if (noBrowser) {
    process.stdout.write(`请在浏览器中打开：${url}\n`);
    return;
  }
  openBrowser(url, log);
}

function installCrashHandlers(log: Logger, paths: DataPaths): void {
  process.on('uncaughtException', (err) => {
    log.error('未捕获的异常，程序退出', err);
    removeInstance(paths.instance, process.pid);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    log.error('未处理的 Promise 拒绝', reason);
  });
}

/** 启动流程 F1（§3.3）。 */
async function main(): Promise<void> {
  const startedAt = Date.now();
  const args = parseArgs(process.argv.slice(1), process.env);
  const paths = dataPaths(
    resolveDataDir({ override: args.dataDir, platform: process.platform, env: process.env, homedir: homedir(), cwd: process.cwd() }),
  );
  ensureDataDirs(paths);
  const log = createLogger({ dir: paths.logs, console: true });
  installCrashHandlers(log, paths);
  log.info(`NovelEditor ${__APP_VERSION__} 启动（Node ${process.version}，数据目录 ${paths.root}）`);

  const config = loadAppConfig(paths, log);
  log.registerSecret(config.authSecret);

  const existing = readInstance(paths.instance);
  if (existing !== null) {
    const nonce = await requestNonceFromInstance(existing.port, config.authSecret);
    if (nonce !== null) {
      launch(`http://127.0.0.1:${existing.port}/auth?n=${nonce}`, args.noBrowser, log);
      log.info(`已有实例在运行（pid ${existing.pid}，端口 ${existing.port}），已重新打开浏览器`);
      return;
    }
    log.warn(`发现残留的 instance.json（pid ${existing.pid}），上次可能异常退出，已忽略`);
  }

  let stopping = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    log.info(`正在退出（${reason}）`);
    try {
      await app.close();
    } catch (err) {
      log.error('关闭服务时出错', err);
    }
    removeInstance(paths.instance, process.pid);
    log.info('已退出');
    process.exit(0);
  };

  const assets = createAssetReader(__dirname);
  log.info(`前端资源来源：${assets.mode === 'sea' ? '内嵌资源（SEA）' : __dirname}`);
  let app: RunningApp;
  try {
    app = await startApp({ paths, config, log, assets, onShutdownRequested: () => void shutdown('用户请求') });
  } catch (err) {
    // 双击运行时控制台窗口会随进程关闭，失败原因必须写进日志文件；静态数据问题本身已逐项列出，不再附堆栈
    if (err instanceof StaticDataError) log.error(err.message);
    else log.error('启动失败', err);
    process.exit(1);
  }
  if (app.port !== config.port) {
    config.port = app.port;
    saveAppConfig(paths, config);
  }
  writeInstance(paths.instance, { pid: process.pid, port: app.port, startedAt: Date.now() });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => void shutdown(signal));
  }

  log.info(`启动完成，用时 ${Date.now() - startedAt} ms，监听 ${app.origin}/`);
  launch(app.launchUrl(), args.noBrowser, log);
}

main().catch((err: unknown) => {
  process.stderr.write(`NovelEditor 启动失败：${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
