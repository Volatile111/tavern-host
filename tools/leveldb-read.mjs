// Read-only reader for Bedrock world databases (Mojang's LevelDB: .ldb tables and .log files, zlib/raw-deflate
// compressed blocks). Verifies every block's CRC32C checksum as it reads. Never writes anything.
//
//   const db = openWorldDb('C:/.../worlds/world/db');
//   for (const e of db.entries()) { e.key (Buffer), e.value (Buffer), e.seq (bigint), e.deleted }
//   db.problems -> [{ file, offset, what }]
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { inflateSync, inflateRawSync } from 'node:zlib';
import path from 'node:path';

// ---------- CRC32C (Castagnoli), as LevelDB uses, with its "mask" ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32c(buf, start = 0, end = buf.length, init = 0) {
  let c = ~init >>> 0;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}
const unmask = (m) => {
  const rot = (m - 0xa282ead8) >>> 0;
  return ((rot >>> 17) | (rot << 15)) >>> 0;
};

function varint(buf, pos) {
  let result = 0n;
  let shift = 0n;
  for (;;) {
    if (pos >= buf.length) throw new Error('varint past end');
    const b = buf[pos++];
    result |= BigInt(b & 0x7f) << shift;
    if (!(b & 0x80)) return [result, pos];
    shift += 7n;
  }
}
const vint = (buf, pos) => {
  const [v, p] = varint(buf, pos);
  return [Number(v), p];
};

// ---------- table (.ldb) files ----------

function readBlock(file, buf, offset, size, problems) {
  const end = offset + size;
  if (end + 5 > buf.length) {
    problems.push({ file, offset, what: 'block runs past the end of the file' });
    return null;
  }
  const type = buf[end];
  const stored = unmask(buf.readUInt32LE(end + 1));
  const actual = crc32c(buf, offset, end + 1);
  if (stored !== actual) problems.push({ file, offset, what: `checksum mismatch (block of ${size} bytes)` });
  const raw = buf.subarray(offset, end);
  try {
    if (type === 0) return raw;
    if (type === 2) return inflateSync(raw);
    if (type === 4) return inflateRawSync(raw);
    problems.push({ file, offset, what: `unknown compression type ${type}` });
  } catch (err) {
    problems.push({ file, offset, what: `can't decompress block: ${err.message}` });
  }
  return null;
}

function* blockEntries(block) {
  const numRestarts = block.readUInt32LE(block.length - 4);
  const limit = block.length - 4 - numRestarts * 4;
  let pos = 0;
  let key = Buffer.alloc(0);
  while (pos < limit) {
    let shared, nonShared, valueLen;
    [shared, pos] = vint(block, pos);
    [nonShared, pos] = vint(block, pos);
    [valueLen, pos] = vint(block, pos);
    key = Buffer.concat([key.subarray(0, shared), block.subarray(pos, pos + nonShared)]);
    pos += nonShared;
    const value = block.subarray(pos, pos + valueLen);
    pos += valueLen;
    yield [key, value];
  }
}

export function* tableEntries(file, problems) {
  const buf = readFileSync(file);
  if (buf.length < 48) {
    problems.push({ file, offset: 0, what: 'table too small' });
    return;
  }
  const footer = buf.subarray(buf.length - 48);
  const magic = footer.readBigUInt64LE(40);
  if (magic !== 0xdb4775248b80fb57n) {
    problems.push({ file, offset: buf.length - 48, what: 'bad table footer (not a LevelDB table, or cut off)' });
    return;
  }
  let p = 0;
  let metaOff, metaSize, idxOff, idxSize;
  [metaOff, p] = vint(footer, p);
  [metaSize, p] = vint(footer, p);
  [idxOff, p] = vint(footer, p);
  [idxSize, p] = vint(footer, p);
  const index = readBlock(file, buf, idxOff, idxSize, problems);
  if (!index) return;
  for (const [, handle] of blockEntries(index)) {
    let q = 0;
    let off, size;
    [off, q] = vint(handle, q);
    [size, q] = vint(handle, q);
    const block = readBlock(file, buf, off, size, problems);
    if (!block) continue;
    for (const [ikey, value] of blockEntries(block)) {
      if (ikey.length < 8) continue;
      const trailer = ikey.readBigUInt64LE(ikey.length - 8);
      // Views into the block, not copies: callers summarize each entry straight away.
      yield { key: ikey.subarray(0, ikey.length - 8), value, seq: trailer >> 8n, deleted: (trailer & 0xffn) === 0n };
    }
  }
}

// ---------- write-ahead log (.log) files ----------

export function* logEntries(file, problems) {
  const buf = readFileSync(file);
  const BLOCK = 32768;
  let pos = 0;
  let pending = [];
  while (pos + 7 <= buf.length) {
    const blockLeft = BLOCK - (pos % BLOCK);
    if (blockLeft < 7) {
      pos += blockLeft;
      continue;
    }
    const crc = buf.readUInt32LE(pos);
    const len = buf.readUInt16LE(pos + 4);
    const type = buf[pos + 6];
    if (type === 0 && len === 0) {
      pos += blockLeft; // zero padding
      continue;
    }
    if (pos + 7 + len > buf.length) {
      problems.push({ file, offset: pos, what: 'log record cut off (the server may have stopped mid-write)' });
      break;
    }
    const actual = crc32c(buf, pos + 6, pos + 7 + len);
    if (unmask(crc) !== actual) problems.push({ file, offset: pos, what: 'log record checksum mismatch' });
    const data = buf.subarray(pos + 7, pos + 7 + len);
    pos += 7 + len;
    if (type === 1) pending = [data];
    else if (type === 2) pending = [data];
    else if (type === 3) pending.push(data);
    else if (type === 4) pending.push(data);
    else {
      problems.push({ file, offset: pos, what: `unknown log record type ${type}` });
      continue;
    }
    if (type !== 1 && type !== 4) continue;
    const batch = Buffer.concat(pending);
    pending = [];
    if (batch.length < 12) continue;
    let seq = batch.readBigUInt64LE(0);
    const count = batch.readUInt32LE(8);
    let q = 12;
    try {
      for (let i = 0; i < count; i++) {
        const t = batch[q++];
        let klen;
        [klen, q] = vint(batch, q);
        const key = Buffer.from(batch.subarray(q, q + klen));
        q += klen;
        if (t === 1) {
          let vlen;
          [vlen, q] = vint(batch, q);
          yield { key, value: Buffer.from(batch.subarray(q, q + vlen)), seq, deleted: false };
          q += vlen;
        } else yield { key, value: null, seq, deleted: true };
        seq++;
      }
    } catch (err) {
      problems.push({ file, offset: pos, what: `damaged log batch: ${err.message}` });
    }
  }
}

