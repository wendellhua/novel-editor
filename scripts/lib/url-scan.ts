import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listFilesRecursive } from './fs-utils.ts';

/**
 * 白名单：只放行「不会被加载的标识字符串」，例如 XML 命名空间。
 * 任何新增条目都必须说明为什么它不是外部资源引用（§6.5 前端构建产物约束）。
 */
export const ALLOWED_URL_PREFIXES: readonly string[] = [
  'http://www.w3.org/', // SVG / XLink / MathML 命名空间标识
  'https://vuejs.org/error-reference/', // Vue 生产版错误码说明链接，只拼进 console 报错文本，从不被请求
  'https://www.naiveui.com/', // Naive UI 在组件误用时打印的 console 警告里附带的文档链接，从不被请求
];

const URL_RE = /https?:\/\/[^\s"'`<>()\\,]+/g;
const TEXT_EXT = /\.(html|js|mjs|cjs|css|svg|json|txt|map)$/i;

export interface UrlFinding {
  file: string;
  url: string;
}

export function findExternalUrls(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(URL_RE)) {
    const url = match[0];
    if (!ALLOWED_URL_PREFIXES.some((prefix) => url.startsWith(prefix))) found.add(url);
  }
  return [...found];
}

export function scanDirForExternalUrls(dir: string): UrlFinding[] {
  const findings: UrlFinding[] = [];
  for (const rel of listFilesRecursive(dir)) {
    if (!TEXT_EXT.test(rel)) continue;
    for (const url of findExternalUrls(readFileSync(join(dir, rel), 'utf8'))) findings.push({ file: rel, url });
  }
  return findings;
}
