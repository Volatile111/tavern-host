// World census (runs in a worker thread): reads a Bedrock world database once and records, per chunk, which of its
// parts exist (block layers, heightmap/biomes, version...) and which game version first generated it. Compared with
// the previous census of the same world it finds damage normal play never causes:
//   - chunks that are gone (the game never deletes chunks)
//   - chunks missing block layers under ones that are still there
//   - chunks generated again from scratch (their original game version changed: the data was lost and a player
//     walked there)
//   - database blocks whose checksum doesn't match
// Censuses are stored gzipped next to the world check state (about 19 bytes per chunk).
import { parentPort, workerData } from 'node:worker_threads';
import { gzipSync, gunzipSync } from 'node:zlib';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { newestFirst, type DbProblem } from './leveldb.ts';
import { readNamedTag, type Tag } from './games/bedrock-nbt.ts';

export interface Census {
  world: string;
  seed: string | null;
  at: number;
  /** Original game versions; chunks point into this list (-1 = unknown). */
  versions: string[];
  ids: string[]; // "dim,x,z"
  sub: number[]; // bit (layer + 4) set when that block layer exists
  tag: number[]; // bit (tag - 43) set when that chunk key exists
  ver: number[];
}

export interface Area {
  dimension: string;
  x: number;
  z: number;
  from: { x: number; z: number };
  to: { x: number; z: number };
  chunks: number;
  gone: number;
  holes: number;
  regenerated: number;
}

export interface CensusResult {
  world: string;
  chunks: number;
  /** Chunks in the census it was compared with (null: nothing to compare with yet, or a different world). */
  baselineChunks: number | null;
  baselineAt: number | null;
  gone: number;
  holes: number;
  regenerated: number;
  problems: DbProblem[];
  problemCount: number;
  areas: Area[];
  damaged: boolean;
}

const DIM = ['Overworld', 'Nether', 'End'];
const META_DICT = 'LevelChunkMetaDataDictionary';
// Chunk parts that exist for every generated chunk and never go away in normal play.
const REQUIRED_TAGS = [44, 54].map((t) => 1 << (t - 43)); // Version, FinalizedState

function chunkKey(key: Buffer): { id: string; tag: number; layer: number | null } | null {
  let dim = 0;
  let at = 8;
  if (key.length === 13 || key.length === 14) {
    dim = key.readInt32LE(8);
    if (dim !== 1 && dim !== 2) return null;
    at = 12;
  } else if (key.length !== 9 && key.length !== 10) return null;
  const tag = key[at];
  if (tag < 43 || tag > 74) return null;
  const layer = key.length === at + 2 ? key.readInt8(at + 1) : null;
  if (layer !== null && tag !== 47) return null;
  return { id: `${dim},${key.readInt32LE(0)},${key.readInt32LE(4)}`, tag, layer };
}

function plain(tag: Tag | undefined): unknown {
  if (!tag) return undefined;
  if (tag.type === 8) return tag.value;
  if (tag.type === 4) return tag.value.toString();
  return undefined;
}

/** Metadata hash (hex) -> OriginalBaseGameVersion, plus the world's generation seed. */
function readMetaDict(value: Buffer): { versions: Map<string, string>; seed: string | null } {
  const versions = new Map<string, string>();
  let seed: string | null = null;
  const count = value.readInt32LE(0);
  let p = 4;
  for (let i = 0; i < count; i++) {
    const hash = value.subarray(p, p + 8).toString('hex');
    const { tag, end } = readNamedTag(value, p + 8);
    p = end;
    if (tag.type !== 10) continue;
    const v = plain(tag.value.get('OriginalBaseGameVersion'));
    if (typeof v === 'string') versions.set(hash, v);
    seed ??= (plain(tag.value.get('GenerationSeed')) as string | undefined) ?? null;
  }
  return { versions, seed };
}

