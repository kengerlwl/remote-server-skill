// edit 工具：精确字符串替换，契约对标 claude-code FileEditTool。
// CLI 内闭环（远程无 readFileState）：
//   1. 读取远程文件全文（base64 回传，避免编码丢失）
//   2. 本地做 old_string 匹配 + 唯一性校验（完全复刻 CC 规则）
//   3. base64 写回
// 规则（与 CC 一致）：
//   - old === new            → 拒绝（No changes to make）
//   - old === '' 且文件不存在 → 创建新文件
//   - old === '' 且文件存在非空 → 拒绝（Cannot create new file）
//   - old 未找到              → 拒绝（String to replace not found）
//   - matches > 1 且 !replace_all → 拒绝（Found N matches）
import { runScript, shQuote } from '../ssh.mjs';
import { ok, fail } from '../output.mjs';

export const usage = `edit <file_path> --old <STR> --new <STR> [--replace-all]
  --old STR        要替换的原字符串（空串表示创建新文件）
  --new STR        替换后的新字符串
  --replace-all    替换所有匹配（默认仅当唯一匹配时才替换）`;

function countOccurrences(haystack, needle) {
  if (needle === '') return 0;
  return haystack.split(needle).length - 1;
}

export async function run(target, positional, flags) {
  const filePath = positional[0];
  if (!filePath) {
    return fail('edit 需要 file_path 参数。\n' + usage);
  }
  const oldString = flags.old !== undefined ? String(flags.old) : undefined;
  const newString = flags.new !== undefined ? String(flags.new) : undefined;
  if (oldString === undefined || newString === undefined) {
    return fail('edit 需要 --old 和 --new 参数。\n' + usage);
  }
  const replaceAll = !!flags['replace-all'];

  if (oldString === newString) {
    return fail('No changes to make: old_string 和 new_string 完全相同。');
  }

  const q = shQuote(filePath);
  // 读取远程文件（base64 回传保编码）；同时报告是否存在。
  const readScript = `
if [ -e ${q} ]; then
  echo "__RS_EXISTS__"
  { base64 ${q} 2>/dev/null || base64 -i ${q}; }
else
  echo "__RS_NOENT__"
fi
`.trim();

  const r = await runScript(target, readScript);
  const exists = r.stdout.startsWith('__RS_EXISTS__');
  const noent = r.stdout.startsWith('__RS_NOENT__');
  if (!exists && !noent) {
    return fail(`读取文件失败: ${r.stderr.trim() || '未知错误'}`);
  }

  let fileContent = '';
  if (exists) {
    const b64body = r.stdout.replace(/^__RS_EXISTS__\n?/, '').replace(/\s+/g, '');
    fileContent = Buffer.from(b64body, 'base64').toString('utf8').replaceAll('\r\n', '\n');
  }

  // --- 新建文件分支 ---
  if (oldString === '') {
    if (noent) {
      return await writeBack(target, filePath, q, newString, 'create');
    }
    if (fileContent.trim() !== '') {
      return fail('Cannot create new file - 文件已存在。');
    }
    // 空文件 + 空 old：用 new 覆盖
    return await writeBack(target, filePath, q, newString, 'update');
  }

  // --- 替换分支 ---
  if (noent) {
    return fail(`文件不存在: ${filePath}`);
  }
  const matches = countOccurrences(fileContent, oldString);
  if (matches === 0) {
    return fail(`String to replace not found in file.\nString: ${oldString}`);
  }
  if (matches > 1 && !replaceAll) {
    return fail(
      `Found ${matches} matches of the string to replace, but replace_all is false. ` +
      `如需全部替换请加 --replace-all，否则请提供更多上下文以唯一定位。\nString: ${oldString}`,
    );
  }

  const updated = replaceAll
    ? fileContent.split(oldString).join(newString)
    : fileContent.replace(oldString, newString);

  return await writeBack(target, filePath, q, updated, 'update', { matches, replaceAll });
}

async function writeBack(target, filePath, q, content, type, extra = {}) {
  const b64 = Buffer.from(content, 'utf8').toString('base64');
  const script = `
set -e
mkdir -p "$(dirname ${q})"
printf %s '${b64}' | { base64 -d 2>/dev/null || base64 -D; } > ${q}
echo "__RS_DONE__"
`.trim();
  const r = await runScript(target, script);
  if (!r.stdout.includes('__RS_DONE__')) {
    return fail(`写回失败: ${r.stderr.trim() || '未知错误'}`);
  }
  const verb = type === 'create' ? '已创建' : '已更新';
  const note = extra.replaceAll ? `（替换了全部 ${extra.matches} 处）` : '';
  return ok({
    data: { type, filePath, ...extra },
    text: `${verb}文件 ${filePath}${note}`,
  });
}
