// write 工具：写入远程文件，契约对标 claude-code FileWriteTool。
//  - 入参 file_path + content（content 经本地 base64 编码后传输，规避转义/BOM）
//  - 自动创建父目录
//  - 区分 create / update
// content 来源：positional[1] 或 --content，或 --stdin 从标准输入读取（适合大文件/多行）
import { runScript, shQuote } from '../ssh.mjs';
import { ok, fail } from '../output.mjs';
import { readFileSync } from 'node:fs';

export const usage = `write <file_path> [content] [--content STR] [--stdin] [--file LOCAL]
  content 可由位置参数、--content、--stdin(读标准输入) 或 --file(读本地文件) 提供`;

export async function run(target, positional, flags) {
  const filePath = positional[0];
  if (!filePath) {
    return fail('write 需要 file_path 参数。\n' + usage);
  }

  let content;
  if (flags.stdin) {
    content = readFileSync(0, 'utf8');
  } else if (flags.file) {
    content = readFileSync(flags.file, 'utf8');
  } else if (flags.content !== undefined) {
    content = String(flags.content);
  } else if (positional[1] !== undefined) {
    content = positional[1];
  } else {
    content = '';
  }

  const b64 = Buffer.from(content, 'utf8').toString('base64');
  const q = shQuote(filePath);
  // 远程：判断文件原本是否存在（决定 create/update），建父目录，再 base64 解码写入。
  const script = `
set -e
if [ -e ${q} ]; then echo "__RS_EXISTS__"; else echo "__RS_NEW__"; fi
mkdir -p "$(dirname ${q})"
printf %s '${b64}' | { base64 -d 2>/dev/null || base64 -D; } > ${q}
echo "__RS_DONE__"
`.trim();

  const r = await runScript(target, script);
  if (!r.stdout.includes('__RS_DONE__')) {
    return fail(`写入失败: ${r.stderr.trim() || '未知错误'}`);
  }
  const type = r.stdout.includes('__RS_NEW__') ? 'create' : 'update';
  const verb = type === 'create' ? '已创建' : '已更新';
  return ok({
    data: { type, filePath, bytes: Buffer.byteLength(content, 'utf8') },
    text: `${verb}文件 ${filePath}（${Buffer.byteLength(content, 'utf8')} 字节）`,
  });
}
