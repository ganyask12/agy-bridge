import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const home = process.env.AGY_BRIDGE_HOME
  || path.join(process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '.', 'AppData', 'Local'), 'agy-bridge');
const jobsDir = path.join(home, 'jobs');
const usageFile = path.join(home, 'usage.jsonl');

export function loadConfig() {
  const base = JSON.parse(fs.readFileSync(path.join(root, 'config.default.json'), 'utf8'));
  try {
    const user = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
    return { ...base, ...user, tiers: { ...base.tiers, ...user.tiers } };
  } catch {
    return base;
  }
}

export const jobDir = (id) => path.join(jobsDir, id);

export function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

export const writeJson = (file, obj) => writeAtomic(file, JSON.stringify(obj, null, 2));

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function createJob(params) {
  const id = `${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}-${crypto.randomBytes(3).toString('hex')}`;
  const dir = jobDir(id);
  fs.mkdirSync(dir, { recursive: true });
  writeJson(path.join(dir, 'job.json'), { id, state: 'queued', created: Date.now(), ...params });
  return id;
}

export const readJob = (id) => readJson(path.join(jobDir(id), 'job.json'));

export function updateJob(id, patch) {
  const job = readJob(id);
  if (!job) throw new Error(`unknown job ${id}`);
  const next = { ...job, ...patch };
  writeJson(path.join(jobDir(id), 'job.json'), next);
  return next;
}

export const readResult = (id) => readJson(path.join(jobDir(id), 'result.json'));

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// A job whose runner process vanished without writing a result is failed, not running.
export function getJob(id) {
  const job = readJob(id);
  if (!job) return null;
  if ((job.state === 'queued' || job.state === 'running') && job.runner_pid && !alive(job.runner_pid)) {
    return updateJob(id, { state: 'failed', error: 'runner process died', ended: Date.now() });
  }
  return job;
}

export function listJobs() {
  if (!fs.existsSync(jobsDir)) return [];
  return fs.readdirSync(jobsDir).sort().reverse().map(getJob).filter(Boolean);
}

export function appendUsage(row) {
  fs.mkdirSync(home, { recursive: true });
  fs.appendFileSync(usageFile, `${JSON.stringify(row)}\n`);
}

export function usageTotals() {
  let rows = [];
  try {
    rows = fs.readFileSync(usageFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { /* no usage yet */ }
  const day = new Date().toISOString().slice(0, 10);
  const sum = (rs) => rs.reduce((a, r) => a + (r.total_tokens || 0), 0);
  return {
    all_time_tokens: sum(rows),
    today_tokens: sum(rows.filter((r) => r.day === day)),
    jobs: rows.length,
  };
}
