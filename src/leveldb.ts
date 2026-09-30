// Read-only access to Bedrock world databases (Mojang's LevelDB: .ldb tables and .log files, zlib/raw-deflate
// compressed blocks, CRC32C checksums). Used by the world checker; never writes anything.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { inflateSync, inflateRawSync } from 'node:zlib';
import path from 'node:path';

export interface DbProblem {
  file: string;
  what: string;
}

export interface Entry {
  key: Buffer;
  /** null for a deletion. */
  value: Buffer | null;
  seq: number;
}

// ---------- CRC32C (Castagnoli) with LevelDB's "mask" ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32c(buf: Buffer, start = 0, end = buf.length): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

const unmask = (m: number) => {
  const rot = (m - 0xa282ead8) >>> 0;
  return ((rot >>> 17) | (rot << 15)) >>> 0;
};

function varint(buf: Buffer, pos: number): [number, number] {
  let result = 0;
  let mul = 1;
  for (;;) {
    if (pos >= buf.length) throw new Error('varint past end');
    const b = buf[pos++];
    result += (b & 0x7f) * mul;
    if (!(b & 0x80)) return [result, pos];
    mul *= 128;
  }
}

// ---------- MANIFEST ----------

export interface Manifest {
  file: string;
  /** Table files in use: number -> level and size. */
  tables: Map<number, { level: number; size: number }>;
  logNumber: number;
  prevLogNumber: number;
}

/** Splits a log-format file (.log, MANIFEST) into its records. */
function logRecords(buf: Buffer, file: string, problems: DbProblem[]): Buffer[] {
  const out: Buffer[] = [];
  let pending: Buffer[] = [];
  let pos = 0;
  while (pos + 7 <= buf.length) {
    const left = 32768 - (pos % 32768);
    if (left < 7) {
      pos += left;
      continue;
    }
    const crc = buf.readUInt32LE(pos);
    const len = buf.readUInt16LE(pos + 4);
    const type = buf[pos + 6];
    if (type === 0 && len === 0) {
      pos += left;
      continue;
    }
    if (pos + 7 + len > buf.length) {
      // The last record of a live log can be cut off (written after the save point); that's normal.
      break;
    }
    if (unmask(crc) !== crc32c(buf, pos + 6, pos + 7 + len)) problems.push({ file, what: `record at byte ${pos} has a bad checksum` });
    const data = buf.subarray(pos + 7, pos + 7 + len);
    pos += 7 + len;
    if (type === 1) out.push(data);
    else if (type === 2) pending = [data];
    else if (type === 3) pending.push(data);
    else if (type === 4) {
      pending.push(data);
      out.push(Buffer.concat(pending));
      pending = [];
    }
  }
  return out;
}

export function readManifest(dbDir: string, problems: DbProblem[] = []): Manifest {
  const file = readFileSync(path.join(dbDir, 'CURRENT'), 'utf-8').trim();
  const buf = readFileSync(path.join(dbDir, file));
  const tables = new Map<number, { level: number; size: number }>();
  let logNumber = 0;
  let prevLogNumber = 0;
  const bytes = (b: Buffer, p: number): [Buffer, number] => {
    const [n, q] = varint(b, p);
    return [b.subarray(q, q + n), q + n];
  };
  for (const r of logRecords(buf, file, problems)) {
    let p = 0;
    while (p < r.length) {
      let tag: number;
      [tag, p] = varint(r, p);
      if (tag === 1) [, p] = bytes(r, p);
      else if (tag === 2) [logNumber, p] = varint(r, p);
      else if (tag === 9) [prevLogNumber, p] = varint(r, p);
      else if (tag === 3 || tag === 4) [, p] = varint(r, p);
      else if (tag === 5) {
        [, p] = varint(r, p);
        [, p] = bytes(r, p);
      } else if (tag === 6) {
        let num: number;
        [, p] = varint(r, p);
        [num, p] = varint(r, p);
        tables.delete(num);
      } else if (tag === 7) {
        let level: number, num: number, size: number;
        [level, p] = varint(r, p);
        [num, p] = varint(r, p);
        [size, p] = varint(r, p);
        [, p] = bytes(r, p);
        [, p] = bytes(r, p);
        tables.set(num, { level, size });
      } else throw new Error(`unknown MANIFEST entry ${tag}`);
    }
  }
  return { file, tables, logNumber, prevLogNumber };
}

