#!/usr/bin/env node
// remote-server CLI 主入口。
// 把 claude-code 风格的基础工具（bash/read/write/edit/ls/grep/glob/download/upload）
// 通过 SSH 在远程服务器上执行，对上层暴露干净的工具语义。
//
// 用法:
//   remote-server [--target NAME] [--json] <tool> [args...]
//   remote-server targets            列出所有可用 target
//   remote-server help [tool]        查看帮助
//
// 全局参数:
//   --target NAME   指定远程服务器（见 targets.json，缺省用 default）
//   --json          以 JSON 结构化输出（默认人类可读文本）

import { resolveTarget, listTargets } from './lib/ssh.mjs';
import { setJsonMode, fail } from './lib/output.mjs';
import * as bashTool from './lib/tools/bash.mjs';
import * as readTool from './lib/tools/read.mjs';
import * as writeTool from './lib/tools/write.mjs';
import * as editTool from './lib/tools/edit.mjs';
import * as lsTool from './lib/tools/ls.mjs';
import * as globTool from './lib/tools/glob.mjs';
import * as grepToolReal from './lib/tools/grep.mjs';
import * as transferTool from './lib/tools/transfer.mjs';

// 已知 flag 是否带值。布尔型 flag 不消费下一个参数。
const BOOLEAN_FLAGS = new Set([
  'json', 'background', 'all', 'replace-all', 'stdin', 'i', 'no-line-number',
]);

/**
 * 解析 argv：分离全局参数、tool 名、位置参数与 flag。
 * 规则：
 *   --key value  → flags.key = value（除非是布尔 flag）
 *   --key        → flags.key = true（布尔 flag）
 *   -X value     → flags.X = value（短选项，如 -A 3）；-i 为布尔
 *   其余         → positional
 */
function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (BOOLEAN_FLAGS.has(key)) {
        flags[key] = true;
      } else {
        flags[key] = argv[++i];
      }
    } else if (a.startsWith('-') && a.length === 2 && /[A-Za-z]/.test(a[1])) {
      const key = a[1];
      if (key === 'i') {
        flags[key] = true;
      } else {
        flags[key] = argv[++i];
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

function printHelp(tool) {
  const helps = {
    bash: bashTool.usage,
    read: readTool.usage,
    write: writeTool.usage,
    edit: editTool.usage,
    ls: lsTool.usage,
    glob: globTool.usage,
    grep: grepToolReal.usage,
    upload: transferTool.uploadUsage,
    download: transferTool.downloadUsage,
  };
  if (tool && helps[tool]) {
    process.stdout.write(helps[tool] + '\n');
    return;
  }
  process.stdout.write(`remote-server — 基于 SSH 的远程工具 CLI

用法:
  remote-server [--target NAME] [--json] <tool> [args...]

全局参数:
  --target NAME   指定远程服务器（见 targets.json，缺省用 default）
  --json          JSON 结构化输出

工具:
  bash <command>                 远程执行命令（支持 --background/--tail/--timeout/--cwd）
  read <file> [--offset --limit] 读取文件（带行号）
  write <file> [content]         写入文件（--content/--stdin/--file）
  edit <file> --old --new        精确替换（--replace-all）
  ls [path] [--all]              列出目录
  glob <pattern> [--path]        按文件名查找（按 mtime 排序）
  grep <pattern> [--mode]        内容搜索（content/files/count）
  upload <local> <remote>        上传文件
  download <remote> <local>      下载文件

其他:
  remote-server targets          列出所有可用 target
  remote-server help [tool]      查看工具帮助
`);
}

async function main() {
  // 先抽出全局参数（--target / --json），它们可以出现在 tool 之前
  const raw = process.argv.slice(2);
  let target = undefined;
  let json = false;
  const rest = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '--target') {
      target = raw[++i];
    } else if (raw[i] === '--json') {
      json = true;
    } else {
      rest.push(raw[i]);
    }
  }

  setJsonMode(json);

  const tool = rest.shift();

  if (!tool || tool === 'help') {
    printHelp(rest[0]);
    process.exit(0);
  }

  if (tool === 'targets') {
    const list = listTargets();
    if (json) {
      process.stdout.write(JSON.stringify({ ok: true, targets: list }, null, 2) + '\n');
    } else {
      const lines = list.map((t) =>
        `${t.isDefault ? '*' : ' '} ${t.name.padEnd(12)} [${t.shell}] ${t.description}`);
      process.stdout.write('可用 targets（* = 默认）:\n' + lines.join('\n') + '\n');
    }
    process.exit(0);
  }

  let resolved;
  try {
    resolved = resolveTarget(target);
  } catch (e) {
    return fail(e.message);
  }

  const { flags, positional } = parseArgs(rest);

  try {
    switch (tool) {
      case 'bash': return await bashTool.run(resolved, positional, flags);
      case 'read': return await readTool.run(resolved, positional, flags);
      case 'write': return await writeTool.run(resolved, positional, flags);
      case 'edit': return await editTool.run(resolved, positional, flags);
      case 'ls': return await lsTool.run(resolved, positional, flags);
      case 'glob': return await globTool.run(resolved, positional, flags);
      case 'grep': return await grepToolReal.run(resolved, positional, flags);
      case 'upload': return await transferTool.runUpload(resolved, positional, flags);
      case 'download': return await transferTool.runDownload(resolved, positional, flags);
      default:
        return fail(`未知工具: ${tool}。运行 'remote-server help' 查看可用工具。`);
    }
  } catch (e) {
    return fail(`工具执行异常: ${e.message}`);
  }
}

main();
