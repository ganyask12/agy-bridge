# agy-bridge

MCP server: Claude delegates tasks to the Antigravity CLI (`agy`) and gets a compact result back.

Windows-only. Tested with `agy` 1.4.0, Antigravity desktop 2.23.1, Node 22, Claude Code and Claude Desktop. Unofficial and not affiliated with Google or Anthropic.

## Install

1. `agy` CLI: `irm https://antigravity.google/cli/install.ps1 | iex`, then sign in once (`agy`).
2. `npm install` in this folder.
3. Claude Code: `claude mcp add --scope user agy-bridge -- node "<this folder>\src\server.mjs"`
4. Claude Desktop: add to `%APPDATA%\Claude\claude_desktop_config.json` under `mcpServers`
   `"agy-bridge": { "command": "<path to node.exe>", "args": ["<this folder>\\src\\server.mjs"] }`, then restart Desktop.

## Tools

| Tool | Use |
|---|---|
| `agy_start` | start a job (`kind` read/edit, `tier` fast/balanced/deep, `continue_job`, `handoff_from`) |
| `agy_wait` | wait up to 50 s, returns the compact result or `running` |
| `agy_result` | `detail:"full"` adds the raw agy response |
| `agy_run_approved` | run commands agy asked for (you pick indexes), then continue its conversation |
| `agy_cancel` | kill a job |
| `agy_list` | jobs and token totals |

## How it behaves

- `read` runs `agy --mode plan` (no writes, no shell). `edit` runs `--mode accept-edits` (file writes).
- Headless agy cannot ask for permission (official docs: no interactive prompt, no approval over stream-json input). Anything outside your own agy allow-rules is auto-denied. The bridge runs agy with `--output-format stream-json`, reads the exact denied command (`run_command.CommandLine`) from the event stream and returns it as `commands_requested` (`status: needs_approval`), with no second model call. Denied file actions (e.g. a write in a `read` job) come back as `denied_files`; re-run with `kind: "edit"` if appropriate. Approved commands run via `agy_run_approved`, and their output is fed back into the same conversation. Commands already in your agy allow-list still run on their own.
- Results use `--json-schema`: `status, summary, files_changed, commands_requested, followups, handoff_notes`, plus token usage. `handoff_recommended` is set when one call used more than `handoff_threshold_tokens` input tokens.
- Every finished job is also written as `<export_dir>\<job id>.md` (default `%LOCALAPPDATA%\agy-bridge\exports`, plus `INDEX.md`). This is the reliable way to read results in Antigravity: open that folder as a project folder (Settings > project > Add Folder). Config keys: `export_markdown`, `export_dir`.
- Jobs run in a detached process and survive a server restart. State lives in `%LOCALAPPDATA%\agy-bridge` (override with `AGY_BRIDGE_HOME`): `jobs\<id>\`, `usage.jsonl`, optional `config.json` (same keys as `config.default.json`).
- After each finished job the bridge copies its conversation (`.db`, annotation, `brain\`) from `~\.gemini\antigravity-cli` into `~\.gemini\antigravity`, so it shows in the Antigravity app (under "CLI Project"); the app picks it up after a restart. It only adds files, never touches the app's index, and never overwrites an app copy it did not create or that changed since its last copy (state in `app-sync.json`). Turn off with `"sync_to_app": false` in `%LOCALAPPDATA%\agy-bridge\config.json`. This relies on the app's undocumented storage layout and may stop working after an Antigravity update.
- This bridge never edits `~\.gemini\config\config.json`.

## App mode (`target: "app"`, opt-in)

Runs the task as a real conversation inside the running Antigravity desktop app, so you can watch and open it there. It uses the app's internal `agentapi` (`language_server.exe agentapi new-conversation / send-message`). To reach it, the bridge reads the app language server's local CSRF token from that process's command line and passes it to agentapi through an environment variable only (never logged or returned). The same approach is used by naksh-07/antigravity-mcp-bridge.

Trade-offs: the task runs with the app's own permissions (e.g. Turbo, commands auto-run without Claude's approval), there is no per-job token usage, and it relies on an undocumented interface that can break after an Antigravity update. The app agent delivers its result by writing `agent_result.json` into the job folder; if it never does, the job fails after `timeout_s` while the conversation may still be running in the app. Model tiers map to `app_tiers` (`flash`/`pro`). Set `"default_target": "app"` to make it the default. `model: "app"` / `"app:pro"` is a shortcut for `target: "app"` (useful when a client still has the old tool schema cached). The conversation lands in the app project whose folder contains `cwd`, otherwise in "CLI Project"; force one with `"app_project": "<name or id>"`. The Antigravity app must be running.

`sync_to_app` (copying CLI conversations into the app store) is off by default: copied conversations appeared in the app's list but did not open.

## Test

`npm test` (fake agy). `node test/live.mjs` runs a real smoke test against agy.