const tableName = (n: number) => `${String(n).padStart(6, '0')}.ldb`;

/**
 * Seconds-fast check before a world is opened: the database's list of files (MANIFEST) can be read and every table it
 * lists is there with the right size. A missing or cut-off table means part of the world is gone, and opening it
 * can make the game throw the rest of that data away.
 */
export function quickCheckDb(dbDir: string): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  if (!existsSync(path.join(dbDir, 'CURRENT'))) return { ok: existsSync(dbDir) ? false : true, problems: existsSync(dbDir) ? ['The world database has no CURRENT file (its file list is missing).'] : [] };
  let m: Manifest;
  try {
    m = readManifest(dbDir);
  } catch (err) {
    return { ok: false, problems: [`The world database's file list (MANIFEST) can't be read: ${(err as Error).message}`] };
  }
  const sizes = new Map<string, number>();
  for (const f of readdirSync(dbDir)) if (f.endsWith('.ldb')) sizes.set(f, statSync(path.join(dbDir, f)).size);
  const missing: string[] = [];
  const short: string[] = [];
  for (const [n, t] of m.tables) {
    const size = sizes.get(tableName(n));
    if (size === undefined) missing.push(tableName(n));
    else if (size < t.size) short.push(tableName(n));
  }
  if (missing.length) problems.push(`${missing.length} database file${missing.length === 1 ? ' is' : 's are'} missing (${missing.slice(0, 3).join(', ')}${missing.length > 3 ? '…' : ''}). The chunks stored in them are gone.`);
  if (short.length) problems.push(`${short.length} database file${short.length === 1 ? ' is' : 's are'} cut short (${short.slice(0, 3).join(', ')}${short.length > 3 ? '…' : ''}).`);
  return { ok: !problems.length, problems };
}

// ---------- tables (.ldb) ----------

function readBlock(file: string, buf: Buffer, offset: number, size: number, problems: DbProblem[]): Buffer | null {
  const end = offset + size;
  if (end + 5 > buf.length) {
    problems.push({ file, what: 'a block runs past the end of the file' });
    return null;
  }
  const type = buf[end];
  if (unmask(buf.readUInt32LE(end + 1)) !== crc32c(buf, offset, end + 1)) problems.push({ file, what: `block at byte ${offset} has a bad checksum` });
  const raw = buf.subarray(offset, end);
  try {
    if (type === 0) return raw;
    if (type === 2) return inflateSync(raw);
    if (type === 4) return inflateRawSync(raw);
    problems.push({ file, what: `unknown compression type ${type}` });
  } catch (err) {
    problems.push({ file, what: `block at byte ${offset} can't be decompressed: ${(err as Error).message}` });
  }
  return null;
}

function* blockEntries(block: Buffer): Generator<[Buffer, Buffer]> {
  const restarts = block.readUInt32LE(block.length - 4);
  const limit = block.length - 4 - restarts * 4;
  let pos = 0;
  let key = Buffer.alloc(0);
  while (pos < limit) {
    let shared: number, nonShared: number, valueLen: number;
    [shared, pos] = varint(block, pos);
    [nonShared, pos] = varint(block, pos);
    [valueLen, pos] = varint(block, pos);
    key = Buffer.concat([key.subarray(0, shared), block.subarray(pos, pos + nonShared)]);
    pos += nonShared;
    const value = block.subarray(pos, pos + valueLen);
    pos += valueLen;
    yield [key, value];
  }
}

