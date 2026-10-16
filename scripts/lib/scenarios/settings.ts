import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { apiCall } from './checks.ts';
import type { ScenarioContext } from './outline.ts';

const KEY = 'sk-smoke-SECRET-0123456789';

interface MockLlm {
  baseUrl: string;
  authHeaders: string[];
  modes: string[];
  close(): Promise<void>;
}

/**
 * 只支持 prompt 档的 OpenAI 兼容服务：带 response_format 的请求一律 400，用来验证探测逐档降级。
 * 模型名为 slow-model 的请求一直不响应（模拟服务卡住，用来验证「取消测试」）。
 */
async function startPromptOnlyLlm(): Promise<MockLlm> {
  const authHeaders: string[] = [];
  const modes: string[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      let body: { model?: string; response_format?: { type?: string } } = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof body;
      } catch {
        // 保持空对象
      }
      if (body.model === 'slow-model') return;
      authHeaders.push(req.headers.authorization ?? '');
      modes.push(body.response_format?.type ?? 'prompt');
      res.setHeader('Content-Type', 'application/json');
      if (body.response_format !== undefined) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: { message: 'response_format is not supported' } }));
        return;
      }
      res.end(JSON.stringify({ choices: [{ message: { content: '好的：{"ok": true, "reply": "pong"}' }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    authHeaders,
    modes,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

const stateOf = (index: number): string => `(document.querySelectorAll('[data-testid="llm-row"]')[${index}]?.querySelector('[data-testid="llm-state"]')?.innerText.trim())`;
const rowText = (index: number): string => `(document.querySelectorAll('[data-testid="llm-row"]')[${index}]?.innerText ?? '')`;

/**
 * 模型异常的提示与处理：顶栏标签说明是本地服务连接；连不上的模型显示「异常」、原因与处理建议；
 * 卡住的模型「测试中」显示已等待的秒数，可以取消；取消后不留下结果。
 */
async function abnormalModels(ctx: ScenarioContext, mockBaseUrl: string): Promise<void> {
  const { d, ok, shot } = ctx;
  const header = await d.eval<string>(`document.querySelector('[data-testid="service-connection"]')?.innerText.trim() ?? ''`);
  ok(header === '本地服务已连接', `顶栏标签写明是本地服务的连接（${header}），不再被误认为模型状态`);
  ok((await d.eval<string>(stateOf(0))) === '可用', '测试成功的模型显示「可用」');

  // 连不上的地址（刚关闭的本机端口）与一直不响应的模型；按顺序创建，列表顺序固定
  const closed = createServer();
  await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
  const closedPort = (closed.address() as AddressInfo).port;
  await new Promise((r) => closed.close(r));
  const ids = [
    (await d.eval<{ id: string }>(apiCall('POST', '/api/llm/profiles', { name: '连不上', baseUrl: `http://127.0.0.1:${closedPort}/v1`, model: 'm' }))).id,
    (await d.eval<{ id: string }>(apiCall('POST', '/api/llm/profiles', { name: '卡住', baseUrl: mockBaseUrl, model: 'slow-model' }))).id,
  ];
  await d.navigate(`${ctx.origin}/settings`);
  await d.waitFor(`document.querySelectorAll('[data-testid="llm-row"]').length === 3`, '三个模型');
  ok((await d.eval<string>(stateOf(1))) === '未检测' && (await d.eval<string>(rowText(1))).includes('尚未检测'), '新添加的模型显示「未检测」并提示测试');

  await d.eval(`document.querySelectorAll('[data-testid="llm-row"]')[1].querySelector('[data-testid="llm-test"]').click()`);
  await d.waitFor(`${stateOf(1)} === '异常'`, '连不上的模型显示异常', 15_000);
  const failed = await d.eval<string>(rowText(1));
  ok(failed.includes('连接异常：网络错误') && failed.includes('处理建议：') && failed.includes('服务地址'), `连不上时显示原因与处理建议：${failed.split('\n').slice(2).join(' / ')}`);

  await d.eval(`document.querySelectorAll('[data-testid="llm-row"]')[2].querySelector('[data-testid="llm-test"]').click()`);
  await d.waitFor(`${stateOf(2)} === '测试中' && ${rowText(2)}.includes('已等待')`, '测试中显示已等待的秒数');
  await new Promise((r) => setTimeout(r, 1300));
  await shot('settings-model-status');
  ok((await d.eval<string>(rowText(2))).includes('取消测试'), '测试进行中可以「取消测试」');
  await d.eval(`document.querySelectorAll('[data-testid="llm-row"]')[2].querySelector('[data-testid="llm-test-cancel"]').click()`);
  await d.waitFor(`${stateOf(2)} === '未检测'`, '取消后回到未检测');
  await d.waitText('已取消「卡住」的测试连接');
  ok(true, '取消测试后立即结束，不留下结果');

  await d.eval(`Promise.all(${JSON.stringify(ids)}.map((id) => fetch('/api/llm/profiles/' + id, { method: 'DELETE' })))`);
  await d.navigate(`${ctx.origin}/settings`);
  await d.waitFor(`document.querySelectorAll('[data-testid="llm-row"]').length === 1`, '删除临时模型');
}

const inputOf = (testId: string): string => `[data-testid="${testId}"] input`;

/** T10：设置 → 模型。添加模型（预设填充）、Key 只显示掩码、测试连接探测降级并写回、首个模型成为默认、换域名清 Key 提示。 */
export async function settingsScenario(ctx: ScenarioContext): Promise<void> {
  const { d, ok, shot } = ctx;
  const mock = await startPromptOnlyLlm();
  try {
    await d.navigate(`${ctx.origin}/settings`);
    await d.waitText('尚未配置模型');
    ok(true, '设置页默认打开「模型」标签，空状态可见');

    await d.clickTestId('llm-add');
    await d.waitFor(`document.querySelector('[data-testid="llm-form"]')`, '添加模型表单');
    await d.eval(`document.querySelector('[data-testid="llm-preset"] .n-base-selection').click()`);
    await d.clickText('.n-base-select-option', 'DeepSeek');
    await d.waitFor(`document.querySelector(${JSON.stringify(inputOf('llm-baseurl'))}).value === 'https://api.deepseek.com'`, '预设填入服务地址');
    ok(
      (await d.eval<string>(`document.querySelector(${JSON.stringify(inputOf('llm-name'))}).value`)) === 'DeepSeek' &&
        (await d.eval<string>(`document.querySelector(${JSON.stringify(inputOf('llm-model'))}).placeholder`)).includes('deepseek-chat'),
      '选择预设后自动填入名称与地址，模型名给出示例',
    );

    await d.focus(inputOf('llm-baseurl'));
    await d.eval(`document.querySelector(${JSON.stringify(inputOf('llm-baseurl'))}).select()`);
    await d.insertText(mock.baseUrl);
    await d.focus(inputOf('llm-apikey'));
    await d.insertText(KEY);
    await d.focus(inputOf('llm-model'));
    await d.insertText('mock-model');
    await d.clickTestId('llm-submit');
    await d.waitFor(`document.querySelectorAll('[data-testid="llm-row"]').length === 1`, '列表出现新模型');
    const rowText = await d.eval<string>(`document.querySelector('[data-testid="llm-row"]').innerText`);
    ok(rowText.includes('sk-****6789') && !rowText.includes(KEY), '列表只显示掩码 Key');
    await d.waitFor(
      `document.querySelector('[data-testid="llm-default-typo"]')?.innerText.includes('DeepSeek')`,
      '首个模型自动成为默认模型',
    );
    ok(true, '首个模型自动成为全部任务的默认模型');

    await d.clickTestId('llm-test');
    await d.waitFor(`document.querySelector('[data-testid="llm-probe"]')?.innerText.includes('连接正常')`, '测试连接成功', 15_000);
    const probe = await d.eval<string>(`document.querySelector('[data-testid="llm-probe"]').innerText`);
    ok(/提示词约束 · \d+ ms/.test(probe), `测试连接显示探测到的档位和延迟：${probe.trim()}`);
    ok(mock.modes.join(',') === 'json_schema,json_object,prompt', '探测按 json_schema → json_object → prompt 逐档降级');
    await d.waitFor(`document.querySelector('[data-testid="llm-jsonmode"]')?.innerText === '提示词约束'`, '档位标签更新');
    ok(mock.authHeaders.every((h) => h === `Bearer ${KEY}`), '请求模型服务时带上了完整 Key（只在服务端）');
    await abnormalModels(ctx, mock.baseUrl);

    await d.clickTestId('llm-edit');
    await d.waitFor(`document.querySelector(${JSON.stringify(inputOf('llm-apikey'))})?.placeholder.includes('sk-****6789')`, '编辑时 Key 输入框为空，只提示掩码');
    ok((await d.eval<string>(`document.querySelector(${JSON.stringify(inputOf('llm-apikey'))}).value`)) === '', '编辑表单不回填 Key');
    await d.focus(inputOf('llm-baseurl'));
    await d.eval(`document.querySelector(${JSON.stringify(inputOf('llm-baseurl'))}).select()`);
    await d.insertText(mock.baseUrl.replace('127.0.0.1', 'localhost'));
    await d.waitFor(`document.querySelector('[data-testid="llm-key-clear-warning"]')`, '换域名提示');
    ok(true, '修改服务域名且未填新 Key 时提示旧 Key 将被清空');
    await new Promise((r) => setTimeout(r, 400));
    await shot('settings-model-form');
    await d.clickText('.n-card__footer button', '取消');
    await d.waitFor(`!document.querySelector('[data-testid="llm-form"]')`, '关闭表单');
    await new Promise((r) => setTimeout(r, 400));
    await shot('settings-models');

    const apiText = await d.fetchText('/api/llm/profiles');
    const html = await d.eval<string>('document.documentElement.outerHTML');
    ok(!apiText.includes(KEY) && !html.includes(KEY), '接口响应与页面中都没有明文 Key（INV-17）');
  } finally {
    await mock.close();
  }
}
