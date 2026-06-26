// 统一输出格式：默认人类可读文本，--json 时输出结构化 JSON。
// 工具实现统一调用 ok()/fail()，由主入口决定渲染形式。

let jsonMode = false;

export function setJsonMode(v) {
  jsonMode = !!v;
}

export function isJsonMode() {
  return jsonMode;
}

/**
 * 成功输出。data 用于 JSON 模式，text 用于人类可读模式。
 * exitCode 默认 0；bash 工具可透传远程命令的退出码，使调用方 $? 能反映真实结果。
 */
export function ok({ data, text, exitCode = 0 }) {
  if (jsonMode) {
    process.stdout.write(JSON.stringify({ ok: true, ...data }, null, 2) + '\n');
  } else if (text !== undefined) {
    process.stdout.write(text.endsWith('\n') ? text : text + '\n');
  }
  process.exit(exitCode);
}

/** 失败输出并以非 0 退出。 */
export function fail(message, { data } = {}) {
  if (jsonMode) {
    process.stdout.write(JSON.stringify({ ok: false, error: message, ...data }, null, 2) + '\n');
  } else {
    process.stderr.write(`[error] ${message}\n`);
  }
  process.exit(1);
}

/** 把内容按 Claude Code 风格渲染为带行号的文本（行号右对齐 6 位）。 */
export function withLineNumbers(content, startLine = 1) {
  const lines = content.split('\n');
  // 末尾若有空行（文件以 \n 结尾）去掉一个，避免多出一行空行号
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines
    .map((line, i) => `${String(startLine + i).padStart(6, ' ')}|${line}`)
    .join('\n');
}
