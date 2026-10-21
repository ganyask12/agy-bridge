import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { home, readJson, writeJson } from './jobs.mjs';

const gemini = path.join(os.homedir(), '.gemini');
const cliDir = () => process.env.AGY_CLI_DIR || path.join(gemini, 'antigravity-cli');
const appDir = () => process.env.AGY_APP_DIR || path.join(gemini, 'antigravity');
const manifestFile = () => path.join(home, 'app-sync.json');

const sig = (f) => {
  const s = fs.statSync(f);
  return `${s.size}:${Math.round(s.mtimeMs)}`;
};

// Copies one CLI conversation into the Antigravity app store so it shows in the app.
// Never overwrites an app copy we did not create or that changed since our last copy.
export function syncConversation(id) {
  const src = path.join(cliDir(), 'conversations', `${id}.db`);
  const dst = path.join(appDir(), 'conversations', `${id}.db`);
  if (!fs.existsSync(src)) return { synced: false, reason: 'no cli conversation file' };
  const manifest = readJson(manifestFile()) || {};
  if (fs.existsSync(dst) && manifest[id] !== sig(dst)) return { synced: false, reason: 'app copy exists and is not ours or was changed' };

  fs.copyFileSync(src, dst);
  const ann = path.join(cliDir(), 'annotations', `${id}.pbtxt`);
  if (fs.existsSync(ann)) fs.copyFileSync(ann, path.join(appDir(), 'annotations', `${id}.pbtxt`));
  const brain = path.join(cliDir(), 'brain', id);
  if (fs.existsSync(brain)) fs.cpSync(brain, path.join(appDir(), 'brain', id), { recursive: true });

  manifest[id] = sig(dst);
  writeJson(manifestFile(), manifest);
  return { synced: true };
}

export function trySync(id, enabled) {
  if (!enabled || !id) return { synced: false, reason: 'disabled or no conversation id' };
  try {
    return syncConversation(id);
  } catch (e) {
    return { synced: false, reason: String(e.message || e) };
  }
}
