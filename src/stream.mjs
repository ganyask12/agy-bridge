// Parses agy `--output-format stream-json` (NDJSON). Returns the final result event plus
// every tool call that agy auto-denied because headless mode cannot ask for permission.
export function parseStream(stdout) {
  let result = null;
  const denied = [];
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('{')) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.event === 'result') {
      result = ev.result;
      continue;
    }
    const s = ev.step_update;
    const err = s?.tool_info?.error;
    if (s?.step_type !== 'tool' || s.state !== 'ERROR' || !/permission/i.test(err?.message || '')) continue;
    const params = s.tool_info.parameters || {};
    const tool = s.tool_name;
    denied.push(tool === 'run_command'
      ? { tool, kind: 'command', target: params.CommandLine, cwd: params.Cwd || params.CommandCwd }
      : { tool, kind: 'file', target: params.Path || params.AbsolutePath || Object.values(params)[0] });
  }
  return { result, denied };
}
