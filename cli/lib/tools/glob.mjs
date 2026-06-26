// glob 工具：按文件名模式查找，契约对标 claude-code GlobTool。
//  - 结果默认上限 100，超出标 truncated
//  - 按修改时间(mtime)倒序排序（最近修改的在前）
//  - 远程优先用 rg --files + glob 过滤；降级用 find -name
import { runScript, shQuote } from '../ssh.mjs';
import { ok, fail } from '../output.mjs';

export const usage = `glob <pattern> [--path DIR] [--limit N]
  pattern   文件名 glob 模式，如 "*.js"、"**/*.ts"
  --path    搜索目录（默认远程 HOME）
  --limit   结果上限（默认 100）`;

const DEFAULT_LIMIT = 100;

export async function run(target, positional, flags) {
  const pattern = positional[0];
  if (!pattern) {
    return fail('glob 需要 pattern 参数。\n' + usage);
  }
  const searchPath = flags.path || '.';
  const limit = flags.limit ? parseInt(flags.limit, 10) : DEFAULT_LIMIT;
  const fetchN = limit + 1; // 多取一个用于判断 truncated

  const qPath = shQuote(searchPath);
  const qPattern = shQuote(pattern);

  // rg --files 列出所有文件，--glob 过滤；按 mtime 排序用 stat。
  // 降级：find 按 -name（仅 basename 匹配）。两者都用 perl/stat 排序 mtime。
  // 为兼容 BSD/GNU 的 stat 差异，统一用 `ls -t` 不可靠（受参数列表长度限制），
  // 改用 find -printf（GNU）/ stat（BSD）；这里用一个可移植的方案：
  // 先收集文件列表，再用 awk + stat 排序。简化：rg/find 出列表后用 perl 取 mtime 排序。
  const script = `
set -e
cd ${qPath} 2>/dev/null || { echo "__RS_NOPATH__"; exit 0; }
if command -v rg >/dev/null 2>&1; then
  files=$(rg --files --hidden --glob '!.git' --glob ${qPattern} 2>/dev/null || true)
else
  echo "__RS_NORG__" >&2
  files=$(find . -type f -name ${qPattern} 2>/dev/null | sed 's|^\\./||' || true)
fi
if [ -z "$files" ]; then echo "__RS_EMPTY__"; exit 0; fi
# 用 perl 给每个文件取 mtime 并按倒序排序输出路径
echo "$files" | perl -e '
  my @rows;
  while (my $f = <STDIN>) { chomp $f; next if $f eq ""; my @s = stat($f); push @rows, [$f, $s[9] // 0]; }
  for my $r (sort { $b->[1] <=> $a->[1] || $a->[0] cmp $b->[0] } @rows) { print $r->[0], "\\n"; }
'
`.trim();

  const r = await runScript(target, script);
  if (r.stdout.startsWith('__RS_NOPATH__')) {
    return fail(`目录不存在: ${searchPath}`);
  }
  if (r.stdout.startsWith('__RS_EMPTY__')) {
    return ok({ data: { numFiles: 0, filenames: [], truncated: false }, text: 'No files found' });
  }

  let files = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean)
    .filter((l) => !l.startsWith('__RS_'));

  const truncated = files.length > limit;
  if (truncated) {
    files = files.slice(0, limit);
  }

  const text = truncated
    ? files.join('\n') + '\n(Results are truncated. Consider using a more specific path or pattern.)'
    : files.join('\n');

  return ok({
    data: { numFiles: files.length, filenames: files, truncated },
    text,
  });
}
