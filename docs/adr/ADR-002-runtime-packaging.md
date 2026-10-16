# ADR-002：运行时与打包——Node 26 官方运行时；Windows 用 SEA 单 exe，Mac arm64 用 .app
- **状态**：已采纳
- **日期**：2026-10-09

## 背景 (Context)
- 安装要求：用户机器无需安装 Node，双击即可启动并自动打开浏览器。
- 目标平台：Windows x64，以及 **macOS Apple 芯片**。Mac 版只需在本机能运行，不考虑签名和公证（用户 2026-10-09 确认）。
- 调研发现：
  - Node SEA 的稳定性等级为 1.1，**不支持 macOS x64**（F1）。
  - SEA 默认只能 `require` 内置模块（F2）。
  - Bun 可以交叉编译，但偏离了用 Node 的建议（决策矩阵：A 得 4.60，B 得 4.35）。

## 候选选项 (Options)
1. **A：Windows 用 SEA；Mac 用 `.app` 内置官方 node 二进制**
   - 优点：使用官方运行时，最成熟；开发和运行用同一个运行时。
   - 缺点：需要维护两种打包脚本。
2. **B：Bun `--compile` 一次产出全平台单文件**
   - 优点：构建最省事。
   - 缺点：Node 兼容性有风险，存储 API 会绑定 Bun。
3. **C：全平台都用 SEA**
   - 优点：统一。
   - 缺点：Mac 上双击裸二进制会打开终端；SEA 在 Mac 上必须 codesign。

## 决定 (Decision)
采用 A。
- **构建**：esbuild 把服务端打成单个 `server.cjs`；Vite 构建前端 `web/`。
- **Windows**：`node --build-sea sea-config.json`，生成 `NovelEditor.exe`，配置如下：
  - `web/**` 和 `builtin-skills/**` 作为 `assets` 打进 exe；
  - `useSnapshot = false`，`useCodeCache = false`；
  - `disableExperimentalSEAWarning = true`；
  - 不签名，SmartScreen 出现提示时选择「仍要运行」。
- **Mac arm64**：组装 `NovelEditor.app`，内含官方 darwin-arm64 node 二进制和启动脚本，打成 `tar.gz` 以保留可执行权限。不做公证。
- **Node 版本**：pin 到 26.x。构建机最低 25.5，因为 `--build-sea` 从这个版本开始提供。

## 理由 (Rationale)
- 在最看重的「不丢稿」和「运行时成熟度」上，官方运行时风险最低。
- 用户只要求 Mac 本机能运行，所以 `.app` 不需要签名链路。官方 node 二进制本身带有有效签名，满足 Apple 芯片「代码必须签名」的要求（假设 A4，待冒烟验证）。
- 本地构建或从本地拷贝的 `.app` 不带 quarantine 属性，Gatekeeper 不会拦截。如果是通过浏览器下载的，执行一次 `xattr -dr com.apple.quarantine NovelEditor.app` 即可，这条命令写进使用说明。

## 后果 (Consequences)
- **正面**
  - 安装包体积约为 Node 二进制大小（约 100 MB 量级），加上应用本身（几 MB）。
  - 两个平台运行同一份 `server.cjs`，行为一致。
- **负面 / 代价**
  - 维护两套打包脚本。
  - Windows 双击后会出现一个控制台窗口。UI 上把它说明为「运行窗口，关闭即退出」。退出时 Windows 会给进程发 SIGHUP，已在 F1 中处理。
  - 运行时代码禁止引入原生模块，所有依赖都必须能被 esbuild 打进单文件。
  - 生成 Mac 包需要先下载 darwin-arm64 的 node 二进制，可以在 Windows 上完成打包。
