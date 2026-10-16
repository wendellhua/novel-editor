import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export const LOOPBACK = '127.0.0.1';

function tryListen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, LOOPBACK);
  });
}

export interface ListenResult {
  port: number;
  fellBack: boolean;
}

/**
 * INV-15：优先使用配置端口；仅当被占用（EADDRINUSE）或被系统保留（Windows 动态排除端口段返回 EACCES）时
 * 才改用随机端口。调用方负责把新端口写回配置。
 */
export async function listenWithFallback(server: Server, preferredPort: number): Promise<ListenResult> {
  let fellBack = false;
  try {
    await tryListen(server, preferredPort);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EADDRINUSE' && code !== 'EACCES') throw err;
    await tryListen(server, 0);
    fellBack = true;
  }
  const address = server.address() as AddressInfo | null;
  if (address === null) throw new Error('监听成功但无法获取端口');
  return { port: address.port, fellBack };
}