export function takeCensus(dbDir: string, world: string, onProgress?: (done: number, total: number) => void): { census: Census; problems: DbProblem[] } {
  const problems: DbProblem[] = [];
  const index = new Map<string, number>();
  const ids: string[] = [];
  const seenSub: number[] = [];
  const seenTag: number[] = [];
  const sub: number[] = [];
  const tag: number[] = [];
  const metaHash: (string | null)[] = [];
  let dict: Buffer | null = null;
  let dictSeen = false;
  for (const e of newestFirst(dbDir, problems, onProgress)) {
    if (!dictSeen && e.key.length === META_DICT.length && e.key.toString('latin1') === META_DICT) {
      dictSeen = true;
      dict = e.value ? Buffer.from(e.value) : null;
      continue;
    }
    const k = chunkKey(e.key);
    if (!k) continue;
    let i = index.get(k.id);
    if (i === undefined) {
      i = ids.length;
      index.set(k.id, i);
      ids.push(k.id);
      seenSub.push(0);
      seenTag.push(0);
      sub.push(0);
      tag.push(0);
      metaHash.push(null);
    }
    // The first sighting of a key is its newest version; later ones are older copies.
    if (k.layer !== null) {
      if (k.layer < -4 || k.layer > 27) continue;
      const bit = 1 << (k.layer + 4);
      if (seenSub[i] & bit) continue;
      seenSub[i] |= bit;
      if (e.value) sub[i] |= bit;
    } else {
      const bit = 1 << (k.tag - 43);
      if (seenTag[i] & bit) continue;
      seenTag[i] |= bit;
      if (!e.value) continue;
      tag[i] |= bit;
      if (k.tag === 63 && e.value.length === 8) metaHash[i] = e.value.toString('hex');
    }
  }
  let meta = { versions: new Map<string, string>(), seed: null as string | null };
  try {
    if (dict) meta = readMetaDict(dict);
  } catch (err) {
    problems.push({ file: META_DICT, what: `chunk metadata can't be read: ${(err as Error).message}` });
  }
  const versions: string[] = [];
  const verIndex = new Map<string, number>();
  const ver = metaHash.map((h) => {
    const v = h ? meta.versions.get(h) : undefined;
    if (!v) return -1;
    let n = verIndex.get(v);
    if (n === undefined) verIndex.set(v, (n = versions.push(v) - 1));
    return n;
  });
  // Drop "chunks" that only had deletions.
  const keep = ids.map((_, i) => sub[i] !== 0 || tag[i] !== 0);
  const pick = <T>(a: T[]) => a.filter((_, i) => keep[i]);
  return { census: { world, seed: meta.seed, at: Date.now(), versions, ids: pick(ids), sub: pick(sub), tag: pick(tag), ver: pick(ver) }, problems };
}

// ---------- storage ----------

export function saveCensus(file: string, c: Census) {
  const head = Buffer.from(JSON.stringify({ v: 1, world: c.world, seed: c.seed, at: c.at, versions: c.versions }));
  const rec = Buffer.alloc(c.ids.length * 19);
  for (let i = 0; i < c.ids.length; i++) {
    const [d, x, z] = c.ids[i].split(',').map(Number);
    const o = i * 19;
    rec.writeInt8(d, o);
    rec.writeInt32LE(x, o + 1);
    rec.writeInt32LE(z, o + 5);
    rec.writeUInt32LE(c.sub[i] >>> 0, o + 9);
    rec.writeUInt32LE(c.tag[i] >>> 0, o + 13);
    rec.writeInt16LE(c.ver[i], o + 17);
  }
  const len = Buffer.alloc(4);
  len.writeUInt32LE(head.length);
  writeFileSync(file, gzipSync(Buffer.concat([len, head, rec])));
}

export function loadCensus(file: string): Census | null {
  if (!existsSync(file)) return null;
  try {
    const buf = gunzipSync(readFileSync(file));
    const hl = buf.readUInt32LE(0);
    const head = JSON.parse(buf.toString('utf-8', 4, 4 + hl));
    const c: Census = { world: head.world, seed: head.seed, at: head.at, versions: head.versions, ids: [], sub: [], tag: [], ver: [] };
    for (let o = 4 + hl; o + 19 <= buf.length; o += 19) {
      c.ids.push(`${buf.readInt8(o)},${buf.readInt32LE(o + 1)},${buf.readInt32LE(o + 5)}`);
      c.sub.push(buf.readUInt32LE(o + 9) | 0);
      c.tag.push(buf.readUInt32LE(o + 13) | 0);
      c.ver.push(buf.readInt16LE(o + 17));
    }
    return c;
  } catch {
    return null;
  }
}

// ---------- comparison ----------

/** Bits of layers below the highest layer that exists: a missing one there is a hole in the column. */
const holesIn = (before: number, now: number) => {
  if (!now) return 0;
  const top = 31 - Math.clz32(now);
  const below = top >= 31 ? 0x7fffffff : (1 << top) - 1;
  return before & ~now & below;
};

