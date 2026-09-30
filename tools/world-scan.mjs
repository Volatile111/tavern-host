// Finds damaged chunks in a Bedrock world by comparing it with an older, known-good copy (read-only).
//   node tools/world-scan.mjs "<good world folder>" "<current world folder>" [report.json]
// Flags, in every dimension:
//   - LOST BUILDS: chunks that had player/addon blocks before and now hold only natural terrain (regenerated)
//   - MISSING: chunks that existed before and are gone now (they regenerate when someone goes near)
// and every database block whose checksum doesn't match (data stored damaged).
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { openWorldDb } from './leveldb-read.mjs';

const [goodDir, currentDir, reportFile] = process.argv.slice(2);
if (!goodDir || !currentDir) {
  console.error('usage: node world-scan.mjs <good world> <current world> [report.json]');
  process.exit(1);
}
const DIM = { 0: 'Overworld', 1: 'Nether', 2: 'End' };

// Blocks players place (or addons add) that terrain generation doesn't produce on its own.
const BUILD = /planks|glass|brick|concrete|wool|torch|lantern|door|fence|stairs|slab|chest|furnace|crafting_table|_bed\b|^minecraft:bed$|sign|rail|hopper|dispenser|dropper|lever|redstone|repeater|comparator|bookshelf|carpet|polished|smooth_|cut_|chiseled|quartz|barrel|smoker|anvil|enchanting|lectern|loom|cartography|fletching|grindstone|stonecutter|composter|campfire|scaffolding|ladder|glazed|banner|frame|flower_pot|candle|beacon|observer|piston|daylight|target|shulker|ender_chest|brewing|cauldron|end_rod|sea_lantern|froglight|iron_block|gold_block|diamond_block|emerald_block|lapis_block|netherite_block|copper_block|waxed|tiles|trapdoor|button|pressure_plate|wall\b|_wall$|pane|bars|chain$/;
// Addon blocks that generate naturally (ores, crops, plants) don't count as builds.
const NATURAL_ADDON = /ore|crop|bush|plant|flower|grass|leaves|log|sapling|mushroom|berry|vine|seed|stone$|dirt|sand|gravel/;
// Ores and raw stone (vanilla and addons like Chisel) generate on their own.
const NATURAL_ANY = /ore$|_ore_|:raw_|infested/;
function isBuild(name) {
  if (NATURAL_ANY.test(name)) return false;
  const [ns] = name.split(':');
  if (ns !== 'minecraft') return !NATURAL_ADDON.test(name);
  return BUILD.test(name);
}

const NAME_RE = /\x08\x04\x00name([\s\S])([\s\S])([a-z0-9_\-.]+:[a-z0-9_\-.:/]+)/g;
const pool = new Map();
const intern = (s) => {
  let v = pool.get(s);
  if (v === undefined) pool.set(s, (v = s));
  return v;
};

/** Chunk key layout: x(int32) z(int32) [dim(int32)] tag [subchunk]. */
function parseChunkKey(key) {
  if (key.length === 9 || key.length === 10) return { x: key.readInt32LE(0), z: key.readInt32LE(4), dim: 0, tag: key[8] };
  if (key.length === 13 || key.length === 14) {
    const dim = key.readInt32LE(8);
    if (dim === 1 || dim === 2) return { x: key.readInt32LE(0), z: key.readInt32LE(4), dim, tag: key[12] };
  }
  return null;
}

// Per entry only a tiny summary is kept: 0 for chunk data without builds, or the build block names joined by "|"
// (interned). Keys that aren't chunk data are skipped entirely.
const EMPTY = 0;
function summarize(key, value) {
  const k = parseChunkKey(key);
  if (!k) return undefined;
  if (k.tag !== 47 || !value) return EMPTY;
  // Palette block names are stored as little-endian NBT strings: tag 8, "name", then the id.
  const text = value.toString('latin1');
  let names = null;
  NAME_RE.lastIndex = 0;
  let m;
  while ((m = NAME_RE.exec(text))) {
    if (!isBuild(m[3])) continue;
    (names ??= new Set()).add(m[3]);
  }
  return names ? intern([...names].sort().join('|')) : EMPTY;
}

function chunks(map) {
  const out = new Map(); // "dim,x,z" -> { dim, x, z, build:Set }
  for (const [key, [, summary]] of map) {
    const k = parseChunkKey(Buffer.from(key, 'latin1'));
    if (!k) continue;
    const id = `${k.dim},${k.x},${k.z}`;
    let c = out.get(id);
    if (!c) out.set(id, (c = { dim: k.dim, x: k.x, z: k.z, build: new Set() }));
    if (summary) for (const n of summary.split('|')) c.build.add(n);
  }
  return out;
}

function load(dir, label) {
  const db = openWorldDb(path.join(dir, 'db'));
  const t0 = Date.now();
  let map = db.load(summarize, (n, total) => {
    if (n % 100 === 0 || n === total) process.stderr.write(`\r${label}: ${n}/${total} files, ${Math.round(process.memoryUsage().rss / 2 ** 20)} MB`);
  });
  process.stderr.write(`\r${label}: ${db.files.length} files, ${map.size} chunk entries, ${((Date.now() - t0) / 1000).toFixed(0)} s\n`);
  const result = { chunks: chunks(map), problems: db.problems };
  map = null; // let the per-entry map go before the next world loads
  return result;
}

