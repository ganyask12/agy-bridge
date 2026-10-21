// Detached worker: runs agy for one job and writes result.json. Usage: node runner.mjs <jobDir>
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { agyCommand, buildArgs } from './agy.mjs';
import { trySync } from './sync.mjs';
import { exportJob } from './export.mjs';
import { discoverLs, newConversation, sendMessage, appPrompt, pickProject, redact } from './app.mjs';
import { RESULT_SCHEMA } from './prompt.mjs';
import { parseStream } from './stream.mjs';
import { loadConfig, readJob, readJson, updateJob, writeJson, writeAtomic, appendUsage } from './jobs.mjs';

const dir = process.argv[2];
const id = path.basename(dir);
const config = loadConfig();

function killTree(pid) {
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
}

function runAgy(job, prompt, conversation) {
  return new Promise((resolve) => {
    const args = buildArgs({
      prompt, kind: job.kind, model: job.model, conversation,
      addDirs: job.add_dirs, timeoutS: job.timeout_s, schema: RESULT_SCHEMA,
    });
    const { cmd, prefix } = agyCommand();
    const child = spawn(cmd, [...prefix, ...args], { cwd: job.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, (job.timeout_s + 30) * 1000);
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: '', stderr: String(e), timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        code, timedOut,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      });
    });
  });
}

function structuredOf(p) {
  if (p?.structured_output) return p.structured_output;
  try {
    return JSON.parse(p?.response);
  } catch {
    return null;
  }
}

// Fold auto-denied tool calls into the result: commands go to commands_requested (deduped,
// exact text from the event), file actions go to denied_files.
function mergeDenied(result, denied, cwd) {
  if (!denied.length) return;
  const cmds = result.commands_requested ? [...result.commands_requested] : [];
  for (const d of denied.filter((x) => x.kind === 'command' && x.target)) {
    if (!cmds.some((c) => c.command === d.target)) {
      cmds.push({ command: d.target, cwd: d.cwd || cwd, reason: 'agy tried to run it and was auto-denied' });
    }
  }
  if (cmds.length) result.commands_requested = cmds;
  const files = denied.filter((x) => x.kind === 'file').map((x) => ({ tool: x.tool, path: x.target }));
  if (files.length) result.denied_files = files;
  if (result.status === 'done') result.status = 'needs_approval';
  if (!result.summary || result.unstructured) {
    result.summary = `agy was blocked: ${cmds.length} command(s) and ${files.length} file action(s) were auto-denied.${result.summary ? ` ${result.summary}` : ''}`;
  }
}

async function main() {
  const job = readJob(id);
  updateJob(id, { state: 'running', runner_pid: process.pid, started: Date.now() });

  let prompt = fs.readFileSync(path.join(dir, 'prompt.txt'), 'utf8');
  if (prompt.length > config.max_inline_prompt_chars) {
    job.add_dirs = [...(job.add_dirs || []), dir];
    prompt = `Read the full task from ${path.join(dir, 'prompt.txt')} and carry it out exactly.`;
  }

  if (job.target === 'app') return runInApp(job, prompt);

  const run = await runAgy(job, prompt, job.conversation);
  writeAtomic(path.join(dir, 'stdout.ndjson'), run.stdout);
  writeAtomic(path.join(dir, 'stderr.txt'), run.stderr);
  const { result: p, denied } = parseStream(run.stdout);
  const usage = p?.usage;
  const structured = structuredOf(p);

  // Headless agy cannot ask for permission: it auto-denies and the stream names the exact
  // command/file. Surface those for the caller to approve (commands) or re-run (files).
  const result = { job_id: id, conversation_id: p?.conversation_id, usage, turns: p?.num_turns };
  if (run.timedOut) {
    Object.assign(result, { state: 'failed', status: 'failed', error: `timeout after ${job.timeout_s}s` });
  } else if (!p) {
    Object.assign(result, {
      state: 'failed', status: 'failed',
      error: `agy produced no result event (exit ${run.code}): ${run.stderr.trim().slice(-500)}`,
    });
  } else if (structured) {
    Object.assign(result, { state: 'done', ...structured });
  } else {
    Object.assign(result, {
      state: p.status === 'SUCCESS' ? 'done' : 'failed',
      status: 'done',
      unstructured: true,
      summary: (p.response || '').trim().slice(0, 1500),
    });
  }
  mergeDenied(result, denied, job.cwd);
  const total = usage?.total_tokens || 0;
  result.handoff_recommended = (usage?.input_tokens || 0) > config.handoff_threshold_tokens;
  result.response_chars = (p?.response || '').length;

  result.app_sync = trySync(result.conversation_id, config.sync_to_app);
  result.export = exportJob(config, readJob(id), fs.readFileSync(path.join(dir, 'prompt.txt'), 'utf8'), result, p?.response);
  writeAtomic(path.join(dir, 'response.txt'), p?.response || '');
  writeJson(path.join(dir, 'result.json'), result);
  appendUsage({ job: id, conversation: result.conversation_id, day: new Date().toISOString().slice(0, 10), total_tokens: total, ...usage });
  if (readJob(id).state !== 'cancelled') updateJob(id, { state: result.state, ended: Date.now() });
}

// The app runs the task with its own permissions and model; it reports back by writing
// agent_result.json, which we poll for. No token usage is available on this path.
async function runInApp(job, prompt) {
  const resultFile = path.join(dir, 'agent_result.json');
  const project = pickProject(job.cwd, config.app_project);
  const env = { ...discoverLs(), ANTIGRAVITY_PROJECT_ID: project.id };
  updateJob(id, { app_project: project.name || project.id });
  const text = appPrompt(`Workspace folder: ${job.cwd}\n\n${prompt}`, resultFile);
  let conversation = job.conversation;
  if (conversation) {
    sendMessage(env, conversation, text);
  } else {
    conversation = newConversation(env, { prompt: text, title: job.title, model: config.app_tiers[job.tier] });
  }
  updateJob(id, { conversation_id: conversation });

  const deadline = Date.now() + job.timeout_s * 1000;
  let structured = null;
  while (!structured && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    structured = readJson(resultFile);
  }
  const result = { job_id: id, target: 'app', conversation_id: conversation, usage: null };
  if (structured) {
    Object.assign(result, { state: 'done', ...structured });
    // the result file itself is bridge plumbing, not a change the agent made to the workspace
    result.files_changed = (result.files_changed || []).filter((f) => path.resolve(f).toLowerCase() !== resultFile.toLowerCase());
  }
  else Object.assign(result, { state: 'failed', status: 'failed', error: `no result from the app within ${job.timeout_s}s (the conversation may still be running in Antigravity)` });

  result.export = exportJob(config, readJob(id), fs.readFileSync(path.join(dir, 'prompt.txt'), 'utf8'), result, '');
  writeJson(path.join(dir, 'result.json'), result);
  if (readJob(id).state !== 'cancelled') updateJob(id, { state: result.state, ended: Date.now() });
}

main().catch((e) => {
  writeJson(path.join(dir, 'result.json'), { job_id: id, state: 'failed', status: 'failed', error: redact(e?.stack || e) });
  updateJob(id, { state: 'failed', ended: Date.now() });
});
