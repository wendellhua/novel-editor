export interface CliArgs {
  dataDir: string | null;
  noBrowser: boolean;
}

/**
 * 解析命令行与环境变量。扫描全部参数而不依赖位置：SEA 中 argv[1] 也是可执行文件路径。
 * `--data-dir <dir>` / `--data-dir=<dir>` / `NE_DATA_DIR`；`--no-browser` / `NE_NO_BROWSER=1`。
 */
export function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv): CliArgs {
  let dataDir: string | null = env.NE_DATA_DIR?.trim() || null;
  let noBrowser = env.NE_NO_BROWSER === '1';
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '--no-browser') noBrowser = true;
    else if (arg === '--data-dir') {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        dataDir = next;
        i++;
      }
    } else if (arg.startsWith('--data-dir=')) dataDir = arg.slice('--data-dir='.length) || null;
  }
  return { dataDir, noBrowser };
}
