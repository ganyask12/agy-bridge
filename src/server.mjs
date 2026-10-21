#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { resolveModel } from './agy.mjs';
import { preamble, handoffPrompt } from './prompt.mjs';
import {
  loadConfig, createJob, getJob, updateJob, listJobs, readResult, jobDir, usageTotals,
} from './jobs.mjs';

const runnerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'runner.mjs');

const INSTRUCTIONS = `Delegate bulky or parallelizable work to Antigravity (agy) to save your own tokens. Do small tasks yourself.
Flow: agy_start -> agy_wait (repeat while state is "running") -> use the compact result. agy_result detail="full" only when the summary is not enough.
kind "read" = analysis/research/review, agy cannot change files. kind "edit" = agy may edit files in cwd; verify its files_changed yourself.
agy cannot ask for permission in headless mode: anything outside its allow-rules is auto-denied. When status is "needs_approval", read commands_requested (exact commands agy tried), decide, then agy_run_approved with the indexes you approve. denied_files lists file actions it was blocked on (e.g. writes in a read job): re-run with kind "edit" if appropriate.
Default tier "fast"; use "deep" only for hard reasoning. When a result has handoff_recommended=true, continue with agy_start handoff_from=<job_id> instead of continue_job to start a fresh, smaller session.
target "app" runs the task as a normal conversation in the Antigravity desktop app (the user can watch it there), but without Claude's command approval or token accounting; use it only when the user wants to see the work in the app.
Jobs survive restarts of this server. Use agy_list to see jobs and token totals.`;

const text = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 1) }] });
const fail = (msg) => ({ isError: true, ...text(msg) });

function startJob({ prompt, cwd, kind, tier, model, add_dirs, timeout_s, conversation, target, title }) {
  const config = loadConfig();
  if (!fs.existsSync(cwd)) throw new Error(`cwd does not exist: ${cwd}`);
  const t = target || config.default_target;
  const id = createJob({
    cwd, kind, tier, target: t, title: title || null,
    model: t === 'app' ? `app:${config.app_tiers[tier] || 'flash'}` : resolveModel(config, { tier, model }),
    add_dirs: add_dirs || [], timeout_s: timeout_s || config.default_timeout_s, conversation: conversation || null,
  });
  fs.writeFileSync(path.join(jobDir(id), 'prompt.txt'), preamble(kind) + prompt);
  const child = spawn(process.execPath, [runnerPath, jobDir(id)], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  updateJob(id, { runner_pid: child.pid });
  return id;
}

function compact(id) {
  const job = getJob(id);
  if (!job) return { error: `unknown job ${id}` };
  const base = { job_id: id, state: job.state, target: job.target || 'cli', kind: job.kind, model: job.model };
  if (job.target === 'app' && job.conversation_id) base.conversation_id = job.conversation_id;
  if (job.state === 'queued' || job.state === 'running') {
    return { ...base, elapsed_s: Math.round((Date.now() - (job.started || job.created)) / 1000) };
  }
  const r = readResult(id) || {};
  const out = { ...base, status: r.status, summary: r.summary };
  for (const k of ['files_changed', 'commands_requested', 'denied_files', 'followups', 'handoff_notes']) {
    if (r[k]?.length) out[k] = r[k];
  }
  if (r.error || job.error) out.error = r.error || job.error;
  if (r.unstructured) out.unstructured = true;
  out.conversation_id = r.conversation_id;
  out.usage = r.usage && {
    input: r.usage.input_tokens, output: r.usage.output_tokens, thinking: r.usage.thinking_tokens, total: r.usage.total_tokens,
  };
  if (r.handoff_recommended) out.handoff_recommended = true;
  return out;
}

const server = new McpServer({ name: 'agy-bridge', version: '0.1.0' }, { instructions: INSTRUCTIONS });

server.registerTool('agy_start', {
  description: 'Start an Antigravity (agy) job in the background. Returns job_id immediately.',
  inputSchema: {
    prompt: z.string().describe('Complete task description; agy has no access to this conversation.'),
    cwd: z.string().describe('Absolute path of the workspace agy works in.'),
    kind: z.enum(['read', 'edit']).default('read'),
    tier: z.enum(['fast', 'balanced', 'deep']).default('fast'),
    model: z.string().optional().describe('Exact agy model id; overrides tier. "app" or "app:pro" is a shortcut for target "app".'),
    add_dirs: z.array(z.string()).optional(),
    timeout_s: z.number().int().min(30).max(3600).optional(),
    continue_job: z.string().optional().describe('Continue the same agy conversation as this earlier job.'),
    handoff_from: z.string().optional().describe('Start a FRESH conversation seeded with the notes of this earlier job.'),
    target: z.enum(['cli', 'app']).optional().describe('"cli" (default): headless agy, Claude approves shell commands, token usage tracked. "app": a real conversation inside the Antigravity desktop app, visible there; runs with the app\'s own permissions (it may run commands itself), no token usage.'),
    title: z.string().optional().describe('Conversation title in the app (target "app" only).'),
  },
}, async (a) => {
  try {
    // model "app" / "app:<flash|pro>" also selects the app target, for clients whose cached tool schema predates `target`.
    const m = /^app(?::(\w+))?$/.exec(a.model || '');
    if (m) {
      a.target = 'app';
      if (m[1]) a.tier = m[1] === 'pro' ? 'deep' : 'fast';
      delete a.model;
    }
    if (a.continue_job && a.handoff_from) return fail('use either continue_job or handoff_from, not both');
    let prompt = a.prompt;
    let conversation;
    if (a.continue_job) {
      const prevJob = getJob(a.continue_job);
      conversation = readResult(a.continue_job)?.conversation_id;
      if (!conversation) return fail(`job ${a.continue_job} has no conversation to continue (unfinished or failed)`);
      a.target = prevJob?.target || 'cli';
    }
    if (a.handoff_from) {
      const prev = readResult(a.handoff_from);
      if (!prev) return fail(`job ${a.handoff_from} has no result to hand off from`);
      prompt = handoffPrompt(prev, a.prompt);
    }
    return text({ job_id: startJob({ ...a, prompt, conversation }) });
  } catch (e) {
    return fail(String(e.message || e));
  }
});

server.registerTool('agy_wait', {
  description: 'Wait up to wait_s (max 50) for a job. Returns the compact result, or state "running".',
  inputSchema: { job_id: z.string(), wait_s: z.number().int().min(1).max(50).default(30) },
}, async ({ job_id, wait_s }) => {
  const end = Date.now() + wait_s * 1000;
  for (;;) {
    const job = getJob(job_id);
    if (!job) return fail(`unknown job ${job_id}`);
    if ((job.state !== 'queued' && job.state !== 'running') || Date.now() >= end) return text(compact(job_id));
    await new Promise((r) => setTimeout(r, 500));
  }
});

server.registerTool('agy_result', {
  description: 'Get a job result. detail "summary" (default) is compact; "full" adds the raw agy response.',
  inputSchema: {
    job_id: z.string(),
    detail: z.enum(['summary', 'full']).default('summary'),
    max_chars: z.number().int().min(500).max(100000).default(8000),
  },
}, async ({ job_id, detail, max_chars }) => {
  const out = compact(job_id);
  if (out.error) return fail(out.error);
  if (detail === 'full') {
    try {
      const raw = fs.readFileSync(path.join(jobDir(job_id), 'response.txt'), 'utf8');
      out.response = raw.length > max_chars ? `${raw.slice(0, max_chars)}\n...[truncated ${raw.length - max_chars} chars]` : raw;
    } catch { /* job not finished */ }
  }
  return text(out);
});

server.registerTool('agy_run_approved', {
  description: 'Run commands from a job\'s commands_requested that YOU approved (by index), then continue that agy conversation with their output. Returns a new job_id.',
  inputSchema: { job_id: z.string(), commands: z.array(z.number().int().min(0)).min(1) },
}, async ({ job_id, commands }) => {
  try {
    const config = loadConfig();
    const prev = readResult(job_id);
    const job = getJob(job_id);
    if (job?.target === 'app') return fail('app jobs run commands inside Antigravity with the app\'s own permissions; continue them with agy_start continue_job instead');
    if (!prev?.commands_requested?.length) return fail('job has no commands_requested');
    if (!prev.conversation_id) return fail('job has no conversation to continue');
    const parts = [];
    for (const i of commands) {
      const c = prev.commands_requested[i];
      if (!c) return fail(`no command at index ${i}`);
      const cwd = c.cwd && fs.existsSync(c.cwd) ? c.cwd : job.cwd;
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', c.command], {
        cwd, encoding: 'utf8', windowsHide: true, timeout: config.approved_command_timeout_s * 1000,
      });
      const tail = `${r.stdout || ''}${r.stderr || ''}`.slice(-config.approved_output_tail_chars);
      parts.push(`$ ${c.command}\n(cwd ${cwd}, exit ${r.status}${r.error ? `, ${r.error.code || r.error.message}` : ''})\n${tail}`);
    }
    const prompt = `The following commands were approved and run for you. Continue the task using their output.\n\n${parts.join('\n\n')}`;
    const id = startJob({
      prompt, cwd: job.cwd, kind: job.kind, tier: job.tier, model: job.model,
      add_dirs: job.add_dirs, timeout_s: job.timeout_s, conversation: prev.conversation_id,
    });
    return text({ job_id: id, ran: commands.length });
  } catch (e) {
    return fail(String(e.message || e));
  }
});

