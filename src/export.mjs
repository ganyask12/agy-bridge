import fs from 'node:fs';
import path from 'node:path';
import { home } from './jobs.mjs';

const fence = (s) => `\`\`\`\n${String(s).replace(/```/g, "'''")}\n\`\`\``;

export function exportDir(config) {
  return config.export_dir || path.join(home, 'exports');
}

function render(job, prompt, result, response) {
  const u = result.usage || {};
  const lines = [
    `# agy job ${job.id}`,
    '',
    `- job: \`${job.id}\`  |  status: **${result.status}**  |  kind: ${job.kind}  |  model: ${job.model}`,
    `- workspace: \`${job.cwd}\``,
    `- conversation: \`${result.conversation_id || '-'}\`  |  tokens: ${u.total_tokens ?? '-'} (in ${u.input_tokens ?? '-'}, out ${u.output_tokens ?? '-'})`,
    '',
    '## Task',
    fence(prompt.includes('\nTask:\n') ? prompt.slice(prompt.indexOf('\nTask:\n') + 7) : prompt),
    '',
    '## Result',
    result.summary || '(no summary)',
  ];
  const list = (title, items, f) => items?.length && lines.push('', `## ${title}`, ...items.map(f));
  list('Files changed', result.files_changed, (x) => `- \`${x}\``);
  list('Commands agy asked to run (not executed)', result.commands_requested, (c) => `- \`${c.command}\` in \`${c.cwd || job.cwd}\`: ${c.reason || ''}`);
  list('Denied file actions', result.denied_files, (d) => `- ${d.tool}: \`${d.path}\``);
  list('Follow-ups', result.followups, (x) => `- ${x}`);
  if (result.handoff_notes) lines.push('', '## Handoff notes', result.handoff_notes);
  if (result.error) lines.push('', '## Error', fence(result.error));
  if (response && response.trim() !== result.summary?.trim()) lines.push('', '## Raw agy response', fence(response.slice(0, 20000)));
  return `${lines.join('\n')}\n`;
}

// Writes <export_dir>/<job id>.md and appends a line to INDEX.md. Best effort.
export function exportJob(config, job, prompt, result, response) {
  if (!config.export_markdown) return { exported: false, reason: 'disabled' };
  try {
    const dir = exportDir(config);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${job.id}.md`);
    fs.writeFileSync(file, render(job, prompt, result, response));
    const first = (result.summary || '').replace(/\s+/g, ' ').slice(0, 100);
    fs.appendFileSync(path.join(dir, 'INDEX.md'), `- [${job.id}](${job.id}.md) ${result.status}: ${first}\n`);
    return { exported: true, file };
  } catch (e) {
    return { exported: false, reason: String(e.message || e) };
  }
}
