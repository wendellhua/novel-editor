import type { LlmPreset } from '../../shared/types';

/**
 * 内置服务预设（ADR-007）：只预填名称和 baseUrl，模型名由作者填写，modelHint 只做占位提示。
 * 厂商调整地址时随版本更新；加载时由 validatePresets() 校验（§6.5）。
 */
export const LLM_PRESETS: readonly LlmPreset[] = [
  { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', modelHint: 'deepseek-chat' },
  { name: '阿里云百炼（通义千问）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', modelHint: 'qwen-plus' },
  { name: 'Kimi（月之暗面）', baseUrl: 'https://api.moonshot.cn/v1', modelHint: 'moonshot-v1-32k' },
  { name: '智谱 AI', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', modelHint: 'glm-4-flash' },
  { name: '腾讯混元', baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1', modelHint: 'hunyuan-turbos-latest' },
  { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', modelHint: 'gpt-4o-mini' },
  { name: 'Ollama（本机）', baseUrl: 'http://127.0.0.1:11434/v1', modelHint: 'qwen2.5:7b' },
  { name: 'LM Studio（本机）', baseUrl: 'http://127.0.0.1:1234/v1', modelHint: '已在 LM Studio 中加载的模型名' },
];

const LOCAL_HTTP_RE = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?(\/|$)/;

/** §6.5：baseUrl 以 https:// 开头，或是本机 http；name 唯一且非空；modelHint 非空。返回问题列表。 */
export function findPresetProblems(presets: readonly LlmPreset[]): string[] {
  const problems: string[] = [];
  const names = new Set<string>();
  presets.forEach((p, i) => {
    const where = `LLM_PRESETS[${i}]（${p.name}）`;
    if (p.name.trim() === '') problems.push(`${where} name 为空`);
    if (names.has(p.name)) problems.push(`${where} name 重复`);
    names.add(p.name);
    if (!p.baseUrl.startsWith('https://') && !LOCAL_HTTP_RE.test(p.baseUrl)) {
      problems.push(`${where} baseUrl 必须是 https:// 或本机 http 地址：${p.baseUrl}`);
    }
    if (p.baseUrl.endsWith('/')) problems.push(`${where} baseUrl 不能以 / 结尾`);
    if (p.modelHint.trim() === '') problems.push(`${where} modelHint 为空`);
  });
  return problems;
}

export function validatePresets(presets: readonly LlmPreset[] = LLM_PRESETS): void {
  const problems = findPresetProblems(presets);
  if (problems.length > 0) throw new Error(`内置模型预设不合法：\n${problems.join('\n')}`);
}
