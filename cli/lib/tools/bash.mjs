// bash 工具：在远程执行命令，契约对标 claude-code BashTool。
//  - 默认超时 120s，最大 600s（--timeout 覆盖，单位 ms，封顶 maxTimeout）
//  - --cwd 指定工作目录
//  - --background 后台运行：远程 nohup 重定向到日志文件，返回 runId
//  - --tail <runId> 读取后台命令日志
//  - 输出超过上限时截断（保留尾部，对标 EndTruncatingAccumulator）
import { runScript, runRaw, shQuote } from '../ssh.mjs';
import { ok, fail } from '../output.mjs';

export const usage = `bash <command> [--cwd DIR] [--timeout MS] [--background]
  --cwd DIR        远程工作目录
  --timeout MS     超时毫秒（默认 120000，最大 600000）
  --background     后台运行，返回 runId（用 --tail 读日志）
  --tail <runId>   读取后台命令日志`;

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_CHARS = 30_000; // 输出截断阈值

function genRunId() {
  return `rs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function truncateTail(s, max) {
  if (s.length <= max) return { text: s, truncated: false };
  const kept = s.slice(s.length - max);
  return { text: kept, truncated: true };
}

export async function run(target, positional, flags) {
  const shell = target.shell || 'bash';

  // --- --tail：读取后台日志 ---
  if (flags.tail) {
    const runId = String(flags.tail);
    if (!/^rs-[0-9]+-[a-z0-9]+$/.test(runId)) {
      return fail(`非法 runId: ${runId}`);
    }
    if (shell === 'powershell') {
      const psScript = `Get-Content -Raw -Path "$env:TEMP\\${runId}.log" -ErrorAction SilentlyContinue`;
      const r = await runScript(target, psScript);
      return ok({ data: { runId, log: r.stdout }, text: r.stdout || '(空日志)' });
    }
    const script = `cat /tmp/${runId}.log 2>/dev/null || echo "(日志不存在: ${runId})"`;
    const r = await runScript(target, script);
    return ok({ data: { runId, log: r.stdout }, text: r.stdout });
  }

  const command = positional.join(' ');
  if (!command) {
    return fail('bash 需要一个命令参数。\n' + usage);
  }

  const cwd = flags.cwd;
  let timeoutMs = flags.timeout ? Number(flags.timeout) : DEFAULT_TIMEOUT_MS;
  if (timeoutMs > MAX_TIMEOUT_MS) timeoutMs = MAX_TIMEOUT_MS;

  // --- 后台运行 ---
  if (flags.background) {
    const runId = genRunId();
    if (shell === 'powershell') {
      const cmdEsc = command.replace(/'/g, "''");
      const cd = cwd ? `Set-Location -LiteralPath '${cwd.replace(/'/g, "''")}'; ` : '';
      const psScript = `${cd}Start-Job -ScriptBlock { ${cmdEsc} } *>&1 | Out-File -FilePath "$env:TEMP\\${runId}.log"; Write-Output '${runId}'`;
      const r = await runScript(target, psScript);
      return ok({
        data: { runId, background: true },
        text: `已在后台启动，runId=${runId}\n用 'bash --tail ${runId}' 查看日志`,
      });
    }
    // bash：cd + nohup，输出重定向到 /tmp/<runId>.log
    const cdPart = cwd ? `cd ${shQuote(cwd)} && ` : '';
    // 命令本身用 base64 内嵌，避免引号问题
    const cmdB64 = Buffer.from(command, 'utf8').toString('base64');
    const script = `
${cdPart}nohup bash -c "$(printf %s '${cmdB64}' | { base64 -d 2>/dev/null || base64 -D; })" > /tmp/${runId}.log 2>&1 &
echo "${runId}"
`.trim();
    await runScript(target, script);
    return ok({
      data: { runId, background: true },
      text: `已在后台启动，runId=${runId}\n用 'bash --tail ${runId}' 查看日志`,
    });
  }

  // --- 前台运行（带超时）---
  let r;
  if (shell === 'powershell') {
    const cd = cwd ? `Set-Location -LiteralPath '${cwd.replace(/'/g, "''")}'; ` : '';
    r = await runScript(target, cd + command, { timeoutMs });
  } else {
    const cdPart = cwd ? `cd ${shQuote(cwd)} && ` : '';
    r = await runScript(target, cdPart + command, { timeoutMs });
  }

  const combined = r.stdout + (r.stderr ? (r.stdout ? '\n' : '') + r.stderr : '');
  const { text, truncated } = truncateTail(combined, MAX_OUTPUT_CHARS);
  const prefix = truncated ? '[输出过长，已保留尾部内容]\n' : '';
  const body = (prefix + text).trim();

  // 透传远程命令退出码，使调用方用 $? 判断远程命令成败时不被误导。
  return ok({
    data: { exitCode: r.code, stdout: r.stdout, stderr: r.stderr, truncated },
    text: body || `(无输出，退出码 ${r.code})`,
    exitCode: r.code,
  });
}
