/** macOS .app 外壳文件（§5.3）。全部使用 LF 换行：CRLF 会让 shebang 失效。 */
import { MAC_MIN_SYSTEM } from './user-guide.ts';

export { MAC_MIN_SYSTEM };
export { MAC_README } from './user-guide.ts';

export function infoPlist(version: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>NovelEditor</string>
  <key>CFBundleDisplayName</key><string>NovelEditor</string>
  <key>CFBundleIdentifier</key><string>local.noveleditor.app</string>
  <key>CFBundleExecutable</key><string>NovelEditor</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>LSMinimumSystemVersion</key><string>${MAC_MIN_SYSTEM}</string>
  <key>LSArchitecturePriority</key><array><string>arm64</string></array>
  <key>LSUIElement</key><true/>
</dict>
</plist>
`;
}

/**
 * 启动脚本：用 nohup 在后台启动内置 node 后立即退出（§5.3）。
 * 再次双击 .app 时脚本会重新执行：新进程发现已有实例，只打开浏览器后退出（F1 / INV-14）。
 * 启动早期（日志模块就绪前）的输出写入 logs/launcher.log，便于排查。
 */
export const LAUNCHER_SCRIPT = `#!/bin/sh
RES="$(cd "$(dirname "$0")/../Resources" && pwd)"
LOG_DIR="$HOME/Library/Application Support/NovelEditor/logs"
mkdir -p "$LOG_DIR"
nohup "$RES/node" --disable-warning=ExperimentalWarning "$RES/app/server.cjs" >> "$LOG_DIR/launcher.log" 2>&1 &
exit 0
`;
