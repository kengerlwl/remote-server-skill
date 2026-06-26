---
name: remote-server
description: "SSH-based remote server toolkit CLI. Wraps Claude Code-style primitive tools (bash/read/write/edit/ls/grep/glob/download/upload) into a single command line that executes over SSH on remote servers, exposing clean, predictable tool semantics. Multi-target management via a simple JSON config. Use when you need to run commands, read/write/edit files, search content, find files, or transfer files on a remote server over SSH, or when the user mentions 'operate a remote server', 'read/edit a remote file', 'remote-server', or 'run a command on the server'."
---

# Remote Server — SSH Remote Toolkit CLI

Wraps Claude Code-style primitive tools (line-numbered `read`, exact-match `edit`, ripgrep-style `grep`, etc.) into a single local CLI that runs everything over SSH on a remote server. **Prefer this CLI over hand-writing `ssh host "command"`** — it transfers payloads via base64 to completely avoid quoting/encoding/escaping hell, and gives structured, predictable tool behavior.

## Setup

1. Requires local **Node.js 18+** and `ssh`/`scp` in PATH. No third-party dependencies.
2. Copy `targets.example.json` to `targets.json` and fill in your servers:

```bash
cp targets.example.json targets.json
```

`targets.json` is gitignored — your real server info never gets committed. Each target supports two connection styles:

```jsonc
{
  "default": "myserver",
  "targets": {
    "myserver": { "host": "1.2.3.4", "user": "root", "shell": "bash" },
    "with-port": { "host": "host.example.com", "user": "ubuntu", "port": 2222 },
    "via-alias": { "alias": "my-ssh-config-host", "shell": "bash" },
    "windows-box": { "alias": "my-windows-host", "shell": "powershell" }
  }
}
```

- `host` + `user` (+ optional `port`) for direct connection, **or** `alias` to reuse an entry from `~/.ssh/config`.
- `shell: "powershell"` for Windows targets (defaults to `bash`).

## Usage

```bash
node <SKILL_DIR>/cli/remote-server.mjs [--target NAME] [--json] <tool> [args...]
```

- `<SKILL_DIR>` is this skill's directory.
- `--target NAME`: which server (defaults to the `default` in `targets.json`).
- `--json`: structured JSON output (default is human-readable text).
- `node cli/remote-server.mjs targets` lists all configured targets.

## Tools

| Tool | Purpose | Key behavior |
|------|---------|--------------|
| `bash <command>` | Run a command | `--cwd` working dir; `--timeout MS` (default 120s, max 600s); `--background` returns a runId; `--tail <runId>` reads background log; long output keeps the tail |
| `read <file>` | Read a file | Line-numbered output `   N\|content`; `--offset N` (1-indexed) `--limit N`; rejects binary files; warns on empty file / out-of-range offset |
| `write <file>` | Write a file | content from positional / `--content` / `--stdin` / `--file`; auto-creates parent dirs; reports create vs update; base64 transfer |
| `edit <file>` | Exact replace | `--old` `--new`; replaces only on a unique match, multiple matches require `--replace-all`; `--old ""` creates a new file; rejects when old==new or not found |
| `ls [path]` | List a directory | `--all` includes hidden files |
| `glob <pattern>` | Find files by name | `--path` dir; `--limit` (default 100); sorted by mtime desc; prefers `rg`, falls back to `find` |
| `grep <pattern>` | Search file contents | `--mode content/files/count` (default files); `-i`; `-A/-B/-C` context; `--glob`/`--type` filters; `--head-limit` (default 250)/`--offset` pagination; prefers `rg`, falls back to `grep` |
| `upload <local> <remote>` | Upload | via `scp -r` |
| `download <remote> <local>` | Download | via `scp -r` |

## Examples

```bash
# Check docker status on the default target
node cli/remote-server.mjs bash "docker ps"

# Read lines 50-80 of a remote file
node cli/remote-server.mjs --target myserver read /root/app/config.yml --offset 50 --limit 31

# Precisely change one line (unique match)
node cli/remote-server.mjs --target myserver edit /root/app/.env --old "DEBUG=true" --new "DEBUG=false"

# Search file contents (content mode with context)
node cli/remote-server.mjs --target myserver grep "ERROR" --path /root/logs --mode content -C 2

# Run a long command in the background and tail its log
node cli/remote-server.mjs --target myserver bash "npm run build" --background   # returns runId
node cli/remote-server.mjs --target myserver bash --tail <runId>
```

## Rules

1. **Prefer this CLI over raw ssh** — especially for reading/writing/editing files and searching; behavior is predictable with no escaping pitfalls.
2. **Editing large files**: `read` first to see context, then `edit` with a precise match. For multiple matches, add more surrounding context to make it unique rather than blindly using `--replace-all`.
3. **Writing large/multiline content**: use `--stdin` or `--file` instead of a huge positional argument.
4. **Windows targets** (`shell: powershell`): `bash`/`read`/`write`/`edit`/`ls` adapt automatically; `grep`/`glob` rely on POSIX tools and may be unavailable on Windows — for those cases run PowerShell directly via `bash`.
5. **Connection failures**: verify the server is reachable and your SSH key/config is set up.

## Dependencies

- Local: Node.js 18+ (no third-party packages), `ssh`/`scp`.
- Remote: `bash` + basic POSIX tools (`sed`/`wc`/`find`/`perl`/`base64`). `grep`/`glob` work better if `ripgrep (rg)` is installed remotely, otherwise they fall back automatically.
