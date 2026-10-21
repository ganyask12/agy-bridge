// "app" target: runs a task as a real conversation inside the Antigravity desktop app via its
// internal `agentapi` (language_server.exe agentapi). Undocumented; may break on app updates.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function agentapiExe() {
  const p = process.env.AGY_AGENTAPI
    || (process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'antigravity', 'resources', 'bin', 'language_server.exe'));
  if (!p || !fs.existsSync(p)) throw new Error('Antigravity app not found (language_server.exe)');
  return /\.m?js$/.test(p) ? { cmd: process.execPath, prefix: [p] } : { cmd: p, prefix: ['agentapi'] };
}

function run(args, env) {
  const { cmd, prefix } = agentapiExe();
  const r = spawnSync(cmd, [...prefix, ...args], { env: { ...process.env, ...env }, encoding: 'utf8', windowsHide: true, timeout: 60000 });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch { /* not json */ }
  return { code: r.status, json, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// Strips the app's CSRF token from any text that may end up in results, exports or logs.
export const redact = (s) => String(s)
  .replace(/(--csrf_token[=\s]+)\S+/gi, '$1<redacted>')
  .replace(/(ANTIGRAVITY_CSRF_TOKEN=)\S+/gi, '$1<redacted>');

const parseOr = (s, fallback, what) => {
  try {
    return JSON.parse(s || 'null') ?? fallback;
  } catch {
    throw new Error(`could not read ${what}`); // never pass the raw parse error: it quotes the command line
  }
};

const ps = (command) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true, timeout: 20000 }).stdout || '';

// Finds the running app's language server: its CSRF token (from its own command line) and the
// local port agentapi accepts. The token never leaves this process: it is passed to agentapi via env only.
export function discoverLs() {
  if (process.env.ANTIGRAVITY_LS_ADDRESS) {
    return { ANTIGRAVITY_LS_ADDRESS: process.env.ANTIGRAVITY_LS_ADDRESS, ANTIGRAVITY_CSRF_TOKEN: process.env.ANTIGRAVITY_CSRF_TOKEN || '' };
  }
  const procs = parseOr(ps("Get-CimInstance Win32_Process -Filter \"Name='language_server.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"), [], 'the Antigravity process list');
  const list = (Array.isArray(procs) ? procs : [procs]).filter((p) => /--subclient_type\s+hub/.test(p.CommandLine || ''));
  if (!list.length) throw new Error('Antigravity app is not running (no language_server for the app)');
  for (const p of list) {
    const token = (p.CommandLine.match(/--csrf_token[=\s]+(\S+)/) || [])[1] || '';
    const ports = parseOr(ps(`Get-NetTCPConnection -OwningProcess ${p.ProcessId} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort | ConvertTo-Json -Compress`), [], 'the Antigravity ports');
    for (const port of [].concat(ports).sort((a, b) => b - a)) {
      const env = { ANTIGRAVITY_LS_ADDRESS: `127.0.0.1:${port}`, ANTIGRAVITY_CSRF_TOKEN: token };
      const probe = run(['get-conversation-metadata', '00000000-0000-0000-0000-000000000000'], env);
      if (!/not set|connection refused|connect:|dial tcp|unauthenticated|csrf/i.test(probe.stdout + probe.stderr)) return env;
    }
  }
  throw new Error('could not reach the Antigravity app language server through agentapi');
}

const folderOf = (r) => r?.folderUri || r?.gitFolder?.folderUri;
const norm = (p) => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();

// Picks the app project a conversation lands in: config `app_project` (id or name), else the
// project whose folder contains cwd, else the app's "CLI Project".
export function pickProject(cwd, wanted) {
  const dir = process.env.AGY_PROJECTS_DIR || path.join(process.env.USERPROFILE || '', '.gemini', 'config', 'projects');
  let projects = [];
  try {
    projects = fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  } catch { /* no projects */ }
  if (wanted) {
    const p = projects.find((x) => x.id === wanted || x.name === wanted);
    if (p) return p;
  }
  const c = norm(cwd);
  const hit = projects
    .flatMap((p) => (p.projectResources?.resources || []).map((r) => ({ p, folder: folderOf(r) })))
    .filter((x) => x.folder)
    .map((x) => ({ ...x, f: norm(fileURLToPath(x.folder)) }))
    .filter((x) => c === x.f || c.startsWith(`${x.f}\\`))
    .sort((a, b) => b.f.length - a.f.length)[0];
  return hit?.p || projects.find((x) => x.id === 'default-cli-project') || { id: 'default-cli-project', name: 'CLI Project' };
}

export function newConversation(env, { prompt, title, model }) {
  const args = ['new-conversation'];
  if (model) args.push(`--model=${model}`);
  if (title) args.push(`--title=${title}`);
  args.push(prompt);
  const r = run(args, env);
  const id = r.json?.response?.newConversation?.conversationId;
  if (!id) throw new Error(redact(`agentapi new-conversation failed: ${(r.stdout + r.stderr).trim().slice(-400)}`));
  return id;
}

export function sendMessage(env, conversationId, content) {
  const r = run(['send-message', conversationId, content], env);
  if (r.code !== 0) throw new Error(redact(`agentapi send-message failed: ${(r.stdout + r.stderr).trim().slice(-400)}`));
}

export function appPrompt(task, resultFile) {
  return `${task}

When you are completely finished, as your very last action write a JSON file to ${resultFile} with exactly these fields:
{"status": "done" | "needs_approval" | "blocked" | "failed", "summary": "<the actual answer or findings, under 150 words>", "files_changed": ["<paths you created or modified>"], "commands_requested": [], "followups": ["<anything still open>"], "handoff_notes": "<state and decisions>"}
Write valid JSON only. This file is how your result is delivered; the task is not done until it exists.`;
}
