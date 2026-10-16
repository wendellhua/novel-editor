import type { PageDriver } from '../page-driver.ts';

export interface ScenarioContext {
  d: PageDriver;
  ok(cond: boolean, message: string): void;
  /** 记录度量结果（不作为通过条件）。 */
  note(message: string): void;
  shot(name: string): Promise<void>;
  origin: string;
  /** 强杀服务进程（SIGKILL）。 */
  killServer(): Promise<void>;
  /** 用同一数据目录重新启动服务。 */
  startServer(): Promise<void>;
  /** 临时放行一类预期的网络错误日志（如故意制造的 409），返回撤销函数。 */
  allowNetworkLog(pattern: RegExp): () => void;
}

type Outline = string[][];

const OUTLINE_JS = `(() => {
  const out = [];
  for (const el of document.querySelectorAll('[data-testid="outline-volume"], [data-testid="outline-chapter"]')) {
    const text = el.querySelector('.n-tree-node-content__text')?.textContent.trim() ?? '';
    if (el.dataset.testid === 'outline-volume') out.push([text]);
    else out.at(-1)?.push(text);
  }
  return out;
})()`;

const nodeSel = (title: string): string =>
  `[...document.querySelectorAll('[data-testid^="outline-"]')].find(e => e.querySelector('.n-tree-node-content__text')?.textContent.trim() === ${JSON.stringify(title)})`;

async function outline(d: PageDriver): Promise<Outline> {
  return d.eval<Outline>(OUTLINE_JS);
}

async function waitOutline(d: PageDriver, expected: Outline, step: string): Promise<void> {
  const want = JSON.stringify(expected);
  try {
    await d.waitFor(`JSON.stringify(${OUTLINE_JS}) === ${JSON.stringify(want)}`, step, 6000);
  } catch {
    throw new Error(`${step}：目录树应为 ${want}，实际 ${JSON.stringify(await outline(d))}`);
  }
}

async function contextMenu(d: PageDriver, title: string, item: string): Promise<void> {
  await d.waitFor(nodeSel(title), `目录节点「${title}」`);
  await d.eval(`(() => { const el = ${nodeSel(title)}; const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + r.height / 2 })); })()`);
  await d.clickText('.n-dropdown-option-body', item);
}

async function promptEnter(d: PageDriver, expectedInitial: string | null, value?: string): Promise<void> {
  await d.waitFor(`document.querySelector('.n-dialog input') === document.activeElement`, '输入框获得焦点');
  if (expectedInitial !== null) {
    const initial = await d.eval<string>(`document.querySelector('.n-dialog input').value`);
    if (initial !== expectedInitial) throw new Error(`输入框默认值应为「${expectedInitial}」，实际「${initial}」`);
  }
  if (value !== undefined) await d.insertText(value);
  await d.press('Enter');
  await d.waitFor(`!document.querySelector('.n-dialog')`, '对话框关闭');
}

/** 模拟 HTML5 拖拽：在目标节点的 top/middle/bottom 位置依次派发 dragstart → dragenter → dragover → drop → dragend。 */
async function drag(d: PageDriver, from: string, to: string, where: 'top' | 'middle' | 'bottom'): Promise<void> {
  await d.eval(`(() => {
    const src = ${nodeSel(from)}, dst = ${nodeSel(to)};
    if (!src || !dst) throw new Error('拖拽节点不存在');
    const dt = new DataTransfer();
    const r = dst.getBoundingClientRect();
    const y = ${JSON.stringify(where)} === 'top' ? r.top + 2 : ${JSON.stringify(where)} === 'bottom' ? r.bottom - 2 : r.top + r.height / 2;
    const ev = (type, el, cy) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 30, clientY: cy }));
    const sr = src.getBoundingClientRect();
    ev('dragstart', src, sr.top + sr.height / 2);
    ev('dragenter', dst, y);
    ev('dragover', dst, y);
    ev('drop', dst, y);
    ev('dragend', src, y);
  })()`);
}

