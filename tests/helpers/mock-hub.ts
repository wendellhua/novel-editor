import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { makeZip, skillMd } from './zip';

export interface MockHub {
  baseUrl: string;
  requests: { path: string; headers: IncomingHttpHeaders }[];
  /** 下一次下载返回的 zip。 */
  zip: Buffer;
  /** 为 true 时下载返回 404。 */
  missing: boolean;
  close(): Promise<void>;
}

export const HUB_SKILL = { namespace: 'user_abc', slug: 'novel-style' } as const;

/** 本地 SkillHub：search / skills/{slug} / download（302 到 /files/*.zip，与真实服务一致）。 */
export async function startMockHub(): Promise<MockHub> {
  const state: MockHub = {
    baseUrl: '',
    requests: [],
    zip: makeZip([
      { name: 'novel-style/SKILL.md', data: skillMd('novel-style', '按起点编辑标准审稿') },
      { name: 'novel-style/references/rules.md', data: '- 黄金三章\n' },
      { name: 'novel-style/scripts/run.py', data: 'print("never executed")' },
    ]),
    missing: false,
    close: () => new Promise((r) => server.close(() => r())),
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    state.requests.push({ path: `${url.pathname}${url.search}`, headers: req.headers });
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/api/v1/search') {
      send(200, {
        results: [
          {
            slug: HUB_SKILL.slug,
            displayName: '起点风格审稿',
            summary: '按起点编辑标准审稿',
            version: '1.2.0',
            namespace: { handle: HUB_SKILL.namespace },
          },
          { slug: 'no-namespace', displayName: '缺少 namespace 的条目会被忽略' },
          { slug: '../evil', namespace: { handle: 'x' } },
        ],
      });
    } else if (url.pathname === `/api/v1/skills/${HUB_SKILL.slug}`) {
      send(200, {
        skill: { displayName: '起点风格审稿', summary: '按起点编辑标准审稿', slug: HUB_SKILL.slug },
        namespace: { handle: HUB_SKILL.namespace },
        latestVersion: { version: '1.2.0' },
        securityReports: {
          keen: { status: 'benign', statusText: '安全，无风险', reportUrl: 'https://tix.qq.com/report/1' },
          sanbu: { status: 'benign', statusText: '安全，无风险', reportUrl: 'javascript:alert(1)' },
        },
      });
    } else if (url.pathname === '/api/v1/download') {
      if (state.missing) send(404, { error: 'not found' });
      else {
        res.writeHead(302, { Location: '/files/skill.zip' });
        res.end();
      }
    } else if (url.pathname === '/files/skill.zip') {
      res.writeHead(200, { 'Content-Type': 'application/zip' });
      res.end(state.zip);
    } else {
      send(404, { error: 'no route' });
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  state.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return state;
}