/** Reads the db's MANIFEST: live table files, and the counters new files/sequence numbers must go past. */
export function readManifest(dir) {
  const current = readFileSync(path.join(dir, 'CURRENT'), 'utf-8').trim();
  const buf = readFileSync(path.join(dir, current));
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
  const bytes = (b, p) => {
    const [n, q] = vint(b, p);
    return [b.subarray(q, q + n), q + n];
  };
  const tables = new Map(); // fileNum -> { level, size, smallest, largest }
  let logNumber = 0, prevLogNumber = 0, nextFile = 0, lastSequence = 0n;
  for (const r of records) {
    let p = 0;
    while (p < r.length) {
      let tag;
      [tag, p] = vint(r, p);
      if (tag === 1) [, p] = bytes(r, p);
      else if (tag === 2) [logNumber, p] = vint(r, p);
      else if (tag === 9) [prevLogNumber, p] = vint(r, p);
      else if (tag === 3) [nextFile, p] = vint(r, p);
      else if (tag === 4) [lastSequence, p] = varint(r, p);
      else if (tag === 5) { [, p] = vint(r, p); [, p] = bytes(r, p); }
      else if (tag === 6) { let num; [, p] = vint(r, p); [num, p] = vint(r, p); tables.delete(num); }
      else if (tag === 7) {
        let level, num, size, smallest, largest;
        [level, p] = vint(r, p); [num, p] = vint(r, p); [size, p] = vint(r, p);
        [smallest, p] = bytes(r, p); [largest, p] = bytes(r, p);
        tables.set(num, { level, size, smallest: Buffer.from(smallest), largest: Buffer.from(largest) });
      } else throw new Error(`unknown MANIFEST tag ${tag}`);
    }
  }
  return { current, tables, logNumber, prevLogNumber, nextFile, lastSequence };
}

export { crc32c };

/** The newest value for every key across all tables and logs (deleted keys dropped). */
// Only the files the game itself uses: the tables the MANIFEST lists and the logs it hasn't folded into tables yet.
// Leftovers (orphan tables, old logs) are ignored, as the game ignores them.
export function openWorldDb(dir) {
  const problems = [];
  const manifest = readManifest(dir);
  const num = (f) => Number(f.replace(/\.\w+$/, ''));
  const all = readdirSync(dir);
  const files = all.filter((f) => {
    if (/\.ldb$/i.test(f)) return manifest.tables.has(num(f));
    if (/\.log$/i.test(f)) return num(f) >= manifest.logNumber || num(f) === manifest.prevLogNumber;
    return false;
  });
  // logs replay oldest first, after the tables
  files.sort((a, b) => (/\.log$/i.test(a) - /\.log$/i.test(b)) || num(a) - num(b));
  for (const n of manifest.tables.keys()) {
    const f = `${String(n).padStart(6, '0')}.ldb`;
    if (!all.includes(f)) problems.push({ file: f, offset: 0, what: 'table listed in the MANIFEST is missing' });
  }
  return {
    problems,
    files,
    manifest,
    maxFileNumber: Math.max(0, ...all.filter((f) => /^\d+\.\w+$/.test(f) || /^MANIFEST-\d+$/.test(f)).map((f) => Number(f.replace(/\D/g, '')))),
    /** Every entry of every file, in file order: { key, value, seq, deleted, file }. Keys/values are views. */
    *entries(onProgress) {
      let n = 0;
      for (const f of files) {
        const full = path.join(dir, f);
        const it = f.toLowerCase().endsWith('.ldb') ? tableEntries(full, problems) : logEntries(full, problems);
        for (const e of it) yield { ...e, file: f };
        onProgress?.(++n, files.length, f, statSync(full).size);
      }
    },
    /**
     * Map of key(hex) -> { summary, seq, file } with the newest live version of each key. `summarize(key, value)`
     * turns each value into something small (whole values of a big world wouldn't fit in memory).
     */
    load(summarize, onProgress) {
      // key (latin1 string) -> [seq, summary]; summary null = deleted. Keys summarize() skips (undefined) aren't kept.
      const newest = new Map();
      let n = 0;
      for (const f of files) {
        const full = path.join(dir, f);
        const it = f.toLowerCase().endsWith('.ldb') ? tableEntries(full, problems) : logEntries(full, problems);
        for (const e of it) {
          const summary = e.deleted ? null : summarize(e.key, e.value);
          if (summary === undefined) continue;
          const k = e.key.toString('latin1');
          const seq = Number(e.seq);
          const old = newest.get(k);
          if (old && old[0] >= seq) continue;
          newest.set(k, [seq, summary]);
        }
        onProgress?.(++n, files.length, f, statSync(full).size);
      }
      for (const [k, e] of newest) if (e[1] === null) newest.delete(k);
      return newest;
    },
  };
}