/** T8：作品库 → 目录树全部结构操作 → 回收站 → 导出 → 刷新后持久化。 */
export async function outlineScenario({ d, ok, shot }: ScenarioContext): Promise<void> {
  const title = '冒烟测试作品';
  await d.clickTestId('new-work');
  await d.focus('[data-testid="work-title"] input');
  await d.insertText(title);
  await d.clickTestId('work-submit');
  await d.waitFor(`document.querySelector('[data-testid="work-heading"]')?.textContent === ${JSON.stringify(title)}`, '进入新作品工作区');
  const workId = await d.eval<string>(`location.pathname.split('/')[2]`);
  await waitOutline(d, [['第一卷', '第一章']], '新作品自带第一卷/第一章');
  ok(true, '在作品库新建作品后进入工作区，自带「第一卷 / 第一章」');

  await d.clickTestId('new-chapter');
  await promptEnter(d, '第2章');
  await d.clickTestId('new-chapter');
  await promptEnter(d, '第3章');
  await d.clickTestId('new-volume');
  await promptEnter(d, '第2卷');
  for (const n of [4, 5, 6]) {
    await contextMenu(d, '第2卷', '新建章节');
    await promptEnter(d, `第${n}章`);
  }
  await waitOutline(d, [['第一卷', '第一章', '第2章', '第3章'], ['第2卷', '第4章', '第5章', '第6章']], '建 2 卷 6 章');
  ok(true, '工具栏与右键菜单新建 2 卷 × 3 章（默认标题自动编号，回车确认）');

  await contextMenu(d, '第3章', '上移');
  await waitOutline(d, [['第一卷', '第一章', '第3章', '第2章'], ['第2卷', '第4章', '第5章', '第6章']], '右键上移');
  ok(true, '右键「上移」调整章节顺序');

  await drag(d, '第2章', '第5章', 'bottom');
  await waitOutline(d, [['第一卷', '第一章', '第3章'], ['第2卷', '第4章', '第5章', '第2章', '第6章']], '拖拽跨卷移动');
  ok(true, '拖拽「第2章」到第2卷「第5章」之后（跨卷移动）');

  await drag(d, '第2卷', '第一卷', 'top');
  await waitOutline(d, [['第2卷', '第4章', '第5章', '第2章', '第6章'], ['第一卷', '第一章', '第3章']], '拖拽调整分卷顺序');
  ok(true, '拖拽「第2卷」到「第一卷」之前（分卷排序）');

  await contextMenu(d, '第一章', '删除章节');
  await d.clickText('.n-dialog .n-button', '删除');
  await waitOutline(d, [['第2卷', '第4章', '第5章', '第2章', '第6章'], ['第一卷', '第3章']], '删除章节');
  await d.clickTestId('open-trash');
  await d.waitFor(`document.querySelectorAll('[data-testid="trash-item"]').length === 1`, '回收站出现被删章节');
  await shot('trash');
  await d.clickTestId('trash-restore');
  await waitOutline(d, [['第2卷', '第4章', '第5章', '第2章', '第6章'], ['第一卷', '第3章', '第一章']], '从回收站恢复');
  ok(true, '删除「第一章」进入回收站，恢复后回到所在卷末尾');
  await d.press('Escape');

  const api = await d.fetchJson<{ volumes: { title: string; chapters: { title: string }[] }[] }>(`/api/works/${workId}/tree`);
  const apiOutline = api.volumes.map((v) => [v.title, ...v.chapters.map((c) => c.title)]);
  ok(JSON.stringify(apiOutline) === JSON.stringify(await outline(d)), '界面目录树与服务端目录树完全一致');

  const txt = await d.fetchText(`/api/works/${workId}/export?format=txt`);
  const order = apiOutline.flat().map((t) => txt.indexOf(`\r\n${t}\r\n`));
  ok(order.every((pos, i) => pos > (order[i - 1] ?? -1)), '导出 TXT 的卷章顺序与目录树一致');

  await d.page.send('Page.reload');
  await d.waitFor(`document.querySelector('[data-testid="work-heading"]')?.textContent === ${JSON.stringify(title)}`, '刷新后重新载入');
  await waitOutline(d, apiOutline, '刷新后结构不变');
  ok(true, '刷新页面后结构保持不变');
  await shot('outline');

  await d.clickText('.n-menu-item-content', '作品库');
  await d.waitFor(`document.querySelectorAll('[data-testid="work-card"]').length === 1`, '作品库出现作品卡片');
  ok(await d.eval<boolean>(`document.querySelector('[data-testid="work-card"]').innerText.includes('6 章')`), '作品库卡片显示章节数');
  await shot('library-with-work');
}
