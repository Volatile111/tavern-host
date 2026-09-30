// Reads defeated bosses from a Valheim world save.
// Valheim 1.0 saves a world as a folder of files; _main.<n>.db2 holds world-wide state (incl. global keys)
// as: int32 version, double world time, int32 length, then a gzip stream. Pre-1.0 worlds are one .db file.
import { stat, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import path from 'node:path';

// In progression order. `key` is the global key set when the boss is defeated.
// Kall's key isn't known yet: any unrecognised "defeated_*" key is treated as Kall.
export const BOSSES = [
  { id: 'eikthyr', name: 'Eikthyr', key: 'defeated_eikthyr' },
  { id: 'elder', name: 'The Elder', key: 'defeated_gdking' },
  { id: 'bonemass', name: 'Bonemass', key: 'defeated_bonemass' },
  { id: 'moder', name: 'Moder', key: 'defeated_dragon' },
  { id: 'yagluth', name: 'Yagluth', key: 'defeated_goblinking' },
  { id: 'queen', name: 'The Queen', key: 'defeated_queen' },
  { id: 'fader', name: 'Fader', key: 'defeated_fader' },
  { id: 'kall', name: 'Kall', key: null },
] as const;
const NON_BOSS_KEYS = new Set(['defeated_serpent']);

export interface WorldInfo {
  saveFile: string;
  savedAt: number;
  bosses: { id: string; name: string; defeated: boolean }[];
  unknownKeys: string[];
}

const cache = new Map<string, { mtimeMs: number; info: WorldInfo }>();

/** The newest complete save for a world: highest _main.<n>.db2 that has its .ok marker (1.0), or <world>.db. */
async function findSaveFile(worldsDir: string, world: string): Promise<string | null> {
  const folder = path.join(worldsDir, world);
  if (existsSync(folder)) {
    const files = await readdir(folder);
    const saves = files
      .map((f) => /^_main\.(\d+)\.db2$/.exec(f))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => ({ file: m[0], n: Number(m[1]), ok: files.includes(`_main.${m[1]}.ok`) }))
      .sort((a, b) => b.n - a.n);
    const best = saves.find((s) => s.ok) ?? saves[0];
    if (best) return path.join(folder, best.file);
  }
  const legacy = path.join(worldsDir, `${world}.db`);
  return existsSync(legacy) ? legacy : null;
}

function worldData(buf: Buffer): Buffer {
  const gzipAt = buf.subarray(0, 64).indexOf(Buffer.from([0x1f, 0x8b, 0x08]));
  // Skip the fixed 10-byte gzip header and inflate; gunzip would reject the data that follows the stream.
  return gzipAt === -1 ? buf : inflateRawSync(buf.subarray(gzipAt + 10));
}

function defeatedKeys(data: Buffer): Set<string> {
  const keys = new Set<string>();
  for (const m of data.toString('latin1').matchAll(/defeated_[a-z0-9_]+/g)) {
    // Global keys are length-prefixed strings; requiring the length byte avoids matching e.g. sign text.
    if (data[m.index - 1] === m[0].length) keys.add(m[0]);
  }
  return keys;
}

export async function readWorldInfo(worldsDir: string, world: string): Promise<WorldInfo | null> {
  const saveFile = await findSaveFile(worldsDir, world);
  if (!saveFile) return null;
  const { mtimeMs } = await stat(saveFile);
  const cached = cache.get(saveFile);
  if (cached?.mtimeMs === mtimeMs) return cached.info;

  const keys = defeatedKeys(worldData(await readFile(saveFile)));
  const known = new Set<string>(BOSSES.map((b) => b.key).filter((k): k is NonNullable<typeof k> => k !== null));
  const unknownKeys = [...keys].filter((k) => !known.has(k) && !NON_BOSS_KEYS.has(k));
  const info: WorldInfo = {
    saveFile,
    savedAt: mtimeMs,
    bosses: BOSSES.map((b) => ({ id: b.id, name: b.name, defeated: b.key ? keys.has(b.key) : unknownKeys.length > 0 })),
    unknownKeys,
  };
  cache.set(saveFile, { mtimeMs, info });
  return info;
}
