// Writes API.md (the HTTP API reference for other programs) from API_DOCS in public/app.js, the same list the
// panel shows in Settings → API reference. Run after changing that list: node tools/make-api-docs.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const app = readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const start = app.indexOf('const API_DOCS = [');
const end = app.indexOf('\n];', start);
if (start < 0 || end < 0) throw new Error('API_DOCS not found in public/app.js');
const docs = new Function(`${app.slice(start, end + 3)}\nreturn API_DOCS;`)();
const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;

const cell = (s) => String(s).replace(/\|/g, '\\|');
const out = [
  '# Tavern Host HTTP API',
  '',
  `Reference for Tavern Host ${version}. This file is generated from the list in \`public/app.js\` (the same one the panel shows in Settings → API reference) by \`node tools/make-api-docs.mjs\`.`,
  '',
  '> Tavern Host is in beta and updates are frequent. Routes can change between versions; check this file for the version you run.',
  '',
  '## Basics',
  '',
  '- **Address:** `http://127.0.0.1:8190` on the system running Tavern Host. From other devices, turn on Remote access (Settings) and use `https://<address>:8191` (self-signed certificate: pin its fingerprint rather than turning checks off).',
  '- **API key:** make one in Settings → API keys, and send it with every request: `Authorization: Bearer th_…` (or `X-Api-Key: th_…`). Keys from before the Tavern Host rename start with `gsp_` and still work.',
  '- **Permissions:** each request needs the permission shown in the tables, on that server (or all servers) for the key. The owner account can do everything.',
  '- **Bodies:** JSON, with `Content-Type: application/json`. Uploads are the raw file as the body, with the file name in an `X-Filename` header.',
  '- **Server ids:** `{id}` is the `id` from `GET /api/servers`. Servers on nodes (other systems) have ids like `n~<node>~<server>` and work the same way.',
  '- **Errors:** a non-2xx status with `{"error": "message"}`. Common ones: 400 bad request, 401 no or bad key, 403 missing permission, 404 not found or not available for that game, 409 not possible right now (e.g. server running), 428 start refused by the pre-start check (repeat with `{"force": true}` to start anyway).',
  '- **Live updates:** `GET /api/events` is a Server-Sent Events stream: `server` (status changes), `line` (console lines), `chat`, `removed` and `panel` (`{status: "up"|"restarting", reason}`) events, for everything the key can see.',
  '',
  '## Examples',
  '',
  '```',
  'curl -H "Authorization: Bearer th_…" http://127.0.0.1:8190/api/servers',
  '',
  'curl -X POST -H "Authorization: Bearer th_…" -H "Content-Type: application/json" \\',
  '     -d "{\\"command\\":\\"say hi\\"}" http://127.0.0.1:8190/api/servers/{id}/command',
  '',
  'curl -X POST -H "Authorization: Bearer th_…" -H "Content-Type: application/json" \\',
  '     -d "{\\"countdownMinutes\\":5}" http://127.0.0.1:8190/api/servers/{id}/restart',
  '```',
  '',
  '## Contents',
  '',
  ...docs.map(([group]) => `- [${group}](#${group.toLowerCase().replace(/[^a-z0-9 -]/g, '').replace(/ /g, '-')})`),
  '',
];
for (const [group, rows] of docs) {
  out.push(`## ${group}`, '', '| Request | What it does | Permission |', '|---|---|---|');
  for (const [method, route, what, perm] of rows) out.push(`| \`${method} ${cell(route)}\` | ${cell(what)} | ${cell(perm)} |`);
  out.push('');
}
writeFileSync(path.join(root, 'API.md'), out.join('\n'), 'utf8');
console.log(`API.md written: ${docs.reduce((n, [, rows]) => n + rows.length, 0)} requests in ${docs.length} groups`);
