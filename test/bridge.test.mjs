import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-bridge-test-'));
const fakeBin = path.join(here, 'fake-agy.mjs');

const cliDir = path.join(home, 'cli');
const appDir = path.join(home, 'app');
for (const d of ['conversations', 'annotations', 'brain']) {
  fs.mkdirSync(path.join(cliDir, d), { recursive: true });
  fs.mkdirSync(path.join(appDir, d), { recursive: true });
}
fs.writeFileSync(path.join(cliDir, 'conversations', 'conv-new.db'), 'v1');
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ sync_to_app: true }));
fs.mkdirSync(path.join(cliDir, 'brain', 'conv-new'), { recursive: true });
fs.writeFileSync(path.join(cliDir, 'brain', 'conv-new', 'log.txt'), 'x');

let client;
before(async () => {
  client = new Client({ name: 't', version: '0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [path.join(here, '..', 'src', 'server.mjs')],
    env: {
      ...process.env, AGY_BRIDGE_HOME: home, AGY_BIN: fakeBin, AGY_CLI_DIR: cliDir, AGY_APP_DIR: appDir,
      AGY_AGENTAPI: path.join(here, 'fake-agentapi.mjs'), ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:1',
    },
  }));
});
after(async () => {
  await client.close();
  fs.rmSync(home, { recursive: true, force: true });
});

const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  const t = r.content[0].text;
  try { return JSON.parse(t); } catch { return t; }
};
const run = async (args) => {
  const { job_id } = await call('agy_start', { cwd: home, ...args });
  assert.ok(job_id, 'job id');
  for (let i = 0; i < 40; i++) {
    const r = await call('agy_wait', { job_id, wait_s: 5 });
    if (r.state !== 'running' && r.state !== 'queued') return r;
  }
  throw new Error('job did not finish');
};

test('success returns compact structured result with usage', async () => {
  const r = await run({ prompt: 'hello' });
  assert.equal(r.state, 'done');
  assert.equal(r.status, 'done');
  assert.deepEqual(r.files_changed, ['a.txt']);
  assert.equal(r.usage.total, 110);
  assert.equal(r.conversation_id, 'conv-new');
});

test('denied command becomes needs_approval with commands_requested', async () => {
  const r = await run({ prompt: 'MARK_DENIED' });
  assert.equal(r.status, 'needs_approval');
  assert.equal(r.commands_requested[0].command, 'node -e "console.log(42)"');
  assert.equal(r.usage.total, 110, 'single model call, no follow-up');
});

test('denied file action is reported in denied_files, no model re-call', async () => {
  const r = await run({ prompt: 'MARK_DENIED_FILE' });
  assert.equal(r.status, 'needs_approval');
  assert.deepEqual(r.denied_files, [{ tool: 'write_file', path: 'C:\\work\\x.txt' }]);
  assert.equal(r.usage.total, 110, 'single model call');
});

test('agy_run_approved runs the command and continues the conversation', async () => {
  const first = await run({ prompt: 'MARK_DENIED' });
  const { job_id } = await call('agy_run_approved', { job_id: first.job_id, commands: [0] });
  let r;
  for (let i = 0; i < 40; i++) {
    r = await call('agy_wait', { job_id, wait_s: 5 });
    if (r.state !== 'running') break;
  }
  assert.equal(r.state, 'done');
  const full = await call('agy_result', { job_id, detail: 'full' });
  assert.equal(full.state, 'done');
});

test('continue_job passes --conversation, handoff_from starts fresh', async () => {
  const a = await run({ prompt: 'one' });
  const c = await run({ prompt: 'two', continue_job: a.job_id });
  assert.equal(c.state, 'done');
  const h = await run({ prompt: 'three', handoff_from: a.job_id });
  assert.equal(h.conversation_id, 'conv-new');
  assert.equal(h.state, 'done');
});

test('handoff_recommended above token threshold', async () => {
  const r = await run({ prompt: 'MARK_BIG' });
  assert.equal(r.handoff_recommended, true);
});

test('non-JSON agy output fails with error, not a hang', async () => {
  const r = await run({ prompt: 'MARK_BAD' });
  assert.equal(r.state, 'failed');
  assert.match(r.error, /no result event/);
});

