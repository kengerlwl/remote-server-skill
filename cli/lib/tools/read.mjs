// read 工具：读取远程文件，契约对标 claude-code FileReadTool。
//  - offset(1-indexed 起始行) / limit(行数)
//  - 输出带行号，格式 `   123|content`（行号右对齐 6 位），行号从 offset 接续
//  - 二进制扩展名拦截
//  - 空文件 / offset 越界 给出 system-reminder 风格提示
import { runScript } from '../ssh.mjs';
import { ok, fail, withLineNumbers } from '../output.mjs';
import { shQuote } from '../ssh.mjs';

export const usage = `read <file_path> [--offset N] [--limit N]
  --offset N   起始行号(1-indexed)
  --limit N    读取行数`;

// 二进制扩展名（对标 CC hasBinaryExtension 的常见集合）。
const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'tiff',
  'pdf', 'zip', 'gz', 'tar', 'rar', '7z', 'bz2', 'xz',
  'exe', 'dll', 'so', 'dylib', 'bin', 'o', 'a', 'class', 'jar',
  'mp3', 'mp4', 'avi', 'mov', 'mkv', 'flv', 'wav', 'ogg',
  'woff', 'woff2', 'ttf', 'eot', 'otf',
  'pyc', 'pyo', 'wasm', 'db', 'sqlite', 'sqlite3',
]);

function extOf(p) {
  const base = p.split('/').pop() || '';
  const idx = base.lastIndexOf('.');
  return idx > 0 ? base.slice(idx + 1).toLowerCase() : '';
}

export async function run(target, positional, flags) {
  const filePath = positional[0];
  if (!filePath) {
    return fail('read 需要 file_path 参数。\n' + usage);
  }

  const ext = extOf(filePath);
  if (BINARY_EXTENSIONS.has(ext)) {
    return fail(`无法读取二进制文件（.${ext}）。如需传输请用 download 工具。`);
  }

  const offset = flags.offset ? Math.max(1, parseInt(flags.offset, 10)) : 1;
  const limit = flags.limit ? parseInt(flags.limit, 10) : undefined;

  const q = shQuote(filePath);
  // 远程脚本：先判存在性/类型，再统计总行数，最后按 offset/limit 截取。
  // 用 sed -n 'start,endp' 截取指定行区间。
  const startLine = offset;
  const endExpr = limit ? `${startLine + limit - 1}` : '$';
  const script = `
set -e
if [ ! -e ${q} ]; then echo "__RS_NOENT__"; exit 0; fi
if [ -d ${q} ]; then echo "__RS_ISDIR__"; exit 0; fi
total=$(wc -l < ${q} 2>/dev/null | tr -d ' ')
# wc -l 统计换行数，若文件非空但无末尾换行，实际行数 = total + 1
last_char=$(tail -c 1 ${q} 2>/dev/null | od -An -c | tr -d ' ')
size=$(wc -c < ${q} 2>/dev/null | tr -d ' ')
echo "__RS_META__ total=$total size=$size"
sed -n '${startLine},${endExpr}p' ${q}
`.trim();

  const r = await runScript(target, script);
  if (r.code !== 0 && !r.stdout.includes('__RS_META__')) {
    return fail(`读取失败: ${r.stderr.trim() || '未知错误'}`);
  }

  const lines = r.stdout.split('\n');
  // 解析控制标记
  if (lines[0] === '__RS_NOENT__') {
    return fail(`文件不存在: ${filePath}`);
  }
  if (lines[0] === '__RS_ISDIR__') {
    return fail(`这是一个目录，不是文件: ${filePath}。请用 ls 工具。`);
  }

  let total = 0;
  let size = 0;
  let bodyStart = 0;
  const metaLine = lines.find((l) => l.startsWith('__RS_META__'));
  if (metaLine) {
    const m = metaLine.match(/total=(\d+) size=(\d+)/);
    if (m) {
      total = parseInt(m[1], 10);
      size = parseInt(m[2], 10);
    }
    bodyStart = lines.indexOf(metaLine) + 1;
  }
  // wc -l 是换行计数；文件非空时真实行数至少为 total（无末尾换行则 +1）。
  const totalLines = size === 0 ? 0 : total + 1;

  const bodyLines = lines.slice(bodyStart);
  // sed 输出末尾可能带一个空串（split 产生），去掉
  if (bodyLines.length > 0 && bodyLines[bodyLines.length - 1] === '') {
    bodyLines.pop();
  }
  const content = bodyLines.join('\n');

  if (size === 0) {
    return ok({
      data: { filePath, totalLines: 0, content: '' },
      text: '<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>',
    });
  }

  if (bodyLines.length === 0) {
    return ok({
      data: { filePath, totalLines, startLine: offset, content: '' },
      text: `<system-reminder>Warning: the file exists but is shorter than the provided offset (${offset}). The file has ${totalLines} lines.</system-reminder>`,
    });
  }

  const numbered = withLineNumbers(content, offset);
  return ok({
    data: {
      filePath,
      totalLines,
      startLine: offset,
      numLines: bodyLines.length,
      content,
    },
    text: numbered,
  });
}
