// Storage, through Tavern Vault (a separate app). When Tavern Vault's node mode is on, it runs a small service on
// 127.0.0.1 and writes its address and key to C:\ProgramData\Tavern Vault\service.json (readable by the Windows account
// that turned node mode on, which is the one Tavern Host runs as). Tavern Host passes storage requests to it, and a
// master panel reaches it through the node link (/api/nodes/<id>/vault/...). Without Tavern Vault there's no storage
// view, only an explanation of what's needed.
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const DIR = process.env.TAVERN_VAULT_DATA ?? path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'Tavern Vault');

/**
 * Read-only calls (storage.view); every other Tavern Vault call needs storage.manage. Besides these names, Tavern Vault
 * names every read-only call get… or list… (Tavern Vault 0.3+: SMART, jobs, snapshots, backups, bay map, report…).
 */
export const VIEW_METHODS = new Set(['state', 'inventory', 'scrubInfo', 'activity', 'arrays', 'validateArray', 'discoverArrays', 'snapraidRunning', 'schedules']);
// A get…/list… call that hands out something secret (an encryption recovery key, a password, a token…) still needs
// storage.manage: the name rule above shouldn't let "See storage" read those.
const SENSITIVE = /key|secret|password|passphrase|token|recovery|credential|unlock/i;
export const isViewMethod = (m: string) => (VIEW_METHODS.has(m) || /^(get|list)[A-Z]/.test(m)) && !SENSITIVE.test(m);
/** Only the Tavern Vault window on that PC can do these (native pickers, files, node mode, its direct link, updates). */
const WINDOW_ONLY = new Set(['setNodeMode', 'pickFile', 'pickFolder', 'openPath', 'openExternal', 'saveReport', 'saveText', 'pickInstaller', 'runInstaller', 'makeNodeCode', 'stopLink', 'linkInfo']);
export const UI_FILES: Record<string, string> = { 'index.html': 'text/html; charset=utf-8', 'app.js': 'text/javascript', 'styles.css': 'text/css' };

export type VaultState =
  | { state: 'missing' | 'off' | 'nokey' | 'down'; message: string }
  | { state: 'ok'; message: null; status: Record<string, unknown> };

const MESSAGES = {
  missing: 'Storage needs Tavern Vault. Install Tavern Vault on this system, then turn on Node mode in its Settings.',
  off: 'Tavern Vault is installed but Node mode is off. Open Tavern Vault → Settings → Node mode (show in Tavern Host).',
  nokey: "Tavern Vault's node mode is on, but Tavern Host can't read its key yet. Wait a minute (the service starts with Windows), or turn Node mode off and on again in Tavern Vault while signed in to Windows as the account Tavern Host runs under.",
  down: "Tavern Vault's service isn't answering. It starts with Windows: restart this PC, or turn Node mode off and on again in Tavern Vault.",
};

function service(): { port: number; token: string } | null {
  try {
    const s = JSON.parse(readFileSync(path.join(DIR, 'service.json'), 'utf-8'));
    return Number(s.port) > 0 && typeof s.token === 'string' ? { port: Number(s.port), token: s.token } : null;
  } catch {
    return null;
  }
}

function nodeModeOn(): boolean {
  try {
    return !!JSON.parse(readFileSync(path.join(DIR, 'config.json'), 'utf-8')).nodeMode;
  } catch {
    return false;
  }
}

class VaultError extends Error {
  state: 'missing' | 'off' | 'nokey' | 'down';
  constructor(state: 'missing' | 'off' | 'nokey' | 'down') {
    super(MESSAGES[state]);
    this.state = state;
  }
}

