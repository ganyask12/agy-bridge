// Manual smoke test against the REAL agy: node test/live.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-bridge-live-'));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-bridge-work-'));
fs.writeFileSync(path.join(work, 'notes.txt'), 'alpha\nbeta\ngamma\n');

const client = new Client({ name: 'live', version: '0' });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [path.join(here, '..', 'src', 'server.mjs')],
  // Sync and export go to temp dirs so a smoke test never touches the real Antigravity app store.
  env: { ...process.env, AGY_BRIDGE_HOME: home, AGY_APP_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'agy-bridge-app-')) },
}));
const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
const run = async (label, args) => {
  const { job_id } = await call('agy_start', { cwd: work, ...args });
  let r;
  do { r = await call('agy_wait', { job_id, wait_s: 20 }); } while (r.state === 'running' || r.state === 'queued');
  console.log(`\n=== ${label} ===\n${JSON.stringify(r, null, 1)}`);
  return r;
};

await run('read', { prompt: 'Read notes.txt and report how many lines it has and the second line.', kind: 'read' });
await run('edit', { prompt: 'Create file out.txt containing the word hello. Then say done.', kind: 'edit' });
console.log('out.txt exists:', fs.existsSync(path.join(work, 'out.txt')));
await run('shell-needed', { prompt: 'Find the machine hostname using a shell command.', kind: 'edit' });
console.log('\n', JSON.stringify(await call('agy_list', {}), null, 1));
await client.close();
console.log('work dir:', work);