const good = load(goodDir, 'good world   ');
const current = load(currentDir, 'current world');

const flagged = [];
for (const [id, before] of good.chunks) {
  if (before.build.size < 3) continue; // nothing built there before
  const now = current.chunks.get(id);
  if (!now) {
    flagged.push({ kind: 'missing', dim: before.dim, x: before.x, z: before.z, lost: [...before.build].slice(0, 8), before: before.build.size, after: 0 });
    continue;
  }
  const kept = [...before.build].filter((n) => now.build.has(n)).length;
  // Most of what was built is gone, and what's left looks like natural terrain.
  if (kept / before.build.size <= 0.3 && now.build.size <= Math.max(2, before.build.size * 0.3)) {
    flagged.push({ kind: 'lost-builds', dim: before.dim, x: before.x, z: before.z, lost: [...before.build].filter((n) => !now.build.has(n)).slice(0, 8), before: before.build.size, after: now.build.size });
  }
}

// Group neighbouring chunks into areas.
const byId = new Map(flagged.map((f) => [`${f.dim},${f.x},${f.z}`, f]));
const seen = new Set();
const areas = [];
for (const f of flagged) {
  const id = `${f.dim},${f.x},${f.z}`;
  if (seen.has(id)) continue;
  const group = [];
  const stack = [f];
  seen.add(id);
  while (stack.length) {
    const c = stack.pop();
    group.push(c);
    for (let dx = -1; dx <= 1; dx++)
      for (let dz = -1; dz <= 1; dz++) {
        const nid = `${c.dim},${c.x + dx},${c.z + dz}`;
        if (byId.has(nid) && !seen.has(nid)) {
          seen.add(nid);
          stack.push(byId.get(nid));
        }
      }
  }
  const xs = group.map((g) => g.x);
  const zs = group.map((g) => g.z);
  const cx = Math.round(((Math.min(...xs) + Math.max(...xs)) / 2) * 16 + 8);
  const cz = Math.round(((Math.min(...zs) + Math.max(...zs)) / 2) * 16 + 8);
  const lost = new Map();
  for (const g of group) for (const n of g.lost) lost.set(n, (lost.get(n) ?? 0) + 1);
  areas.push({
    dimension: DIM[f.dim],
    center: { x: cx, z: cz },
    chunks: group.length,
    missing: group.filter((g) => g.kind === 'missing').length,
    blocks: { from: { x: Math.min(...xs) * 16, z: Math.min(...zs) * 16 }, to: { x: Math.max(...xs) * 16 + 15, z: Math.max(...zs) * 16 + 15 } },
    lostExamples: [...lost.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n]) => n.replace(/^minecraft:/, '')),
    chunkList: group.map((g) => ({ x: g.x, z: g.z, kind: g.kind })),
  });
}
areas.sort((a, b) => b.chunks - a.chunks);

const perDim = (m) => [0, 1, 2].map((d) => `${DIM[d]} ${[...m.values()].filter((c) => c.dim === d).length}`).join(', ');
let gone = 0;
for (const id of good.chunks.keys()) if (!current.chunks.has(id)) gone++;
console.log(`\nSaved chunks, good copy: ${good.chunks.size} (${perDim(good.chunks)})`);
console.log(`Saved chunks, current:   ${current.chunks.size} (${perDim(current.chunks)})`);
console.log(`Chunks on the good copy that no longer exist at all: ${gone}`);
console.log(`Chunks with builds on the good copy: ${[...good.chunks.values()].filter((c) => c.build.size >= 3).length}`);
console.log(`Damaged chunks: ${flagged.length} (${flagged.filter((f) => f.kind === 'missing').length} missing, ${flagged.filter((f) => f.kind === 'lost-builds').length} lost their builds) in ${areas.length} area(s)\n`);
for (const a of areas) {
  console.log(`${a.dimension.padEnd(9)} around X ${a.center.x}, Z ${a.center.z}  ${a.chunks} chunk(s)${a.missing ? `, ${a.missing} missing` : ''}  [${a.blocks.from.x},${a.blocks.from.z} to ${a.blocks.to.x},${a.blocks.to.z}]  lost e.g. ${a.lostExamples.join(', ')}`);
}
const show = (label, list) => {
  console.log(`\nDatabase checksum problems in the ${label}: ${list.length}`);
  for (const p of list.slice(0, 15)) console.log(`  ${p.file} @${p.offset}: ${p.what}`);
};
show('good copy', good.problems);
show('current world', current.problems);
if (reportFile) {
  writeFileSync(reportFile, JSON.stringify({ good: goodDir, current: currentDir, at: new Date().toISOString(), areas, problems: { good: good.problems, current: current.problems } }, null, 2));
  console.log(`\nFull report: ${reportFile}`);
}