/** One request to the local Tavern Vault service. Throws a VaultError explaining what's missing. */
async function request(method: string, p: string, body?: unknown, timeoutMs = 60_000): Promise<Response> {
  if (!existsSync(DIR)) throw new VaultError('missing');
  if (!nodeModeOn()) throw new VaultError('off');
  const s = service();
  if (!s) throw new VaultError('nokey');
  try {
    return await fetch(`http://127.0.0.1:${s.port}${p}`, {
      method,
      headers: { Authorization: `Bearer ${s.token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new VaultError('down');
  }
}

async function json<T>(res: Response): Promise<T> {
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw Object.assign(new Error(data.error ?? `Tavern Vault answered ${res.status}.`), { status: res.status === 401 ? 502 : res.status });
  return data;
}

/** Whether storage is available here, with Tavern Vault's status summary when it is. */
export async function vaultState(): Promise<VaultState> {
  try {
    return { state: 'ok', message: null, status: await json<Record<string, unknown>>(await request('GET', '/status', undefined, 30_000)) };
  } catch (err) {
    if (err instanceof VaultError) return { state: err.state, message: err.message };
    return { state: 'down', message: (err as Error).message };
  }
}

/** Runs one Tavern Vault call ({ ok, data } or { ok: false, error }, like the Tavern Vault window gets). */
export async function vaultCall(method: string, args: unknown, via: string): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  if (WINDOW_ONLY.has(method)) return { ok: false, error: 'That can only be done in the Tavern Vault window on that PC.' };
  try {
    return await json(await request('POST', '/call', { method, args, via }, 15 * 60_000));
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** SnapRAID output and finish events since `since` (the page polls this while a command runs). */
export async function vaultEvents(since: number) {
  return json<{ seq: number; events: unknown[] }>(await request('GET', `/events?since=${Math.max(0, Math.floor(since) || 0)}`, undefined, 15_000));
}

/** One of Tavern Vault's page files, so its own interface can be shown inside Tavern Host. */
export async function vaultUiFile(name: string): Promise<string> {
  if (!UI_FILES[name]) throw Object.assign(new Error('Not found.'), { status: 404 });
  const res = await request('GET', `/ui/${name}`, undefined, 15_000);
  if (!res.ok) throw Object.assign(new Error(`Tavern Vault answered ${res.status}.`), { status: 502 });
  return res.text();
}

/**
 * The script that replaces the Tavern Vault window's bridge (window.vault) when its page runs inside Tavern Host:
 * calls go to Tavern Host's API for this system or a node, and SnapRAID output is polled.
 */
export function vaultShim(apiBase: string): string {
  return `// Tavern Host bridge for the Tavern Vault page (made by Tavern Host).
(() => {
  const base = ${JSON.stringify(apiBase)};
  const lineFns = [];
  const doneFns = [];
  let seq = null;
  async function poll() {
    try {
      const res = await fetch(base + '/events?since=' + (seq ?? 0), { credentials: 'same-origin' });
      const r = await res.json();
      if (res.ok) {
        // The first answer only sets where we are, so old output isn't replayed.
        if (seq !== null) for (const e of r.events) {
          if (e.type === 'snapraid-line') lineFns.forEach((f) => f({ id: e.id, line: e.line }));
          if (e.type === 'snapraid-done') doneFns.forEach((f) => f({ id: e.id, cmd: e.cmd, result: e.result, error: e.error }));
        }
        seq = r.seq;
      }
    } catch {}
    setTimeout(poll, 1000);
  }
  poll();
  window.vault = {
    remote: true,
    call: async (method, args) => {
      if (method === 'openExternal') return void window.open(args.url, '_blank', 'noopener');
      if (method === 'pickFile' || method === 'pickFolder') return null;
      const res = await fetch(base + '/call', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Panel': '1' }, body: JSON.stringify({ method, args }) });
      const r = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(r.error || 'Request failed (' + res.status + ')');
      if (!r.ok) throw new Error(r.error);
      return r.data;
    },
    onSnapraidLine: (fn) => lineFns.push(fn),
    onSnapraidDone: (fn) => doneFns.push(fn),
  };
})();
`;
}

/** Tavern Vault's page with the bridge script added in front of its own. */
export function vaultPage(html: string): string {
  return html.replace(/<script src="app\.js"/, '<script src="shim.js"></script>\n  <script src="app.js"');
}
