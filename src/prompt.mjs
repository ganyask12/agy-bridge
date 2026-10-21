export const RESULT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['done', 'needs_approval', 'blocked', 'failed'] },
    summary: { type: 'string', description: 'Short result, at most 150 words.' },
    files_changed: { type: 'array', items: { type: 'string' } },
    commands_requested: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          cwd: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['command', 'reason'],
      },
    },
    followups: { type: 'array', items: { type: 'string' } },
    handoff_notes: { type: 'string', description: 'State, decisions and what remains, for a fresh session.' },
  },
  required: ['status', 'summary'],
};

const RULES = `You are a delegated worker for another AI agent. Rules:
- Do NOT run shell commands. If a command is needed, do not run it: list it in commands_requested (command, cwd, reason) and set status "needs_approval".
- The summary field must contain the actual answer or findings (never just a description of what you did), in under 150 words. Put long detail in files.
- List every file you created or modified in files_changed.
- Put anything still open in followups, and state/decisions in handoff_notes.
- Do not create plan documents; answer directly.`;

export function preamble(kind) {
  const scope = kind === 'edit'
    ? 'You may create and edit files in the workspace.'
    : 'This is a read-only task: do not modify any files.';
  return `${RULES}\n- ${scope}\n\nTask:\n`;
}

export function handoffPrompt(r, task) {
  const parts = [
    'You continue work started in an earlier session. Prior state:',
    `Summary: ${r.summary || '(none)'}`,
    `Files changed so far: ${(r.files_changed || []).join(', ') || '(none)'}`,
    `Open follow-ups: ${(r.followups || []).join('; ') || '(none)'}`,
    `Notes: ${r.handoff_notes || '(none)'}`,
    '',
    'New task:',
    task,
  ];
  return parts.join('\n');
}