/** Entries of a table, in key order (and, for one key, newest first). Keys/values are views into the file. */
export function* tableEntries(file: string, problems: DbProblem[]): Generator<Entry> {
  const name = path.basename(file);
  const buf = readFileSync(file);
  if (buf.length < 48 || buf.readBigUInt64LE(buf.length - 8) !== 0xdb4775248b80fb57n) {
    problems.push({ file: name, what: 'not a complete database table (bad footer)' });
    return;
  }
  const footer = buf.subarray(buf.length - 48);
  let p = 0;
  let idxOff: number, idxSize: number;
  [, p] = varint(footer, p);
  [, p] = varint(footer, p);
  [idxOff, p] = varint(footer, p);
  [idxSize, p] = varint(footer, p);
  const index = readBlock(name, buf, idxOff, idxSize, problems);
  if (!index) return;
  for (const [, handle] of blockEntries(index)) {
    let q = 0;
    let off: number, size: number;
    [off, q] = varint(handle, q);
    [size, q] = varint(handle, q);
    const block = readBlock(name, buf, off, size, problems);
    if (!block) continue;
    for (const [ikey, value] of blockEntries(block)) {
      if (ikey.length < 8) continue;
      const trailer = ikey.readBigUInt64LE(ikey.length - 8);
      const deleted = (trailer & 0xffn) === 0n;
      yield { key: ikey.subarray(0, ikey.length - 8), value: deleted ? null : value, seq: Number(trailer >> 8n) };
    }
  }
}

// ---------- write-ahead logs (.log) ----------

/** Entries of a log, oldest first. */
export function* logEntries(file: string, problems: DbProblem[]): Generator<Entry> {
  const name = path.basename(file);
  for (const batch of logRecords(readFileSync(file), name, problems)) {
    if (batch.length < 12) continue;
    let seq = Number(batch.readBigUInt64LE(0));
    const count = batch.readUInt32LE(8);
    let q = 12;
    try {
      for (let i = 0; i < count; i++) {
        const t = batch[q++];
        let klen: number;
        [klen, q] = varint(batch, q);
        const key = batch.subarray(q, q + klen);
        q += klen;
        if (t === 1) {
          let vlen: number;
          [vlen, q] = varint(batch, q);
          yield { key, value: batch.subarray(q, q + vlen), seq };
          q += vlen;
        } else yield { key, value: null, seq };
        seq++;
      }
    } catch (err) {
      problems.push({ file: name, what: `damaged write batch: ${(err as Error).message}` });
    }
  }
}

/**
 * Every entry the game would see, newest source first: logs (newest log first; within a log, only each key's last
 * write), then tables level by level (level 0 newest file first). So the first time a key shows up is its current
 * value. Leftover files the MANIFEST doesn't list are ignored, as the game ignores them.
 */
export function* newestFirst(dbDir: string, problems: DbProblem[], onFile?: (done: number, total: number) => void): Generator<Entry> {
  const m = readManifest(dbDir, problems);
  const present = new Set(readdirSync(dbDir));
  const logs = [...present]
    .filter((f) => /^\d+\.log$/i.test(f))
    .map((f) => Number(f.replace(/\D/g, '')))
    .filter((n) => n >= m.logNumber || n === m.prevLogNumber)
    .sort((a, b) => b - a);
  const tables = [...m.tables].sort((a, b) => a[1].level - b[1].level || (a[1].level === 0 ? b[0] - a[0] : a[0] - b[0]));
  const total = logs.length + tables.length;
  let done = 0;
  for (const n of logs) {
    const last = new Map<string, Entry>();
    for (const e of logEntries(path.join(dbDir, `${String(n).padStart(6, '0')}.log`), problems)) last.set(e.key.toString('latin1'), e);
    yield* last.values();
    onFile?.(++done, total);
  }
  for (const [n] of tables) {
    const f = tableName(n);
    if (!present.has(f)) problems.push({ file: f, what: 'listed in the MANIFEST but missing' });
    else yield* tableEntries(path.join(dbDir, f), problems);
    onFile?.(++done, total);
  }
}
