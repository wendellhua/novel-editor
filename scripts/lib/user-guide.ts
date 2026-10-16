/**
 * 随安装包分发的简明说明（T19）：Windows 写到 release/README-win.txt，macOS 放进 tar.gz 的 README-mac.txt。
 * 完整说明见 docs/USER_GUIDE.md。两份文本共用「数据、备份与恢复」一节，内容与 docs/ARCHITECTURE.md §5.2 一致。
 */
export const MAC_MIN_SYSTEM = '13.5';

const dataSection = (dir: string, sep: string): string => `数据、备份与恢复

  数据目录：${dir}
    works${sep}        每部作品一个 .novel 文件（SQLite 数据库）
    backups${sep}      每日自动备份：每部作品每天第一次打开时备份一份，保留最近 7 天
    trash${sep}        删除的作品（可在作品库的回收站中恢复）
    logs${sep}         运行日志（保留 7 天，API Key 已脱敏）
    llm.json        模型配置（含 API Key，请勿发给他人）

  手动备份 / 换电脑：先「设置 → 关于 → 退出程序」，再复制整个数据目录；
    在新电脑上把它放到同样的位置，然后启动程序即可。

  从每日备份恢复某部作品：
    1. 「设置 → 关于 → 退出程序」。
    2. 在 works${sep} 中找到该作品的文件（文件名就是作品 id：打开这部作品时，浏览器地址栏里 /works/ 后面的那一段），
       先改名留底，例如 xxx.novel → xxx.novel.bak；
       同名的 xxx.novel-wal、xxx.novel-shm 如果存在，也一并改名。
    3. 把 backups${sep}xxx${sep} 中想要的那一天的 YYYYMMDD.novel 复制到 works${sep}，改名为 xxx.novel。
    4. 重新启动程序。

  只想找回某一章的旧内容：在章节编辑器上方点「历史版本」，选择版本后恢复（恢复前的内容也会存为一个版本）。
  误删的分卷、章节：编辑器顶栏右侧「回收站」；误删的作品：作品库右上角「回收站」。`;

export const WIN_README = `NovelEditor（Windows 10/11 · 64 位）

1. 双击 NovelEditor.exe，浏览器会自动打开写作页面。
   程序是单个文件，不需要安装 Node.js 或其他运行环境，可以放在任意文件夹（包括中文路径）。

2. 第一次运行时如果出现蓝色窗口「Windows 已保护你的电脑」（SmartScreen）：
   这是因为本程序没有购买代码签名证书。点窗口里的「更多信息」，再点「仍要运行」即可，以后不会再提示。
   如果杀毒软件拦截，请把 NovelEditor.exe 加入信任列表。

3. 程序运行时会有一个黑色的控制台窗口，请不要关闭它——关闭窗口等于退出程序。
   关闭浏览器标签后，再次双击 NovelEditor.exe 就会重新打开页面（不会重复启动）。

4. 退出程序：页面右上角「设置」→「关于」→「退出程序」。未保存的内容会先保存。

5. 使用 AI 检查前，在「设置 → 模型」中添加一个大模型服务（DeepSeek、通义千问、Kimi 等都有预设），
   填入 API Key 后点「测试连接」。API Key 只保存在本机的数据目录里。

${dataSection('%APPDATA%\\NovelEditor\\（在资源管理器地址栏输入 %APPDATA%\\NovelEditor 回车即可打开）', '\\')}

完整的使用说明见随附的 USER_GUIDE.md（或项目 docs/USER_GUIDE.md）。
`;

export const MAC_README = `NovelEditor（macOS · Apple 芯片版）

1. 把 NovelEditor.app 拖到「应用程序」文件夹（或任意位置），双击打开，浏览器会自动打开写作页面。

2. 如果提示「无法打开」「无法验证开发者」或「已损坏」：
   这是因为本程序没有经过 Apple 公证。打开「终端」，执行下面这行（路径换成 NovelEditor.app 的实际位置）：

     xattr -dr com.apple.quarantine /Applications/NovelEditor.app

   然后再双击打开即可，以后不会再提示。

3. 关闭浏览器标签后，再次双击 NovelEditor.app 就会重新打开页面（不会重复启动）。

4. 退出程序：页面右上角「设置」→「关于」→「退出程序」。未保存的内容会先保存。

5. 使用 AI 检查前，在「设置 → 模型」中添加一个大模型服务，填入 API Key 后点「测试连接」。

${dataSection('~/Library/Application Support/NovelEditor/（访达中按 ⇧⌘G 粘贴这个路径即可打开）', '/')}

系统要求：macOS ${MAC_MIN_SYSTEM} 及以上，Apple 芯片（M1/M2/M3/M4…）。
完整的使用说明见随附的 USER_GUIDE.md（或项目 docs/USER_GUIDE.md）。
`;
