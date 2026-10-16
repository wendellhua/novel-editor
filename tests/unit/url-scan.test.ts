import { describe, expect, it } from 'vitest';
import { findExternalUrls } from '../../scripts/lib/url-scan.ts';

describe('findExternalUrls（§6.5 前端产物不得引用外部资源）', () => {
  it('放行 SVG 命名空间', () => {
    expect(findExternalUrls('<svg xmlns="http://www.w3.org/2000/svg"></svg>')).toEqual([]);
  });

  it.each([
    ['<script src="https://cdn.example.com/a.js"></script>', 'https://cdn.example.com/a.js'],
    ['@import url(https://fonts.googleapis.com/css?family=x);', 'https://fonts.googleapis.com/css?family=x'],
    ['fetch("http://api.example.com/v1")', 'http://api.example.com/v1'],
  ])('拦截 %s', (text, url) => {
    expect(findExternalUrls(text)).toEqual([url]);
  });

  it('同一 URL 只报告一次', () => {
    expect(findExternalUrls('"https://x.io/a" "https://x.io/a"')).toEqual(['https://x.io/a']);
  });
});
