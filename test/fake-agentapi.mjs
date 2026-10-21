// Fake `language_server.exe agentapi` for tests: plays the app agent by writing the result file.
import fs from 'node:fs';

const [cmd, ...rest] = process.argv.slice(2);
const content = rest[rest.length - 1] || '';
const file = (content.match(/write a JSON file to (\S+) with/) || [])[1];
const answer = (summary) => file && !content.includes('MARK_APP_SILENT')
  && fs.writeFileSync(file, JSON.stringify({ status: 'done', summary, files_changed: [file], followups: [], handoff_notes: 'app' }));

if (!process.env.ANTIGRAVITY_LS_ADDRESS) {
  process.stdout.write('{"error":"ANTIGRAVITY_LS_ADDRESS is not set"}');
} else if (cmd === 'new-conversation') {
  answer('app answered');
  process.stdout.write(JSON.stringify({ response: { newConversation: { conversationId: 'app-conv-1', prompt: content } } }));
} else if (cmd === 'send-message') {
  answer(`app follow-up to ${rest[rest.length - 2]}`);
  process.stdout.write('{}');
}
