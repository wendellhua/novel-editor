# 贡献指南

感谢你愿意为 NovelEditor 出力。提交代码、文档、内置技能的改进，或者报告问题，都欢迎。

## 开始之前

- 提交较大改动（新功能、依赖、目录结构、接口、数据模型）前，请先开一个 Issue 讨论。
- 本项目有几条硬约束，违反的 PR 会被要求修改：
  - **禁止原生模块**；运行时依赖只能是纯 JS，许可证限 MIT / ISC / BSD / Apache-2.0。新增运行时依赖前需要先写 ADR（`docs/adr/`）。
  - **前端不得引用任何外部 URL**（CDN、在线字体等），构建时会扫描。
  - **不丢稿优先于一切**：任何写入正文的路径都要保持 `rev` 乐观锁、写入前版本快照与可恢复性。
  - **API Key 只保存在服务端**，不得进入日志、响应或前端代码。
  - 技能（`SKILL.md`）只作为提示词使用，不执行任何代码。
- 架构、接口、数据模型或目录结构发生变化时，**同步更新 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)**（含 §10 变更日志）；做出重要技术决策时新增 ADR。

## 开发环境

需要 Node.js 24 或更高版本。

```bash
git clone https://github.com/wendellhua/novel-editor.git
cd novel-editor
npm ci
npm run dev
```

目录结构见 [架构文档 §5.1](docs/ARCHITECTURE.md)。简要说明：

| 目录 | 内容 |
|---|---|
| `src/shared/` | 前后端共享的纯函数与类型（禁止引用 `node:*`、DOM、第三方包） |
| `src/server/` | 本机服务：HTTP、存储、模型接入、技能、AI 检查引擎等 |
| `src/web/` | Vue 3 前端 |
| `builtin-skills/` | 内置技能（`SKILL.md`）与 `manifest.json` |
| `scripts/` | 构建、打包、冒烟与基线脚本 |
| `tests/` | `unit/`、`integration/`、`perf/`、`helpers/`、`fixtures/` |

模块依赖方向由 `tests/unit/architecture.test.ts` 自动检查。

## 提交前检查

```bash
npm run typecheck   # 必须零错误
npm test            # 必须全部通过
npm run build       # 构建与外部 URL 扫描
```

涉及界面或启动流程的改动，另请在本机运行 `npm run smoke:browser`（需要 Chrome 或 Edge），确认控制台零错误。涉及性能敏感路径（保存、目录树、检查引擎）时运行 `npm run test:perf`。

测试原则：

- 用**真实的 SQLite 与真实的 HTTP 调用链**，大模型用 `tests/helpers/mock-llm.ts` 模拟，不要在测试里请求真实模型。
- 修复缺陷时先写出能复现的失败用例。
- 测试里不要出现真实 API Key、个人路径或真实作品内容。

## 修改内置技能

内置技能位于 `builtin-skills/*/SKILL.md`。修改规则文本时：

- 不要改技能名称、`manifest.json` 中的类型对应关系，以及输出格式——输出格式以编辑器协议（`src/server/checks/protocol.ts`）和输出 Schema 为准。
- 规则段长度受 `skillPromptMaxChars` 限制，且要保证 16k 上下文的模型仍放得下单个片段（`npm test` 会检查）。
- 示例中的人物、题材不要与公开基线样章重合，避免「背答案」。
- 改动前后可用真实模型基线对照质量（见下）。

## 真实模型基线（可选）

基线脚本使用真实模型，**Key 只通过环境变量传入，不要写入文件或提交**：

```bash
# PowerShell
$env:NE_LLM_BASE_URL = "https://api.deepseek.com"
$env:NE_LLM_API_KEY  = "<your key>"
$env:NE_LLM_MODEL    = "<model name>"
npm run baseline:typo          # 错别字：召回 / 误报
npm run baseline:bible         # 设定抽取
npm run baseline:consistency   # 一致性检查
```

```bash
# bash / zsh
NE_LLM_BASE_URL=https://api.deepseek.com NE_LLM_API_KEY=<your key> NE_LLM_MODEL=<model name> npm run baseline:typo
```

结果写入 `.cache/`（已被 Git 忽略）。

## 代码风格

- TypeScript 严格模式，`erasableSyntaxOnly`（脚本可由 Node 直接运行 `.ts`）。
- 缩进 2 空格，LF 换行，UTF-8，见 `.editorconfig`。
- 注释和文档使用中文，与现有代码保持一致；对外文档（README）提供中英两版。

## 提交信息与 Pull Request

- 提交信息建议使用 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/)：`feat:`、`fix:`、`docs:`、`test:`、`refactor:`、`chore:`。
- 一个 PR 只做一件事，描述中说明动机、做了什么、怎么验证的。
- PR 需要通过 CI（类型检查、构建、测试）。
- 用户可见的变化请在 [`CHANGELOG.md`](CHANGELOG.md) 的 `Unreleased` 下补一行。

## 报告问题

- 缺陷与功能建议：使用 Issue 模板。
- **请勿在 Issue 中粘贴 API Key、`llm.json` 或未脱敏的日志。** 日志位于数据目录的 `logs/`，API Key 已自动脱敏，但仍请先检查。
- 安全漏洞请按 [SECURITY.md](SECURITY.md) 私下报告。

## 行为准则

参与本项目即表示同意遵守 [行为准则](CODE_OF_CONDUCT.md)。
