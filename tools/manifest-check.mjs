// Checks a Bedrock world database's MANIFEST (its list of table files) against the files actually in the db folder.
// A table the MANIFEST lists that isn't there means every chunk in that table's key range is gone (read-only).
//   node tools/manifest-check.mjs "<world folder>"
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const world = process.argv[2];
const dir = path.join(world, 'db');
const current = readFileSync(path.join(dir, 'CURRENT'), 'utf-8').trim();
const buf = readFileSync(path.join(dir, current));

function vint(b, p) {
  let r = 0, s = 0;
  for (;;) {
    const x = b[p++];
    r += (x & 0x7f) * 2 ** s;
    if (!(x & 0x80)) return [r, p];
    s += 7;
  }
}
const bytes = (b, p) => {
  const [n, q] = vint(b, p);
  return [b.subarray(q, q + n), q + n];
};

// Log-format records -> VersionEdits
const records = [];
let pending = [];
for (let pos = 0; pos + 7 <= buf.length; ) {
  const left = 32768 - (pos % 32768);
  if (left < 7) { pos += left; continue; }
  const len = buf.readUInt16LE(pos + 4), type = buf[pos + 6];
  if (type === 0 && len === 0) { pos += left; continue; }
  const data = buf.subarray(pos + 7, pos + 7 + len);
  pos += 7 + len;
  if (type === 1) records.push(data);
  else if (type === 2) pending = [data];
  else if (type === 3) pending.push(data);
  else if (type === 4) { pending.push(data); records.push(Buffer.concat(pending)); }
}

const live = new Map(); // fileNum -> { level, size, smallest, largest }
for (const r of records) {
  let p = 0;
  while (p < r.length) {
    let tag;
    [tag, p] = vint(r, p);
    if (tag === 1) [, p] = bytes(r, p);
    else if (tag === 2 || tag === 3 || tag === 4 || tag === 9) [, p] = vint(r, p);
    else if (tag === 5) { [, p] = vint(r, p); [, p] = bytes(r, p); }
    else if (tag === 6) { let lvl, num; [lvl, p] = vint(r, p); [num, p] = vint(r, p); live.delete(num); }
    else if (tag === 7) {
      let level, num, size, smallest, largest;
      [level, p] = vint(r, p); [num, p] = vint(r, p); [size, p] = vint(r, p);
      [smallest, p] = bytes(r, p); [largest, p] = bytes(r, p);
      live.set(num, { level, size, smallest: Buffer.from(smallest), largest: Buffer.from(largest) });
    } else { console.error(`unknown manifest tag ${tag}, stopping`); break; }
  }
}

const describe = (ikey) => {
  const k = ikey.subarray(0, ikey.length - 8);
  if (k.length >= 9) {
    const dim = k.length >= 13 ? k.readInt32LE(8) : 0;
    return `chunk ${k.readInt32LE(0)},${k.readInt32LE(4)}${dim === 1 || dim === 2 ? ` dim ${dim}` : ''} (block X ${k.readInt32LE(0) * 16})`;
  }
  return JSON.stringify(k.toString('latin1'));
};

const onDisk = new Set(readdirSync(dir));
const missing = [...live].filter(([n]) => !onDisk.has(`${String(n).padStart(6, '0')}.ldb`));
const listed = new Set([...live.keys()].map((n) => `${String(n).padStart(6, '0')}.ldb`));
const extra = [...onDisk].filter((f) => f.endsWith('.ldb') && !listed.has(f));
console.log(`${world}\nMANIFEST ${current}: ${live.size} table files listed, ${[...onDisk].filter((f) => f.endsWith('.ldb')).length} .ldb on disk`);
console.log(`Listed but MISSING from disk: ${missing.length}`);
for (const [n, t] of missing.slice(0, 40)) console.log(`  ${String(n).padStart(6, '0')}.ldb level ${t.level} ${(t.size / 2 ** 20).toFixed(1)} MB  ${describe(t.smallest)}  ->  ${describe(t.largest)}`);
console.log(`On disk but not listed (orphans, ignored by the game): ${extra.length}${extra.length ? `\n  ${extra.join(' ')}` : ''}`);
