<h1 align="center">Remote Server Skill</h1>

<p align="center">
  <strong>An SSH-based remote toolkit CLI — Claude Code-style primitive tools, executed over SSH.</strong>
</p>

<p align="center">
  <a href="https://github.com/kengerlwl/remote-server-skill/blob/main/LICENSE"><img src="https://img.shields.io/github/license/kengerlwl/remote-server-skill?style=flat-square" alt="License"></a>
  <a href="https://github.com/kengerlwl/remote-server-skill/releases"><img src="https://img.shields.io/github/v/release/kengerlwl/remote-server-skill?style=flat-square" alt="Release"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen?style=flat-square" alt="Node">
</p>

A single CLI that wraps the **Claude Code-style primitive tools** — `bash`, `read`, `write`, `edit`, `ls`, `grep`, `glob`, `download`, `upload` — and runs them **over SSH on a remote server**, exposing clean, predictable tool semantics.

It's designed as an **Agent Skill** (ships with a `SKILL.md`) so AI coding agents like Claude Code, Codex, Cursor, and Gemini CLI can operate remote servers without hand-writing brittle `ssh host "command"` strings. But it's also a perfectly usable standalone CLI for humans.

## Why?

Driving a remote server by having an agent hand-write `ssh host "..."` is fragile: quoting hell, encoding/BOM issues, no line numbers on reads, no atomic edits, no structured output. This CLI fixes that:

- **No escaping hell** — every remote payload is transferred via base64, so quotes/newlines/encoding never break.
- **Claude Code-compatible semantics** — line-numbered `read`, unique-match `edit`, ripgrep-style `grep` with `content/files/count` modes, mtime-sorted `glob`, background `bash` with log tailing.
- **Multi-target** — manage many servers from one JSON config; supports both direct `host/user/port` and `~/.ssh/config` aliases, plus Windows (PowerShell) targets.
- **Zero dependencies** — pure Node.js (built-in modules only) + your system's `ssh`/`scp`.

## Install

```bash
git clone https://github.com/kengerlwl/remote-server-skill.git
cd remote-server-skill
cp targets.example.json targets.json   # then edit with your servers
```

Or, as an Agent Skill, drop the folder into your agent's skills directory (e.g. `~/.claude/skills/remote-server/`) — the agent reads `SKILL.md` automatically.

Requirements: **Node.js ≥ 18**, plus `ssh`/`scp` in your PATH.

## Configure targets

Edit `targets.json` (gitignored, so your real server info stays local):

```jsonc
{
  "default": "myserver",
  "targets": {
    "myserver":    { "host": "1.2.3.4", "user": "root", "shell": "bash" },
    "with-port":   { "host": "host.example.com", "user": "ubuntu", "port": 2222 },
    "via-alias":   { "alias": "my-ssh-config-host" },
    "windows-box": { "alias": "my-windows-host", "shell": "powershell" }
  }
}
```

List them anytime: `node cli/remote-server.mjs targets`.

## Usage

```bash
node cli/remote-server.mjs [--target NAME] [--json] <tool> [args...]
```

| Tool | Example |
|------|---------|
| `bash` | `node cli/remote-server.mjs bash "docker ps"` |
| `read` | `node cli/remote-server.mjs read /etc/hosts --offset 1 --limit 20` |
| `write` | `node cli/remote-server.mjs write /tmp/a.txt --content "hello"` |
| `edit` | `node cli/remote-server.mjs edit /tmp/a.txt --old "hello" --new "world"` |
| `ls` | `node cli/remote-server.mjs ls /var/log --all` |
| `glob` | `node cli/remote-server.mjs glob "*.log" --path /var/log` |
| `grep` | `node cli/remote-server.mjs grep "ERROR" --path /var/log --mode content -C 2` |
| `upload` | `node cli/remote-server.mjs upload ./local.txt /tmp/remote.txt` |
| `download` | `node cli/remote-server.mjs download /tmp/remote.txt ./local.txt` |

Add `--json` to any command for structured output (handy for scripting/agents).

### Tool highlights

- **`bash`** — `--cwd`, `--timeout MS` (default 120s, max 600s), `--background` (returns a runId), `--tail <runId>` to read the background log. Long output is tail-truncated.
- **`read`** — line-numbered output (`   N|content`), `--offset`/`--limit`, binary-file rejection, empty/out-of-range warnings.
- **`edit`** — replaces only on a **unique** match; multiple matches require `--replace-all`; `--old ""` creates a new file. Rejects no-op and not-found edits.
- **`grep` / `glob`** — prefer `ripgrep (rg)` on the remote if present, otherwise fall back to `grep`/`find`.

## How it works

The CLI is a thin local layer. For each tool it generates a small POSIX (or PowerShell) script, **base64-encodes it**, pipes it over `ssh`, and decodes+executes it remotely. File contents are likewise base64-encoded in both directions. Nothing is installed on the remote — it only needs `bash` and standard POSIX utilities (`sed`/`wc`/`find`/`perl`/`base64`).

## Contributing

Issues and PRs welcome. Please keep the CLI dependency-free (Node built-ins only) and preserve the Claude Code-compatible tool contracts.

## License

[MIT](./LICENSE) © kengerlwl
