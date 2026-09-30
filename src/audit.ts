// Activity log: who did what, saved to data/activity.log (one JSON object per line; the oldest half is dropped when
// the file passes 5 MB). Shown on the Users page to people with "View activity log".
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dataPath } from './store.ts';

const FILE = () => dataPath('activity.log');
const MAX_BYTES = 5 * 1024 * 1024;

export interface Activity {
  at: number;
  who: string;
  /** "user" or "apikey", with its id, so entries can be filtered per account. */
  kind: string;
  id: string;
  what: string;
  ip?: string;
}

export function logActivity(entry: Activity) {
  console.log(`[${new Date(entry.at).toISOString()}] [audit] ${entry.who}: ${entry.what}`);
  try {
    appendFileSync(FILE(), JSON.stringify(entry) + '\n');
    if (statSync(FILE()).size > MAX_BYTES) {
      const lines = readFileSync(FILE(), 'utf-8').trim().split('\n');
      writeFileSync(FILE(), lines.slice(Math.floor(lines.length / 2)).join('\n') + '\n');
    }
  } catch {}
}

/** Newest first. `accountId` limits it to one user or API key; `search` matches text. */
export function readActivity(opts: { accountId?: string; search?: string; limit?: number } = {}): Activity[] {
  if (!existsSync(FILE())) return [];
  const search = opts.search?.toLowerCase();
  const out: Activity[] = [];
  const lines = readFileSync(FILE(), 'utf-8').trim().split('\n').reverse();
  for (const line of lines) {
    if (!line) continue;
    try {
      const a = JSON.parse(line) as Activity;
      if (opts.accountId && a.id !== opts.accountId) continue;
      if (search && !`${a.who} ${a.what}`.toLowerCase().includes(search)) continue;
      out.push(a);
      if (out.length >= (opts.limit ?? 300)) break;
    } catch {}
  }
  return out;
}
