// grep 工具：内容搜索，契约对标 claude-code GrepTool（本质是 ripgrep 封装）。
//  - output_mode: content | files_with_matches(默认) | count
//  - content 模式支持 -A/-B/-C 上下文、-n 行号
//  - -i 大小写不敏感、--glob 过滤、--type 文件类型
//  - head_limit 默认 250（0=无限），offset 分页
//  - files_with_matches 按 mtime 倒序
//  - 远程优先 rg，降级 grep -rn（功能子集）
import { runScript, shQuote } from '../ssh.mjs';
import { ok, fail } from '../output.mjs';

export const usage = `grep <pattern> [--path DIR] [--mode content|files|count]
  --glob STR     文件名过滤，如 "*.ts"
  --type STR     文件类型，如 js/py/go（仅 rg 支持）
  -i             大小写不敏感
  -A N / -B N / -C N   上下文行数（content 模式）
  --no-line-number     content 模式不显示行号（默认显示）
  --head-limit N 结果上限（默认 250，0=无限）
  --offset N     跳过前 N 条`;

const DEFAULT_HEAD_LIMIT = 250;

function normalizeMode(m) {
  if (m === 'content') return 'content';
  if (m === 'count') return 'count';
  if (m === 'files' || m === 'files_with_matches') return 'files_with_matches';
  return 'files_with_matches';
}

