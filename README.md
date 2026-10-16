# NovelEditor

[English](README.en.md) | 简体中文

面向长篇网文作者的**本地离线小说编辑器**：在浏览器里写作，数据只保存在你自己的电脑上；可接入任意 OpenAI 兼容的大模型，做错别字、审稿、设定与角色一致性检查，并提供 AI 味检测、灵感胶囊、智能扩写和剧情记忆。

![AI 检查结果与一键修正](docs/images/issues-panel.png)

## 特性

- **不丢稿优先**：浏览器草稿 + 带版本号的事务保存 + 章节历史版本 + 每日整库备份；删除一律进回收站，可恢复。
- **为百万字长篇设计**：目录树、章节、分卷拖拽排序；5 万字章节秒开，保存耗时个位数毫秒。
- **完全离线写作**：编辑、保存、版本、导出不依赖网络；只有 AI 功能与技能市场需要联网。
- **AI 检查**（作品 / 分卷 / 章节三级范围，可暂停、恢复、取消）：
  - 错别字与标点（结果在正文中高亮，可一键修正、撤销）
  - 编辑审稿（逐条意见、逐章评语、整体报告）
  - 设定一致性、角色一致性（带依据，合理的剧情变化不报）
  - AI 味检测与一键优化
  - 灵感胶囊（五条剧情路线）、智能扩写（只续写当前章，确认后插入）
  - 设定抽取（人物、地点、势力等候选，作者审核后入库）
- **剧情记忆**：写满约 3000 字自动增量更新，让长篇后期的检查与构思有据可依。
- **技能（Skills）**：每类检查的规则都写成 `SKILL.md`，可查看、停用、替换；支持从 SkillHub 安装或本地导入。技能只当提示词使用，**不会执行任何代码**。
- **模型无关**：预设 DeepSeek、通义千问、Kimi、智谱、腾讯混元、OpenAI，以及本机 Ollama / LM Studio；自动探测 JSON 输出能力并降级；显示模型运行状态与处理建议。
- **零原生依赖**：服务端仅使用 Node 内置的 `node:http` 与 `node:sqlite`；Windows 打包为单个 exe，macOS（Apple 芯片）打包为 `.app`。

## 快速开始

### 方式一：使用发布包（普通用户）

到 [Releases](https://github.com/wendellhua/novel-editor/releases) 下载：

| 平台 | 文件 |
|---|---|
| Windows 10/11 x64 | `NovelEditor.exe`，双击运行 |
| macOS 13.5+（Apple 芯片） | `NovelEditor-mac-arm64.tar.gz`，解压后把 `NovelEditor.app` 拖入「应用程序」 |

程序未做代码签名，首次运行需要手动放行，详见 [使用说明](docs/USER_GUIDE.md#1-安装与启动)。

### 方式二：从源码运行（开发者）

需要 Node.js **24 或更高版本**（使用内置的 `node:sqlite`，无需安装原生模块）。

```bash
git clone https://github.com/wendellhua/novel-editor.git
cd novel-editor
npm ci
npm run dev      # 构建并启动，数据保存在 ./.devdata
```

启动后会自动打开浏览器。只想拿到登录地址、不开浏览器：

```bash
npm run build
node --disable-warning=ExperimentalWarning dist/server.cjs --data-dir .devdata --no-browser
```

### 配置大模型

「设置」→「模型」→「添加模型」，选择厂商预设，填入 API Key 和模型名，点「测试连接」。API Key 只保存在本机数据目录的 `llm.json` 中，界面只显示掩码，日志自动脱敏。

## 常用命令

| 命令 | 说明 |
|---|---|
| `npm run dev` | 构建并以开发数据目录启动 |
| `npm run build` | 构建前端（Vite）与服务端（esbuild 单文件） |
| `npm run typecheck` | `vue-tsc` 类型检查 |
| `npm test` | 单元与集成测试（Vitest，使用真实 SQLite 与真实 HTTP 调用链） |
| `npm run test:perf` | 性能测试（300 万字 / 3000 章的合成数据） |
| `npm run smoke` / `npm run smoke:browser` | 进程级冒烟 / 浏览器冒烟（需本机 Chrome 或 Edge） |
| `npm run baseline:typo` 等 | 用真实模型跑质量基线，Key 通过环境变量传入（见 [CONTRIBUTING](CONTRIBUTING.md)） |
| `npm run package:win` / `package:mac` | 打包发布产物（`release/`） |

## 文档

- [使用说明](docs/USER_GUIDE.md)：安装、写作、模型、AI 检查、设定库、数据备份与恢复、常见问题
- [架构设计](docs/ARCHITECTURE.md)：模块划分、数据模型、接口与检查协议、任务清单与变更日志
- [架构决策记录](docs/adr/)：ADR-001 ～ ADR-011
- [更新日志](CHANGELOG.md) · [贡献指南](CONTRIBUTING.md) · [安全策略](SECURITY.md)

## 技术栈

Node.js（`node:http` + `node:sqlite`）· TypeScript · Vue 3 + Pinia + Naive UI · CodeMirror 6 · Vite · esbuild · Vitest

## 隐私与安全

- 服务只监听 `127.0.0.1`，通过一次性令牌换取会话 Cookie，并校验 Host 与 Origin。
- 正文只会在你主动发起 AI 任务时，发送到**你自己配置**的模型服务；程序本身不上传任何数据、没有遥测。
- 发现安全问题请阅读 [SECURITY.md](SECURITY.md)。

## 许可证

[MIT](LICENSE)
