import { spawn } from 'node:child_process';
import type { Logger } from './logger';

const LOCAL_URL_RE = /^http:\/\/127\.0\.0\.1:\d{1,5}\/[A-Za-z0-9/?=&._-]*$/;

export function browserCommand(url: string, platform: NodeJS.Platform): { command: string; args: string[] } {
  if (platform === 'win32') return { command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url] };
  if (platform === 'darwin') return { command: 'open', args: [url] };
  return { command: 'xdg-open', args: [url] };
}

/** 用系统默认浏览器打开本机地址。只接受 127.0.0.1 的简单 URL，杜绝命令注入。 */
export function openBrowser(url: string, log: Logger, platform: NodeJS.Platform = process.platform): void {
  if (!LOCAL_URL_RE.test(url)) {
    log.error(`拒绝打开非本机地址：${url}`);
    return;
  }
  const { command, args } = browserCommand(url, platform);
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', (err) => log.warn('打开浏览器失败，请手动访问本机地址', err));
    child.unref();
  } catch (err) {
    log.warn('打开浏览器失败，请手动访问本机地址', err);
  }
}