test('cancel kills a running job', async () => {
  const { job_id } = await call('agy_start', { cwd: home, prompt: 'MARK_SLEEP' });
  await new Promise((r) => setTimeout(r, 1500));
  const c = await call('agy_cancel', { job_id });
  assert.equal(c.state, 'cancelled');
  const r = await call('agy_wait', { job_id, wait_s: 1 });
  assert.equal(r.state, 'cancelled');
});

test('agy_list shows jobs and token totals', async () => {
  const l = await call('agy_list', {});
  assert.ok(l.jobs.length >= 5);
  assert.ok(l.totals.all_time_tokens > 0);
});

test('target app creates a conversation in the app and reads the agent result file', async () => {
  const r = await run({ prompt: 'hello app', target: 'app', timeout_s: 30 });
  assert.equal(r.state, 'done');
  assert.equal(r.target, 'app');
  assert.equal(r.summary, 'app answered');
  assert.equal(r.conversation_id, 'app-conv-1');
  assert.equal(r.files_changed, undefined, 'agent_result.json is not reported as a workspace change');
  const c = await run({ prompt: 'more', continue_job: r.job_id, timeout_s: 30 });
  assert.equal(c.target, 'app');
  assert.equal(c.summary, 'app follow-up to app-conv-1');
  const deny = await client.callTool({ name: 'agy_run_approved', arguments: { job_id: r.job_id, commands: [0] } });
  assert.equal(deny.isError, true);
});

test('model "app" is a shortcut for target app', async () => {
  const r = await run({ prompt: 'via model alias', model: 'app', timeout_s: 30 });
  assert.equal(r.target, 'app');
  assert.equal(r.summary, 'app answered');
});

test('cancelling an app job warns that the conversation keeps running in the app', async () => {
  const { job_id } = await call('agy_start', { cwd: home, prompt: 'MARK_APP_SILENT', target: 'app', timeout_s: 60 });
  await new Promise((r) => setTimeout(r, 1500));
  const c = await call('agy_cancel', { job_id });
  assert.equal(c.state, 'cancelled');
  assert.match(c.note, /still running in Antigravity/);
});

test('csrf token is redacted from error text', async () => {
  const { redact } = await import('../src/app.mjs');
  assert.equal(redact('x --csrf_token=abc123 y ANTIGRAVITY_CSRF_TOKEN=zzz'), 'x --csrf_token=<redacted> y ANTIGRAVITY_CSRF_TOKEN=<redacted>');
});

test('target app times out cleanly when the app never reports', async () => {
  const r = await run({ prompt: 'MARK_APP_SILENT', target: 'app', timeout_s: 30 });
  assert.equal(r.state, 'failed');
  assert.match(r.error, /no result from the app/);
});

test('finished job is copied into the app store; app-side edits are never overwritten', async () => {
  const appDb = path.join(appDir, 'conversations', 'conv-new.db');
  await run({ prompt: 'sync one' });
  assert.equal(fs.readFileSync(appDb, 'utf8'), 'v1');
  assert.ok(fs.existsSync(path.join(appDir, 'brain', 'conv-new', 'log.txt')));

  fs.writeFileSync(path.join(cliDir, 'conversations', 'conv-new.db'), 'v2-cli');
  await run({ prompt: 'sync two' });
  assert.equal(fs.readFileSync(appDb, 'utf8'), 'v2-cli', 'untouched app copy is refreshed');

  fs.writeFileSync(appDb, 'edited-in-app');
  fs.writeFileSync(path.join(cliDir, 'conversations', 'conv-new.db'), 'v3-cli');
  await run({ prompt: 'sync three' });
  assert.equal(fs.readFileSync(appDb, 'utf8'), 'edited-in-app', 'changed app copy is kept');
});

test('each finished job is exported as markdown with an index entry', async () => {
  const r = await run({ prompt: 'export me' });
  const md = fs.readFileSync(path.join(home, 'exports', `${r.job_id}.md`), 'utf8');
  assert.match(md, /export me/);
  assert.match(md, /status: \*\*done\*\*/);
  assert.match(fs.readFileSync(path.join(home, 'exports', 'INDEX.md'), 'utf8'), new RegExp(r.job_id));
});

test('bad cwd is rejected', async () => {
  const r = await client.callTool({ name: 'agy_start', arguments: { cwd: path.join(home, 'nope'), prompt: 'x' } });
  assert.equal(r.isError, true);
});
