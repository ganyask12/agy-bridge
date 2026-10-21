import fs from 'node:fs';
import path from 'node:path';

export function findAgy() {
  const local = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe');
  for (const p of [process.env.AGY_BIN, local]) {
    if (p && fs.existsSync(p)) return p;
  }
  return 'agy';
}

// Node refuses to spawn .cmd/.bat without a shell, so a JS stub (tests) is run through node.
export function agyCommand() {
  const bin = findAgy();
  return /\.m?js$/.test(bin) ? { cmd: process.execPath, prefix: [bin] } : { cmd: bin, prefix: [] };
}

export function resolveModel(config, { tier = 'fast', model } = {}) {
  return model || config.tiers[tier] || config.tiers.fast;
}

// kind "read" -> plan mode (no writes, no shell); "edit" -> accept-edits (file writes allowed).
// Shell commands outside the user's own allow-list are auto-denied by agy in headless mode.
export function buildArgs({ prompt, kind, model, conversation, addDirs = [], timeoutS, schema }) {
  const args = ['-p', prompt, '--mode', kind === 'edit' ? 'accept-edits' : 'plan',
    '--output-format', 'stream-json', '--print-timeout', `${timeoutS}s`];
  if (schema) args.push('--json-schema', JSON.stringify(schema));
  if (model) args.push('--model', model);
  if (conversation) args.push('--conversation', conversation);
  for (const d of addDirs) args.push('--add-dir', d);
  return args;
}
