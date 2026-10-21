// Fake agy (stream-json). Behaviour is picked by a marker word in the prompt (-p value).
const args = process.argv.slice(2);
const prompt = args[args.indexOf('-p') + 1] || '';
const conv = args.includes('--conversation') ? args[args.indexOf('--conversation') + 1] : 'conv-new';
const usage = (input) => ({ input_tokens: input, output_tokens: 10, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: input + 10 });
const emit = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const result = (o) => emit({ event: 'result', result: { conversation_id: conv, status: 'SUCCESS', num_turns: 1, usage: usage(100), ...o } });
const denial = (tool_name, parameters) => emit({
  event: 'step_update',
  step_update: {
    conversation_id: conv, step_index: 2, state: 'ERROR', step_type: 'tool', tool_name,
    tool_info: { name: tool_name, parameters, error: { type: 'TOOL_ERROR', message: `permission check failed for ${tool_name}: user denied permission` } },
  },
});
emit({ event: 'init', conversation_id: conv, init: { cwd: process.cwd() } });

if (prompt.includes('MARK_SLEEP')) {
  setTimeout(() => result({ response: 'late' }), 60000);
} else if (prompt.includes('MARK_BAD')) {
  process.stdout.write('not json at all');
  process.exit(1);
} else if (prompt.includes('MARK_DENIED_FILE')) {
  denial('write_file', { Path: 'C:\\work\\x.txt' });
  result({ response: '', denied_actions: [{ action: 'write_file', display_name: 'WriteFile' }] });
} else if (prompt.includes('MARK_DENIED')) {
  denial('run_command', { CommandLine: 'node -e "console.log(42)"' });
  result({ response: '', denied_actions: [{ action: 'command', display_name: 'RunCommand' }] });
} else if (prompt.includes('MARK_BIG')) {
  result({ response: 'x', usage: usage(999999), structured_output: { status: 'done', summary: 'big' } });
} else {
  result({
    response: 'ok',
    structured_output: { status: 'done', summary: `echo: ${prompt.slice(-40)}`, files_changed: ['a.txt'], handoff_notes: 'n1' },
  });
}
