import type { ScenarioContext } from './outline.ts';

/** M0：外壳与设置页（数据目录显示）。退出流程放在全部场景之后统一验证。 */
export async function shellScenario({ d, ok, shot }: ScenarioContext, dataDir: string): Promise<void> {
  await d.waitFor(`document.querySelector('.brand')?.textContent === 'NovelEditor'`, '首屏渲染出应用外壳');
  ok(true, '首屏渲染出应用外壳');
  await d.waitText('已连接');
  ok(true, 'SSE 已连接');
  ok(await d.eval<boolean>(`location.pathname === '/'`), '登录后跳转到首页，地址栏不再含 nonce');
  await d.waitText('还没有作品');
  ok(true, '作品库空状态可见');
  await shot('library');
  await d.clickText('.n-menu-item-content', '设置');
  await d.clickText('.n-tabs-tab', '关于');
  await d.waitText('数据目录');
  ok((await d.eval<string>('document.body.innerText')).includes(dataDir), '设置页显示的数据目录与实际一致');
  await shot('settings');
  await d.clickText('.n-menu-item-content', '作品库');
  await d.waitText('还没有作品');
}

export async function exitScenario({ d, ok }: ScenarioContext): Promise<void> {
  await d.clickText('.n-menu-item-content', '设置');
  await d.clickText('.n-tabs-tab', '关于');
  await d.clickText('button', '退出程序');
  await d.clickText('button', '退出');
  await d.waitText('程序已退出');
  ok(true, '点击「退出程序」后页面显示「程序已退出」');
}