server.registerTool('agy_cancel', {
  description: 'Cancel a running job. CLI jobs: kills agy. App jobs: only stops the bridge waiting; the conversation keeps running in Antigravity until stopped there.',
  inputSchema: { job_id: z.string() },
}, async ({ job_id }) => {
  const job = getJob(job_id);
  if (!job) return fail(`unknown job ${job_id}`);
  if (job.state !== 'queued' && job.state !== 'running') return text({ job_id, state: job.state, note: 'not running' });
  updateJob(job_id, { state: 'cancelled', ended: Date.now() });
  if (job.runner_pid) spawnSync('taskkill', ['/PID', String(job.runner_pid), '/T', '/F'], { windowsHide: true });
  if (job.target === 'app') {
    return text({ job_id, state: 'cancelled', note: 'The bridge stopped waiting, but the conversation is still running in Antigravity (agentapi has no cancel). Stop it in the Antigravity window.' });
  }
  return text({ job_id, state: 'cancelled' });
});

server.registerTool('agy_list', {
  description: 'List recent jobs and token totals.',
  inputSchema: { active_only: z.boolean().default(false), limit: z.number().int().min(1).max(50).default(10) },
}, async ({ active_only, limit }) => {
  let jobs = listJobs();
  if (active_only) jobs = jobs.filter((j) => j.state === 'queued' || j.state === 'running');
  const rows = jobs.slice(0, limit).map((j) => {
    const r = readResult(j.id);
    return {
      job_id: j.id, state: j.state, kind: j.kind, model: j.model, status: r?.status,
      conversation_id: r?.conversation_id, tokens: r?.usage?.total_tokens,
    };
  });
  return text({ totals: usageTotals(), jobs: rows });
});

await server.connect(new StdioServerTransport());
