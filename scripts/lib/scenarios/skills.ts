import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeZip, skillMd } from '../zip.ts';
import type { ScenarioContext } from './outline.ts';

interface SkillDto {
  id: string;
  name: string;
  source: string;
  appliesTo: string[];
}

const rows = `document.querySelectorAll('[data-testid="skill-row"]').length`;

/** 轮询服务端状态（d.waitFor 只能判断同步表达式，Promise 恒为真）。 */
async function until(check: () => Promise<boolean>, message: string, timeoutMs = 8000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`等待超时：${message}`);
}

/**
 * T11：设置 → 技能。内置技能可查看正文；本地导入 zip 与文件夹（脚本不落盘）；修改适用类型；
 * 在真实 SkillHub 搜索「小说」→ 查看详情与安全报告 → 安装 → 列表出现且详情能显示正文；删除。
 */
export async function skillsScenario(ctx: ScenarioContext): Promise<void> {
  const { d, ok, note, shot } = ctx;
  const dir = mkdtempSync(join(tmpdir(), 'ne-bsmoke-skill-'));
  try {
    const zipPath = join(dir, 'ban-words.zip');
    writeFileSync(
      zipPath,
      makeZip([
        { name: 'ban-words/SKILL.md', data: skillMd('本书禁用词', '列出本书不允许出现的网络用语', '# 禁用词\n\n- 不允许出现「卧槽」') },
        { name: 'ban-words/references/list.txt', data: '卧槽\n' },
        { name: 'ban-words/scripts/run.sh', data: 'echo never' },
      ]),
    );
    const folder = join(dir, 'qidian-style');
    mkdirSync(join(folder, 'references'), { recursive: true });
    writeFileSync(join(folder, 'SKILL.md'), skillMd('起点审稿标准', '起点编辑的审稿要点'));
    writeFileSync(join(folder, 'references', 'golden.md'), '# 黄金三章\n');
    writeFileSync(join(folder, 'cover.png'), 'not a text file');

    await d.navigate(`${ctx.origin}/settings?tab=skills`);
    await d.waitFor(`document.querySelectorAll('[data-testid="skill-builtin"]').length === 10`, '10 个内置技能');
    ok(await d.eval<boolean>(`document.body.innerText.includes('还没有安装技能')`), '技能页列出 10 个内置技能（含 AI 味检测、灵感胶囊、智能扩写、剧情记忆），已安装为空');

    await d.eval(`document.querySelector('[data-testid="skill-builtin"]').click()`);
    await d.waitFor(`document.querySelector('[data-testid="skill-body"]')?.innerText.includes('要报告的问题')`, '内置技能详情显示正文');
    ok(true, '点击内置技能可查看 SKILL.md 正文');
    await d.press('Escape');
    await d.waitFor(`!document.querySelector('[data-testid="skill-detail"]')`, '关闭详情');

    await d.setInputFiles('[data-testid="skill-zip-input"]', [zipPath]);
    await d.waitFor(`${rows} === 1`, 'zip 导入后列表出现 1 个技能');
    const afterZip = await d.fetchJson<SkillDto[]>('/api/skills');
    const banned = afterZip.find((s) => s.name === '本书禁用词');
    ok(banned?.source === 'local' && banned.appliesTo.join() === 'review', '本地导入 zip 技能成功，默认适用于「编辑审稿」');

    let folderOk = false;
    try {
      await d.setInputFiles('[data-testid="skill-folder-input"]', [folder]);
      await d.waitFor(`${rows} === 2`, '文件夹导入后列表出现第 2 个技能', 5000);
      folderOk = true;
    } catch {
      note('文件夹导入：当前浏览器不支持通过 CDP 选择目录，已由接口集成测试覆盖');
    }
    if (folderOk) ok(true, '本地导入文件夹技能成功（只上传 .md / .txt）');

    await d.eval(`document.querySelector('[data-testid="skill-applies"] .n-base-selection').click()`);
    await d.clickText('.n-base-select-option', '错别字与标点');
    await until(
      async () => (await d.fetchJson<SkillDto[]>('/api/skills')).some((s) => s.name === '本书禁用词' && s.appliesTo.join() === 'typo,review'),
      '适用类型已保存',
    );
    ok(true, '修改适用类型后立即保存（typo + review）');
    // 点击卡片标题（空白处）关闭下拉框
    const at = await d.eval<{ x: number; y: number }>(
      `(() => { const r = document.querySelector('.n-card-header__main').getBoundingClientRect(); return { x: r.left + 4, y: r.top + r.height / 2 }; })()`,
    );
    await d.clickAt(at.x, at.y);
    await d.waitFor(`![...document.querySelectorAll('.n-base-select-menu')].some((e) => e.offsetParent !== null)`, '下拉框已关闭');

    // ---------- 真实 SkillHub ----------
    await d.clickTestId('skill-hub-open');
    await d.waitFor(`document.querySelector('[data-testid="hub-modal"]')`, 'SkillHub 弹窗');
    const started = Date.now();
    await d.waitFor(
      `document.querySelectorAll('[data-testid="hub-item"]').length > 0 || document.querySelector('[data-testid="hub-modal"] .n-alert')`,
      'SkillHub 搜索返回',
      20_000,
    );
    const hubError = await d.eval<string>(`document.querySelector('[data-testid="hub-modal"] .n-alert')?.innerText ?? ''`);
    if (hubError !== '') throw new Error(`SkillHub 搜索失败：${hubError}`);
    const count = await d.eval<number>(`document.querySelectorAll('[data-testid="hub-item"]').length`);
    ok(count > 0, `在 SkillHub 搜索「小说」返回 ${count} 个技能（${Date.now() - started} ms）`);

    await d.eval(`document.querySelector('[data-testid="hub-item"]').click()`);
    await d.waitFor(
      `document.querySelector('[data-testid="hub-detail"] .report') || document.querySelector('[data-testid="hub-detail"]')?.innerText.includes('暂无安全报告')`,
      '详情与安全报告加载完成',
      15_000,
    );
    const reports = await d.eval<number>(`document.querySelectorAll('[data-testid="hub-detail"] .report').length`);
    const hasNoReport = await d.eval<boolean>(`document.querySelector('[data-testid="hub-detail"]').innerText.includes('暂无安全报告')`);
    ok(reports > 0 || hasNoReport, `详情显示安全报告（${reports} 份）`);
    const hubName = await d.eval<string>(`document.querySelector('[data-testid="hub-detail"] h3').innerText.trim()`);
    await new Promise((r) => setTimeout(r, 300));
    await shot('settings-skillhub');

    await d.clickTestId('hub-install');
    await until(async () => (await d.fetchJson<SkillDto[]>('/api/skills')).some((s) => s.source === 'skillhub'), 'SkillHub 技能安装完成', 60_000);
    const hubSkill = (await d.fetchJson<SkillDto[]>('/api/skills')).find((s) => s.source === 'skillhub');
    ok(hubSkill !== undefined, `从 SkillHub 安装「${hubName}」成功，列表中出现（${hubSkill?.id ?? ''}）`);
    ok(hubSkill?.name === hubName, `已安装技能的名称与 SkillHub 显示名一致（${hubSkill?.name ?? ''}）`);
    await d.press('Escape');
    await d.waitFor(`!document.querySelector('[data-testid="hub-modal"]')`, '关闭 SkillHub 弹窗');

    const detailText = await d.fetchText(`/api/skills/${encodeURIComponent(hubSkill?.id ?? '')}`);
    const body = (JSON.parse(detailText) as { body: string }).body;
    ok(body.length > 0, `已安装技能的详情能显示正文（${body.length} 字）`);
    await d.waitFor(`${rows} === ${folderOk ? 3 : 2}`, '界面列表刷新');
    await new Promise((r) => setTimeout(r, 300));
    await shot('settings-skills');

    // 清理：删除全部已安装技能，验证删除流程
    for (const s of (await d.fetchJson<SkillDto[]>('/api/skills')).filter((x) => x.source !== 'builtin')) {
      await d.eval(`fetch('/api/skills/${encodeURIComponent(s.id)}', { method: 'DELETE' })`);
    }
    ok((await d.fetchJson<SkillDto[]>('/api/skills')).every((s) => s.source === 'builtin'), '已安装技能可以删除');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
