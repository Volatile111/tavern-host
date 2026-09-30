// Everyone who has played on each server: first/last seen, number of joins and total playtime. Updated from the live
// player list the game modules read from the log; saved to data/players.json.
import { readJson, writeJson } from './store.ts';
import type { Player } from './games/types.ts';

const FILE = 'players.json';

export interface PlayerRecord {
  name: string;
  /** Java UUID, Bedrock XUID or Valheim platform ID, when the game reports one. */
  id: string | null;
  firstSeen: number;
  lastSeen: number;
  joins: number;
  /** Finished sessions only; the current session is added when showing. */
  playSeconds: number;
  /** Set while online (survives a panel restart, so a restart doesn't count as a new join). */
  sessionStart: number | null;
  /** The owner's note about this player (e.g. "warned for griefing, Sept 23"). */
  note?: string;
  /** Muted in chat (Bedrock, through the chat relay pack). */
  muted?: boolean;
}

const data: Record<string, Record<string, PlayerRecord>> = readJson(FILE, {});
let dirty = false;

const key = (name: string) => name.toLowerCase();

/** Compares who's online now with what we had and records joins and leaves. */
export function syncPlayers(serverId: string, online: Player[]) {
  const list = (data[serverId] ??= {});
  const now = Date.now();
  const onlineKeys = new Set(online.map((p) => key(p.name)));
  for (const p of online) {
    const k = key(p.name);
    const rec = list[k];
    if (!rec) {
      list[k] = { name: p.name, id: p.platformId ?? null, firstSeen: now, lastSeen: now, joins: 1, playSeconds: 0, sessionStart: now };
      dirty = true;
    } else if (rec.sessionStart == null) {
      rec.sessionStart = now;
      rec.joins++;
      rec.lastSeen = now;
      rec.name = p.name;
      if (p.platformId) rec.id = p.platformId;
      dirty = true;
    } else if (!rec.id && p.platformId) {
      rec.id = p.platformId;
      dirty = true;
    }
  }
  for (const [k, rec] of Object.entries(list)) {
    if (rec.sessionStart != null && !onlineKeys.has(k)) {
      rec.playSeconds += Math.max(0, Math.round((now - rec.sessionStart) / 1000));
      rec.sessionStart = null;
      rec.lastSeen = now;
      dirty = true;
    }
  }
}

/** Everyone seen on a server, online first, then most recently seen. */
export function knownPlayers(serverId: string) {
  const now = Date.now();
  return Object.values(data[serverId] ?? {})
    .map((r) => ({
      ...r,
      online: r.sessionStart != null,
      lastSeen: r.sessionStart != null ? now : r.lastSeen,
      playSeconds: r.playSeconds + (r.sessionStart != null ? Math.round((now - r.sessionStart) / 1000) : 0),
    }))
    .sort((a, b) => Number(b.online) - Number(a.online) || b.lastSeen - a.lastSeen);
}

/** The record for a player (made if they've never been seen, so notes/mutes can be set ahead of time). */
function recordFor(serverId: string, name: string): PlayerRecord {
  const list = (data[serverId] ??= {});
  const k = key(name);
  list[k] ??= { name, id: null, firstSeen: Date.now(), lastSeen: Date.now(), joins: 0, playSeconds: 0, sessionStart: null };
  return list[k];
}

export function setPlayerNote(serverId: string, name: string, note: string) {
  const rec = recordFor(serverId, name);
  const clean = String(note ?? '').trim().slice(0, 500);
  if (clean) rec.note = clean;
  else delete rec.note;
  dirty = true;
  save();
}

export function setPlayerMuted(serverId: string, name: string, muted: boolean) {
  const rec = recordFor(serverId, name);
  if (muted) rec.muted = true;
  else delete rec.muted;
  dirty = true;
  save();
}

/** Names of muted players (sent to the chat relay pack when the server starts and whenever it changes). */
export function mutedPlayers(serverId: string): string[] {
  return Object.values(data[serverId] ?? {})
    .filter((r) => r.muted)
    .map((r) => r.name);
}

export function forgetPlayers(serverId: string) {
  if (data[serverId]) {
    delete data[serverId];
    dirty = true;
  }
}

function save() {
  if (!dirty) return;
  dirty = false;
  writeJson(FILE, data);
}
setInterval(save, 30_000).unref();
process.on('exit', save);
