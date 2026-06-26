// SSH 核心库：负责 target 解析、SSH 命令构造、远程执行、base64 安全传输。
// 设计原则：所有要在远程执行的脚本一律走 base64 编码传输，
// 彻底规避多层引号嵌套与编码（BOM/转义）地狱。

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = join(__dirname, '..', '..');
// 用户的真实配置（gitignore，不入库）；缺省时回退到随仓库分发的示例配置。
const TARGETS_PATH = join(SKILL_ROOT, 'targets.json');
const TARGETS_EXAMPLE_PATH = join(SKILL_ROOT, 'targets.example.json');

let _config = null;

/**
 * 读取并缓存 target 配置。
 * 优先读用户本地的 targets.json；不存在则回退到 targets.example.json。
 */
export function loadConfig() {
  if (_config) {
    return _config;
  }
  const path = existsSync(TARGETS_PATH) ? TARGETS_PATH : TARGETS_EXAMPLE_PATH;
  try {
    _config = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(
      `无法读取 target 配置。请复制 targets.example.json 为 targets.json 并填入你的服务器信息。原因: ${e.message}`,
    );
  }
  return _config;
}

/** 解析 target 名称为连接定义，未指定时回退到 default。 */
export function resolveTarget(name) {
  const cfg = loadConfig();
  const targetName = name || cfg.default;
  if (!targetName) {
    throw new Error('未指定 target，且 targets.json 未配置 default');
  }
  const target = cfg.targets[targetName];
  if (!target) {
    const available = Object.keys(cfg.targets).join(', ');
    throw new Error(`未知 target "${targetName}"，可用: ${available}`);
  }
  return { name: targetName, ...target };
}

/** 列出所有可用 target（供 CLI list 子命令使用）。 */
export function listTargets() {
  const cfg = loadConfig();
  return Object.entries(cfg.targets).map(([name, t]) => ({
    name,
    description: t.description || '',
    isDefault: name === cfg.default,
    shell: t.shell || 'bash',
  }));
}

/**
 * 构造 ssh 命令的参数数组（不含远程要执行的命令本身）。
 * 支持两种连接模式：
 *  - alias 模式：直接用 ~/.ssh/config 里的别名
 *  - host/user/port 模式：显式拼接
 */
function buildSshBaseArgs(target) {
  const args = [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=15',
    '-o', 'StrictHostKeyChecking=accept-new',
  ];
  if (target.alias) {
    args.push(target.alias);
    return args;
  }
  if (target.port) {
    args.push('-p', String(target.port));
  }
  if (!target.host) {
    throw new Error(`target "${target.name}" 缺少 host 或 alias 配置`);
  }
  const userHost = target.user ? `${target.user}@${target.host}` : target.host;
  args.push(userHost);
  return args;
}

/** 构造 scp 命令的目标前缀与端口参数。 */
export function buildScpParts(target) {
  const portArgs = [];
  let remotePrefix;
  if (target.alias) {
    remotePrefix = target.alias;
  } else {
    if (target.port) {
      portArgs.push('-P', String(target.port));
    }
    remotePrefix = target.user ? `${target.user}@${target.host}` : target.host;
  }
  return { portArgs, remotePrefix };
}

/**
 * 执行一个进程并收集 stdout/stderr。
 * @returns {Promise<{code:number, stdout:string, stderr:string}>}
 */
function execProcess(cmd, args, { input, timeoutMs } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let timer = null;

    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);
    }

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + `\n[spawn error] ${err.message}` });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (timedOut) {
        resolve({ code: 124, stdout, stderr: stderr + `\n[timeout] 命令超过 ${timeoutMs}ms 被终止` });
      } else {
        resolve({ code: code ?? 0, stdout, stderr });
      }
    });

    if (input !== undefined) {
      child.stdin.write(input);
    }
    child.stdin.end();
  });
}

/**
 * 在远程执行一段脚本（自动 base64 编码传输）。
 * bash 目标：echo <b64> | base64 -d | bash
 * powershell 目标：powershell -EncodedCommand <utf16le-b64>
 */
export async function runScript(target, script, { timeoutMs } = {}) {
  const baseArgs = buildSshBaseArgs(target);
  const shell = target.shell || 'bash';

  let remoteCmd;
  if (shell === 'powershell') {
    // PowerShell -EncodedCommand 要求 UTF-16LE + Base64
    const b64 = Buffer.from(script, 'utf16le').toString('base64');
    remoteCmd = `powershell -NoProfile -NonInteractive -EncodedCommand ${b64}`;
  } else {
    // bash/sh：base64 解码后用 bash 执行，规避所有引号问题。
    // base64 解码选项跨平台不一致：GNU(Linux)=-d，BSD(macOS)=-D。
    // 用 `base64 -d 2>/dev/null || base64 -D` 兜底，两种平台都能解。
    const b64 = Buffer.from(script, 'utf8').toString('base64');
    remoteCmd = `printf %s ${b64} | { base64 -d 2>/dev/null || base64 -D; } | bash`;
  }

  const args = [...baseArgs, remoteCmd];
  return execProcess('ssh', args, { timeoutMs });
}

/** 直接执行原始 ssh（用于无需脚本封装的简单场景，谨慎使用）。 */
export async function runRaw(target, remoteCmd, { timeoutMs } = {}) {
  const baseArgs = buildSshBaseArgs(target);
  const args = [...baseArgs, remoteCmd];
  return execProcess('ssh', args, { timeoutMs });
}

/** 执行本地 scp 命令。 */
export async function runScp(scpArgs, { timeoutMs } = {}) {
  const args = [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=15',
    '-o', 'StrictHostKeyChecking=accept-new',
    ...scpArgs,
  ];
  return execProcess('scp', args, { timeoutMs });
}

/** shell 单引号安全转义（用于在 bash 脚本里嵌入路径等）。 */
export function shQuote(str) {
  return `'${String(str).replace(/'/g, `'\\''`)}'`;
}
