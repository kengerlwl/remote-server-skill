// ls 工具：列出远程目录，契约对标 claude-code LS 工具（结构化目录列表）。
//  - 列出指定目录下的文件与子目录
//  - 默认显示详细信息（类型/大小/修改时间）
import { runScript, shQuote } from '../ssh.mjs';
import { ok, fail } from '../output.mjs';

export const usage = `ls [path] [--all]
  path     目录路径（默认远程 HOME / 当前目录）
  --all    包含隐藏文件（. 开头）`;

export async function run(target, positional, flags) {
  const shell = target.shell || 'bash';
  const dirPath = positional[0] || '.';

  if (shell === 'powershell') {
    const cmd = `Get-ChildItem -LiteralPath '${dirPath.replace(/'/g, "''")}'${flags.all ? ' -Force' : ''} | Format-Table -AutoSize`;
    const r = await runScript(target, cmd);
    return ok({ data: { path: dirPath, raw: r.stdout }, text: r.stdout || '(空目录)' });
  }

  const q = shQuote(dirPath);
  const allFlag = flags.all ? '-A' : '';
  const script = `
if [ ! -e ${q} ]; then echo "__RS_NOENT__"; exit 0; fi
if [ ! -d ${q} ]; then echo "__RS_NOTDIR__"; exit 0; fi
ls -lhp ${allFlag} --time-style=long-iso ${q} 2>/dev/null || ls -lhp ${allFlag} ${q}
`.trim();

  const r = await runScript(target, script);
  if (r.stdout.startsWith('__RS_NOENT__')) {
    return fail(`目录不存在: ${dirPath}`);
  }
  if (r.stdout.startsWith('__RS_NOTDIR__')) {
    return fail(`不是目录: ${dirPath}`);
  }
  return ok({ data: { path: dirPath, raw: r.stdout }, text: r.stdout.trim() || '(空目录)' });
}
