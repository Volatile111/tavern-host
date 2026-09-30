// Repairs lost chunks in a Bedrock world by bringing them back from an older, known-good copy of the same world.
//   node tools/world-repair.mjs "<good world>" "<current world>" "<output world>" [--dry-run]
// Never writes to either input: the current world is copied to <output world> first, and the repair is added to the
// copy as one extra database log file, which the game replays (and folds into its tables) the next time it opens it.
//
// Chunks restored:
//   - GONE: chunks the good copy has and the current world doesn't have at all
//   - REGENERATED: chunks that had builds on the good copy and now hold (almost) only natural terrain
// For each, every key of the chunk is replaced (blocks, biomes, block entities, ticks...), along with its entity
// list (digp) and the entities on it (actorprefix). Entities that have since moved to a chunk that isn't being
// restored are left where they are, so nothing is duplicated.
import { writeFileSync, openSync, writeSync, closeSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { openWorldDb, crc32c } from './leveldb-read.mjs';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const [goodDir, currentDir, outDir] = args.filter((a) => !a.startsWith('--'));
if (!goodDir || !currentDir || !outDir) {
  console.error('usage: node world-repair.mjs <good world> <current world> <output world> [--dry-run]');
  process.exit(1);
}
if (!dryRun && existsSync(outDir) && readdirSync(outDir).length) {
  console.error(`${outDir} already exists and isn't empty; pick a new output folder.`);
  process.exit(1);
}

const BUILD = /planks|glass|brick|concrete|wool|torch|lantern|door|fence|stairs|slab|chest|furnace|crafting_table|_bed\b|^minecraft:bed$|sign|rail|hopper|dispenser|dropper|lever|redstone|repeater|comparator|bookshelf|carpet|polished|smooth_|cut_|chiseled|quartz|barrel|smoker|anvil|enchanting|lectern|loom|cartography|fletching|grindstone|stonecutter|composter|campfire|scaffolding|ladder|glazed|banner|frame|flower_pot|candle|beacon|observer|piston|daylight|target|shulker|ender_chest|brewing|cauldron|end_rod|sea_lantern|froglight|iron_block|gold_block|diamond_block|emerald_block|lapis_block|netherite_block|copper_block|waxed|tiles|trapdoor|button|pressure_plate|wall\b|_wall$|pane|bars|chain$/;
const NATURAL_ADDON = /ore|crop|bush|plant|flower|grass|leaves|log|sapling|mushroom|berry|vine|seed|stone$|dirt|sand|gravel/;
const NATURAL_ANY = /ore$|_ore_|:raw_|infested/;
function isBuild(name) {
  if (NATURAL_ANY.test(name)) return false;
  if (!name.startsWith('minecraft:')) return !NATURAL_ADDON.test(name);
  return BUILD.test(name);
}
const NAME_RE = /\x08\x04\x00name([\s\S])([\s\S])([a-z0-9_\-.]+:[a-z0-9_\-.:/]+)/g;

const DIGP = Buffer.from('digp');
const ACTOR = Buffer.from('actorprefix');

/** What a key is: chunk data { kind:'chunk', id, tag }, an entity list { kind:'digp', id }, an entity, or other. */
function classify(key) {
  if (key.length === 9 || key.length === 10) return { kind: 'chunk', id: `0,${key.readInt32LE(0)},${key.readInt32LE(4)}`, tag: key[8] };
  if (key.length === 13 || key.length === 14) {
    const dim = key.readInt32LE(8);
    if (dim === 1 || dim === 2) return { kind: 'chunk', id: `${dim},${key.readInt32LE(0)},${key.readInt32LE(4)}`, tag: key[12] };
  }
  if ((key.length === 12 || key.length === 16) && key.subarray(0, 4).equals(DIGP)) {
    const dim = key.length === 16 ? key.readInt32LE(12) : 0;
    return { kind: 'digp', id: `${dim},${key.readInt32LE(4)},${key.readInt32LE(8)}` };
  }
  if (key.length === 19 && key.subarray(0, 11).equals(ACTOR)) return { kind: 'actor' };
  return null;
}

const pool = new Map();
const intern = (s) => pool.get(s) ?? (pool.set(s, s), s);
const BE = '\u0001'; // marker: chunk has block entities (chests, signs...)

const META_DICT = 'LevelChunkMetaDataDictionary';

function summarize(key, value) {
  if (key.length === META_DICT.length && key.toString('latin1') === META_DICT) return Buffer.from(value);
  const c = classify(key);
  if (!c) return undefined;
  if (c.kind === 'digp') return Buffer.from(value); // list of 8-byte entity ids
  if (c.kind === 'actor') return 1;
  if (c.tag === 49) return value.length ? BE : 0;
  if (c.tag === 63) return intern(value.toString('hex')); // key into the chunk metadata dictionary
  if (c.tag !== 47) return 0;
  const text = value.toString('latin1');
  let names = null;
  NAME_RE.lastIndex = 0;
  let m;
  while ((m = NAME_RE.exec(text))) if (isBuild(m[3])) (names ??= new Set()).add(m[3]);
  // block layer: [checksum of its data, build names] — to tell which layers changed
  return [crc32c(value), names ? intern([...names].sort().join('|')) : 0];
}

/** Newest live version of every interesting key: latin1 key -> [seq, summary]. */
function load(db, label, pick = summarize) {
  const newest = new Map();
  const t0 = Date.now();
  for (const e of db.entries((n, total) => {
    if (n % 100 === 0 || n === total) process.stderr.write(`\r${label}: ${n}/${total} files, ${Math.round(process.memoryUsage().rss / 2 ** 20)} MB   `);
  })) {
    const summary = e.deleted ? null : pick(e.key, e.value);
    if (summary === undefined) continue;
    const k = e.key.toString('latin1');
    const seq = Number(e.seq);
    const old = newest.get(k);
    if (old && old[0] >= seq) continue;
    newest.set(k, [seq, summary]);
  }
  for (const [k, e] of newest) if (e[1] === null) newest.delete(k);
  process.stderr.write(`\r${label}: ${newest.size} keys, ${((Date.now() - t0) / 1000).toFixed(0)} s${' '.repeat(30)}\n`);
  return newest;
}

/** Per chunk: build block names, whether it has block entities, and its entity list. */
function chunkInfo(map) {
  const out = new Map();
  const get = (id) => out.get(id) ?? (out.set(id, { build: new Set(), be: false, hasData: false, digp: false, actors: [], keys: [] }), out.get(id));
  for (const [k, [, s]] of map) {
    const key = Buffer.from(k, 'latin1');
    const c = classify(key);
    if (!c || c.kind === 'actor') continue;
    const info = get(c.id);
    if (c.kind === 'digp') {
      info.digp = true;
      for (let i = 0; i + 8 <= s.length; i += 8) info.actors.push(s.subarray(i, i + 8).toString('hex'));
      continue;
    }
    info.hasData = true;
    // which of the chunk's keys exist: tag, plus the layer index for block layers (SubChunkPrefix)
    const tail = key.subarray(key.length === 10 || key.length === 14 ? key.length - 2 : key.length - 1);
    info.keys.push(tail.length === 2 ? c.tag * 1000 + tail[1] : c.tag * 1000 + 999);
    if (c.tag === 63) info.meta = s;
    else if (Array.isArray(s)) {
      (info.layers ??= new Map()).set(tail[1], s[0]);
      if (s[1]) for (const n of s[1].split('|')) info.build.add(n);
    } else if (s === BE) info.be = true;
    else if (s) for (const n of s.split('|')) info.build.add(n);
  }
  return out;
}

// ---------- 1. what's damaged ----------
const goodDb = openWorldDb(path.join(goodDir, 'db'));
const curDb = openWorldDb(path.join(currentDir, 'db'));
for (const [label, db] of [['good copy', goodDb], ['current world', curDb]]) {
  const missing = db.problems.filter((p) => /missing/.test(p.what));
  if (missing.length) {
    console.error(`The ${label}'s database is missing ${missing.length} table file(s) it needs; refusing to work from it.`);
    process.exit(1);
  }
}

/**
 * The world's chunk metadata dictionary: metadata hash (hex) -> the game version that first generated the chunks
 * using it (OriginalBaseGameVersion). Format: count, then per entry an 8-byte hash and a little-endian NBT compound.
 */
function originalVersions(map) {
  const b = map.get(META_DICT)?.[1];
  const out = new Map();
  if (!b) return out;
  let p = 0;
  const str = () => { const n = b.readUInt16LE(p); p += 2; const s = b.toString('utf8', p, p + n); p += n; return s; };
  const SIZES = { 1: 1, 2: 2, 3: 4, 4: 8, 5: 4, 6: 8 };
  function value(t) {
    if (SIZES[t]) { p += SIZES[t]; return null; }
    if (t === 8) return str();
    if (t === 7) { p += 4 + b.readInt32LE(p); return null; }
    if (t === 11) { p += 4 + b.readInt32LE(p) * 4; return null; }
    if (t === 12) { p += 4 + b.readInt32LE(p) * 8; return null; }
    if (t === 9) { const et = b[p++]; const n = b.readInt32LE(p); p += 4; for (let i = 0; i < n; i++) value(et); return null; }
    if (t === 10) { const o = {}; for (;;) { const tt = b[p++]; if (!tt) return o; const name = str(); o[name] = value(tt); } }
    throw new Error(`unexpected NBT tag ${t} in the chunk metadata dictionary`);
  }
  const count = b.readInt32LE(0);
  p = 4;
  for (let i = 0; i < count; i++) {
    const hash = b.subarray(p, p + 8).toString('hex');
    p += 8;
    const t = b[p++];
    str();
    out.set(hash, value(t)?.OriginalBaseGameVersion ?? null);
  }
  return out;
}
const newerVersion = (a, b) => {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};

let goodMap = load(goodDb, 'reading good copy   ');
const goodOrig = originalVersions(goodMap);
let goodInfo = chunkInfo(goodMap);
goodMap = null;
const curMap = load(curDb, 'reading current world');
const curOrig = originalVersions(curMap);
const curInfo = chunkInfo(curMap);
// newest version that had generated anything by the time of the good copy
const goodNewest = [...goodOrig.values()].filter(Boolean).reduce((a, v) => (!a || newerVersion(v, a) ? v : a), null);
console.log(`Chunk metadata: good copy ${goodOrig.size} entries (newest generator ${goodNewest}), current ${curOrig.size}`);

const restore = new Map(); // id -> reason
for (const [id, before] of goodInfo) {
  if (!before.hasData) continue;
  const now = curInfo.get(id);
  if (!now || !now.hasData) {
    restore.set(id, 'gone');
    continue;
  }
  // The game version that first generated a chunk never changes — unless the chunk is generated again from scratch
  // (its data was lost). Catches regenerated chunks even where the generator reproduced some layers byte for byte.
  const origBefore = goodOrig.get(before.meta) ?? null;
  const origNow = curOrig.get(now.meta) ?? null;
  if (origNow && (origBefore ? origNow !== origBefore : goodNewest && newerVersion(origNow, goodNewest))) {
    restore.set(id, 'regenerated');
    continue;
  }
  // Every block layer rewritten, down to the deepest: the chunk was generated again from scratch (players only
  // change the layers they build or dig in).
  if (before.layers && now.layers) {
    const common = [...before.layers.keys()].filter((l) => now.layers.has(l));
    const changed = common.filter((l) => before.layers.get(l) !== now.layers.get(l)).length;
    const deepest = Math.min(...common.map((l) => (l >= 128 ? l - 256 : l)));
    const deepKey = deepest < 0 ? deepest + 256 : deepest;
    if (common.length >= 4 && changed === common.length && before.layers.get(deepKey) !== now.layers.get(deepKey)) {
      restore.set(id, 'regenerated');
      continue;
    }
  }
  if (before.build.size < 3) continue;
  const kept = [...before.build].filter((n) => now.build.has(n)).length / before.build.size;
  const regenerated = kept <= 0.3 && now.build.size <= Math.max(2, before.build.size * 0.3);
  const lostBlockEntities = before.be && !now.be && kept <= 0.5;
  if (regenerated || lostBlockEntities) restore.set(id, 'regenerated');
}

// PARTIAL: chunks that still exist but lost some of their keys (block layers, block entities, biome data...) —
// normal play never deletes those. Only the missing keys come back; what survived (and any changes since) stays.
const chunkKey = (id, code) => {
  const [d, x, z] = id.split(',').map(Number);
  const tag = Math.floor(code / 1000), sub = code % 1000;
  const b = Buffer.alloc((d ? 12 : 8) + (sub === 999 ? 1 : 2));
  b.writeInt32LE(x, 0);
  b.writeInt32LE(z, 4);
  if (d) b.writeInt32LE(d, 8);
  b[d ? 12 : 8] = tag;
  if (sub !== 999) b[d ? 13 : 9] = sub;
  return b.toString('latin1');
};
const partialKeys = new Set(); // latin1 keys to bring back
const partial = new Map(); // id -> number of missing keys
for (const [id, before] of goodInfo) {
  if (!before.hasData || restore.has(id)) continue;
  const now = curInfo.get(id);
  if (!now?.hasData) continue;
  const have = new Set(now.keys);
  const missing = before.keys.filter((c) => !have.has(c));
  // lost entity list: bring it (and its entities) back too
  const lostDigp = before.digp && !now.digp;
  if (!missing.length && !lostDigp) continue;
  for (const c of missing) partialKeys.add(chunkKey(id, c));
  partial.set(id, { missing: missing.length, digp: lostDigp });
}

// Entities that are alive on some chunk that isn't being restored stay as they are.
const aliveElsewhere = new Set();
for (const [id, info] of curInfo) if (!restore.has(id)) for (const a of info.actors) aliveElsewhere.add(a);

// Keys to remove from the current world: everything on the restored chunks, and their entities.
const deletes = [];
const curActorsOnRestored = new Set();
for (const [id] of restore) for (const a of curInfo.get(id)?.actors ?? []) if (!aliveElsewhere.has(a)) curActorsOnRestored.add(a);
for (const [k] of curMap) {
  const key = Buffer.from(k, 'latin1');
  const c = classify(key);
  if (!c) continue;
  if (c.kind === 'actor') {
    if (curActorsOnRestored.has(key.subarray(11).toString('hex'))) deletes.push(key);
  } else if (restore.has(c.id)) deletes.push(key);
}

// Entities to bring back: those on the restored chunks in the good copy, unless they're alive elsewhere now.
const wantActors = new Set();
let skippedActors = 0;
const lostDigp = new Set([...partial].filter(([, p]) => p.digp).map(([id]) => id));
for (const id of [...restore.keys(), ...lostDigp]) for (const a of goodInfo.get(id).actors) aliveElsewhere.has(a) ? skippedActors++ : wantActors.add(a);

const DIM = ['Overworld', 'Nether', 'End'];
const byReason = { gone: [0, 0, 0], regenerated: [0, 0, 0] };
for (const [id, why] of restore) byReason[why][Number(id.split(',')[0])]++;
console.log(`\nChunks to restore: ${restore.size}`);
for (const why of ['gone', 'regenerated']) console.log(`  ${why.padEnd(12)} ${byReason[why].map((n, d) => `${DIM[d]} ${n}`).join(', ')}`);
const partialByDim = [0, 0, 0];
for (const id of partial.keys()) partialByDim[Number(id.split(',')[0])]++;
console.log(`Chunks missing some of their data (only the missing parts come back): ${partial.size}`);
console.log(`  ${partialByDim.map((n, d) => `${DIM[d]} ${n}`).join(', ')}; ${partialKeys.size} keys, ${lostDigp.size} lost their entity list`);
console.log(`Keys to remove from the current world: ${deletes.length}`);
console.log(`Entities to bring back: ${wantActors.size} (${skippedActors} left alone: they're alive elsewhere now)`);

writeFileSync(path.join(path.dirname(path.resolve(outDir)), `${path.basename(outDir)}-repair-list.json`),
  JSON.stringify([...[...restore], ...[...partial.keys()].map((id) => [id, 'partial'])].map(([id, why]) => { const [d, x, z] = id.split(',').map(Number); return { dimension: DIM[d], x: x * 16, z: z * 16, why }; })));
if (dryRun) process.exit(0);

// ---------- 2. which versions of the good copy's keys to bring back ----------
curMap.clear();
const wanted = (key) => {
  const c = classify(key);
  if (!c) return undefined;
  if (c.kind === 'actor') return wantActors.has(key.subarray(11).toString('hex')) ? 1 : undefined;
  if (c.kind === 'digp') return restore.has(c.id) || lostDigp.has(c.id) ? 1 : undefined;
  return restore.has(c.id) || partialKeys.has(key.toString('latin1')) ? 1 : undefined;
};
goodInfo = null;
const pickFrom = load(goodDb, 'choosing good keys  ', wanted); // key -> [newest seq]

// ---------- 3. write the copy and the repair log ----------
console.log(`\nCopying ${currentDir}\n     to ${outDir} ...`);
try {
  execFileSync('robocopy', [currentDir, outDir, '/E', '/R:1', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'], { stdio: 'inherit' });
} catch (err) {
  if (err.status >= 8) throw new Error(`robocopy failed (exit ${err.status})`);
}

const outDb = openWorldDb(path.join(outDir, 'db'));
let seq = outDb.manifest.lastSequence;
for (const e of outDb.entries()) if (e.file.endsWith('.log') && e.seq > seq) seq = e.seq;
seq += 1000n;
const logNum = Math.max(outDb.manifest.nextFile, outDb.maxFileNumber + 1);
const logFile = path.join(outDir, 'db', `${String(logNum).padStart(6, '0')}.log`);

// LevelDB log format: 32 KB blocks of records [masked crc32c, length, type, data]; a batch spans records.
const fd = openSync(logFile, 'wx');
let blockOffset = 0;
const mask = (c) => ((((c >>> 15) | (c << 17)) >>> 0) + 0xa282ead8) >>> 0;
function writeRecord(data) {
  let left = data.length, pos = 0, begin = true;
  do {
    const room = 32768 - blockOffset;
    if (room < 7) {
      if (room > 0) writeSync(fd, Buffer.alloc(room));
      blockOffset = 0;
    }
    const avail = 32768 - blockOffset - 7;
    const len = Math.min(left, avail);
    const end = len === left;
    const type = begin && end ? 1 : begin ? 2 : end ? 4 : 3;
    const header = Buffer.alloc(7);
    const body = data.subarray(pos, pos + len);
    header.writeUInt32LE(mask(crc32c(Buffer.concat([Buffer.from([type]), body]))), 0);
    header.writeUInt16LE(len, 4);
    header[6] = type;
    writeSync(fd, header);
    writeSync(fd, body);
    blockOffset += 7 + len;
    pos += len;
    left -= len;
    begin = false;
  } while (left > 0);
}
const varintBuf = (n) => {
  const out = [];
  while (n >= 0x80) { out.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); }
  out.push(n);
  return Buffer.from(out);
};
let batch = [], batchBytes = 0, batchCount = 0, written = 0;
function flush() {
  if (!batchCount) return;
  const head = Buffer.alloc(12);
  head.writeBigUInt64LE(seq, 0);
  head.writeUInt32LE(batchCount, 8);
  writeRecord(Buffer.concat([head, ...batch]));
  seq += BigInt(batchCount);
  batch = []; batchBytes = 0; batchCount = 0;
}
function add(key, value) {
  const parts = value ? [Buffer.from([1]), varintBuf(key.length), key, varintBuf(value.length), value] : [Buffer.from([0]), varintBuf(key.length), key];
  batch.push(...parts);
  batchBytes += key.length + (value?.length ?? 0) + 12;
  batchCount++;
  written++;
  if (batchBytes > 1 << 20) flush();
}

for (const key of deletes) add(key, null);
flush();
let puts = 0;
for (const e of goodDb.entries((n, total) => {
  if (n % 100 === 0 || n === total) process.stderr.write(`\rwriting repair log   : ${n}/${total} files, ${puts} keys   `);
})) {
  if (e.deleted) continue;
  const k = e.key.toString('latin1');
  const want = pickFrom.get(k);
  if (!want || want[0] !== Number(e.seq)) continue;
  pickFrom.delete(k); // once per key
  let value = Buffer.from(e.value);
  if (classify(e.key)?.kind === 'digp') {
    // leave out entities that are alive on another chunk now, so none is listed twice
    const ids = [];
    for (let i = 0; i + 8 <= value.length; i += 8) if (!aliveElsewhere.has(value.subarray(i, i + 8).toString('hex'))) ids.push(value.subarray(i, i + 8));
    value = Buffer.concat(ids);
  }
  add(Buffer.from(e.key), value);
  puts++;
}
flush();
closeSync(fd);
process.stderr.write('\n');
console.log(`\nRepair log: ${logFile}`);
console.log(`  ${deletes.length} keys removed, ${puts} keys restored (${written} records)`);
console.log(`Repaired world: ${outDir}\nOpen it with a server (not the live one) and check it before using it.`);