export function compare(base: Census | null, now: Census, problems: DbProblem[]): CensusResult {
  const result: CensusResult = {
    world: now.world,
    chunks: now.ids.length,
    baselineChunks: null,
    baselineAt: null,
    gone: 0,
    holes: 0,
    regenerated: 0,
    problems: problems.slice(0, 20),
    problemCount: problems.length,
    areas: [],
    damaged: problems.length > 0,
  };
  // Nothing to compare with, or a different world (switched or replaced): this census becomes the reference.
  if (!base || base.world !== now.world || (base.seed && now.seed && base.seed !== now.seed)) return result;
  result.baselineChunks = base.ids.length;
  result.baselineAt = base.at;
  const at = new Map<string, number>();
  now.ids.forEach((id, i) => at.set(id, i));
  const flagged = new Map<string, 'gone' | 'holes' | 'regenerated'>();
  for (let i = 0; i < base.ids.length; i++) {
    const id = base.ids[i];
    const j = at.get(id);
    if (j === undefined) {
      flagged.set(id, 'gone');
      continue;
    }
    const vb = base.ver[i] >= 0 ? base.versions[base.ver[i]] : null;
    const vn = now.ver[j] >= 0 ? now.versions[now.ver[j]] : null;
    if (vb && vn && vb !== vn) {
      flagged.set(id, 'regenerated');
      continue;
    }
    const lostRequired = REQUIRED_TAGS.some((bit) => base.tag[i] & bit && !(now.tag[j] & bit));
    if (holesIn(base.sub[i], now.sub[j]) || lostRequired) flagged.set(id, 'holes');
  }
  for (const kind of flagged.values()) result[kind]++;
  result.damaged ||= flagged.size > 0;
  result.areas = groupAreas(flagged);
  return result;
}

/** Joins neighbouring damaged chunks into areas (biggest first, at most 40). */
function groupAreas(flagged: Map<string, 'gone' | 'holes' | 'regenerated'>): Area[] {
  const seen = new Set<string>();
  const areas: Area[] = [];
  for (const start of flagged.keys()) {
    if (seen.has(start)) continue;
    seen.add(start);
    const stack = [start];
    const group: string[] = [];
    while (stack.length) {
      const id = stack.pop()!;
      group.push(id);
      const [d, x, z] = id.split(',').map(Number);
      for (let dx = -1; dx <= 1; dx++)
        for (let dz = -1; dz <= 1; dz++) {
          const n = `${d},${x + dx},${z + dz}`;
          if (flagged.has(n) && !seen.has(n)) {
            seen.add(n);
            stack.push(n);
          }
        }
    }
    const pts = group.map((g) => g.split(',').map(Number));
    const xs = pts.map((p) => p[1]);
    const zs = pts.map((p) => p[2]);
    const [minX, maxX, minZ, maxZ] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
    const count = (k: string) => group.filter((g) => flagged.get(g) === k).length;
    areas.push({
      dimension: DIM[pts[0][0]] ?? `Dimension ${pts[0][0]}`,
      x: Math.round(((minX + maxX) / 2) * 16 + 8),
      z: Math.round(((minZ + maxZ) / 2) * 16 + 8),
      from: { x: minX * 16, z: minZ * 16 },
      to: { x: maxX * 16 + 15, z: maxZ * 16 + 15 },
      chunks: group.length,
      gone: count('gone'),
      holes: count('holes'),
      regenerated: count('regenerated'),
    });
  }
  return areas.sort((a, b) => b.chunks - a.chunks).slice(0, 40);
}

// ---------- worker entry ----------

if (parentPort && workerData?.dbDir) {
  const { dbDir, world, baselineFile, outFile } = workerData as { dbDir: string; world: string; baselineFile: string; outFile: string };
  try {
    let last = 0;
    const { census, problems } = takeCensus(dbDir, world, (done, total) => {
      if (Date.now() - last > 1000 || done === total) {
        last = Date.now();
        parentPort!.postMessage({ type: 'progress', done, total });
      }
    });
    const result = compare(loadCensus(baselineFile), census, problems);
    saveCensus(outFile, census);
    parentPort.postMessage({ type: 'done', result });
  } catch (err) {
    parentPort.postMessage({ type: 'error', message: (err as Error).message });
  }
}