export async function run(target, positional, flags) {
  const pattern = positional[0];
  if (!pattern) {
    return fail('grep 需要 pattern 参数。\n' + usage);
  }
  const mode = normalizeMode(flags.mode);
  const searchPath = flags.path || '.';
  const caseInsensitive = !!flags.i;
  const showLineNumbers = !flags['no-line-number'];
  const headLimit = flags['head-limit'] !== undefined ? parseInt(flags['head-limit'], 10) : DEFAULT_HEAD_LIMIT;
  const offset = flags.offset ? parseInt(flags.offset, 10) : 0;
  const ctxC = flags.C !== undefined ? parseInt(flags.C, 10) : undefined;
  const ctxA = flags.A !== undefined ? parseInt(flags.A, 10) : undefined;
  const ctxB = flags.B !== undefined ? parseInt(flags.B, 10) : undefined;

  const qPath = shQuote(searchPath);
  const qPattern = shQuote(pattern);

  // 构造 rg 参数
  const rgArgs = ['--hidden', "--glob '!.git'", '--max-columns', '500'];
  if (caseInsensitive) rgArgs.push('-i');
  if (mode === 'files_with_matches') rgArgs.push('-l');
  else if (mode === 'count') rgArgs.push('-c');
  else {
    // content 模式
    if (showLineNumbers) rgArgs.push('-n');
    if (ctxC !== undefined) rgArgs.push('-C', String(ctxC));
    else {
      if (ctxB !== undefined) rgArgs.push('-B', String(ctxB));
      if (ctxA !== undefined) rgArgs.push('-A', String(ctxA));
    }
  }
  if (flags.type) rgArgs.push('--type', shQuote(flags.type));
  if (flags.glob) rgArgs.push('--glob', shQuote(flags.glob));
  // pattern 以 - 开头时用 -e
  rgArgs.push(pattern.startsWith('-') ? `-e ${qPattern}` : qPattern);

  // 降级 grep：-r 递归，-n 行号，-i 不敏感，-l 仅文件名，-c 计数
  const grepFlags = ['-r', '--exclude-dir=.git'];
  if (caseInsensitive) grepFlags.push('-i');
  if (mode === 'files_with_matches') grepFlags.push('-l');
  else if (mode === 'count') grepFlags.push('-c');
  else if (showLineNumbers) grepFlags.push('-n');
  if (ctxC !== undefined) grepFlags.push(`-C ${ctxC}`);
  else {
    if (ctxB !== undefined) grepFlags.push(`-B ${ctxB}`);
    if (ctxA !== undefined) grepFlags.push(`-A ${ctxA}`);
  }
  if (flags.glob) grepFlags.push(`--include=${shQuote(flags.glob)}`);

  const script = `
cd ${qPath} 2>/dev/null || { echo "__RS_NOPATH__"; exit 0; }
if command -v rg >/dev/null 2>&1; then
  rg ${rgArgs.join(' ')} 2>/dev/null || true
else
  grep ${grepFlags.join(' ')} -e ${qPattern} . 2>/dev/null | sed 's|^\\./||' || true
fi
`.trim();

  const r = await runScript(target, script);
  if (r.stdout.startsWith('__RS_NOPATH__')) {
    return fail(`路径不存在: ${searchPath}`);
  }

  let lines = r.stdout.split('\n').filter((l) => l !== '' && !l.startsWith('__RS_'));

  // 应用 offset + head_limit
  const applyLimit = (arr) => {
    let sliced = offset > 0 ? arr.slice(offset) : arr.slice();
    let appliedLimit;
    if (headLimit !== 0) {
      const lim = headLimit || DEFAULT_HEAD_LIMIT;
      if (sliced.length > lim) {
        appliedLimit = lim;
        sliced = sliced.slice(0, lim);
      }
    }
    return { sliced, appliedLimit };
  };

  if (mode === 'content') {
    const { sliced, appliedLimit } = applyLimit(lines);
    if (sliced.length === 0) {
      return ok({ data: { mode, numLines: 0, content: '' }, text: 'No matches found' });
    }
    const limitInfo = [];
    if (appliedLimit !== undefined) limitInfo.push(`limit: ${appliedLimit}`);
    if (offset > 0) limitInfo.push(`offset: ${offset}`);
    const content = sliced.join('\n');
    const text = limitInfo.length
      ? `${content}\n\n[Showing results with pagination = ${limitInfo.join(', ')}]`
      : content;
    return ok({ data: { mode, numLines: sliced.length, content }, text });
  }

  if (mode === 'count') {
    // 降级路径用 grep -c，会为 0 匹配的文件也输出 "file:0"；
    // ripgrep -c 只列出有匹配的文件，这里过滤掉 :0 行以对齐 CC 行为。
    const nonZero = lines.filter((l) => {
      const idx = l.lastIndexOf(':');
      if (idx <= 0) return false;
      const n = parseInt(l.slice(idx + 1), 10);
      return !isNaN(n) && n > 0;
    });
    const { sliced } = applyLimit(nonZero);
    let total = 0;
    let fileCount = 0;
    for (const l of sliced) {
      const idx = l.lastIndexOf(':');
      const n = parseInt(l.slice(idx + 1), 10);
      total += n;
      fileCount += 1;
    }
    const text = (sliced.join('\n') || 'No matches found') +
      `\n\nFound ${total} total ${total === 1 ? 'occurrence' : 'occurrences'} across ${fileCount} ${fileCount === 1 ? 'file' : 'files'}.`;
    return ok({ data: { mode, numFiles: fileCount, numMatches: total, content: sliced.join('\n') }, text });
  }

  // files_with_matches：按 mtime 倒序（用 perl stat 排序）
  if (lines.length === 0) {
    return ok({ data: { mode, numFiles: 0, filenames: [] }, text: 'No files found' });
  }
  const sortScript = `
cd ${qPath} 2>/dev/null || exit 0
perl -e '
  my @rows;
  while (my $f = <STDIN>) { chomp $f; next if $f eq ""; my @s = stat($f); push @rows, [$f, $s[9] // 0]; }
  for my $r (sort { $b->[1] <=> $a->[1] || $a->[0] cmp $b->[0] } @rows) { print $r->[0], "\\n"; }
' <<'__RS_EOF__'
${lines.join('\n')}
__RS_EOF__
`.trim();
  const sr = await runScript(target, sortScript);
  let sortedFiles = sr.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  if (sortedFiles.length === 0) sortedFiles = lines; // 排序失败兜底

  const { sliced, appliedLimit } = applyLimit(sortedFiles);
  const limitInfo = [];
  if (appliedLimit !== undefined) limitInfo.push(`limit: ${appliedLimit}`);
  if (offset > 0) limitInfo.push(`offset: ${offset}`);
  const head = `Found ${sliced.length} ${sliced.length === 1 ? 'file' : 'files'}${limitInfo.length ? ' ' + limitInfo.join(', ') : ''}`;
  return ok({
    data: { mode, numFiles: sliced.length, filenames: sliced, appliedLimit },
    text: `${head}\n${sliced.join('\n')}`,
  });
}
