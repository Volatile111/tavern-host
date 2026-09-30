// Minimal zip reader for looking inside .jar files (mod/plugin metadata and icons). Reads the central directory and
// inflates single entries; enough for jars (no zip64, no encryption).
import { openSync, readSync, closeSync, fstatSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

interface Entry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

export class ZipFile {
  private fd: number;
  readonly entries = new Map<string, Entry>();

  constructor(file: string) {
    this.fd = openSync(file, 'r');
    try {
      this.readDirectory();
    } catch (err) {
      this.close();
      throw err;
    }
  }

  private read(pos: number, len: number) {
    const buf = Buffer.alloc(len);
    const n = readSync(this.fd, buf, 0, len, pos);
    return buf.subarray(0, n);
  }

  private readDirectory() {
    const size = fstatSync(this.fd).size;
    // The end-of-central-directory record is in the last 64 KB + 22 bytes.
    const tailLen = Math.min(size, 65_557);
    const tail = this.read(size - tailLen, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error('Not a zip/jar file.');
    const count = tail.readUInt16LE(eocd + 10);
    const dirSize = tail.readUInt32LE(eocd + 12);
    const dirOffset = tail.readUInt32LE(eocd + 16);
    const dir = this.read(dirOffset, dirSize);
    let p = 0;
    for (let i = 0; i < count && p + 46 <= dir.length; i++) {
      if (dir.readUInt32LE(p) !== 0x02014b50) throw new Error('Damaged zip/jar file.');
      const method = dir.readUInt16LE(p + 10);
      const compressedSize = dir.readUInt32LE(p + 20);
      const sizeU = dir.readUInt32LE(p + 24);
      const nameLen = dir.readUInt16LE(p + 28);
      const extraLen = dir.readUInt16LE(p + 30);
      const commentLen = dir.readUInt16LE(p + 32);
      const localOffset = dir.readUInt32LE(p + 42);
      const name = dir.toString('utf-8', p + 46, p + 46 + nameLen);
      this.entries.set(name, { name, method, compressedSize, size: sizeU, localOffset });
      p += 46 + nameLen + extraLen + commentLen;
    }
  }

  has(name: string) {
    return this.entries.has(name);
  }

  /** An entry's contents (null if missing, or bigger than `maxBytes`). */
  get(name: string, maxBytes = 8 * 1024 * 1024): Buffer | null {
    const e = this.entries.get(name);
    if (!e || e.size > maxBytes || e.compressedSize > maxBytes) return null;
    const header = this.read(e.localOffset, 30);
    if (header.readUInt32LE(0) !== 0x04034b50) return null;
    const start = e.localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
    const data = this.read(start, e.compressedSize);
    if (e.method === 0) return data;
    // Never inflate past the limit, whatever size the entry claims (protects against "zip bombs").
    if (e.method === 8) {
      try {
        return inflateRawSync(data, { maxOutputLength: maxBytes });
      } catch {
        return null;
      }
    }
    return null;
  }

  text(name: string) {
    return this.get(name)?.toString('utf-8').replace(/^﻿/, '') ?? null;
  }

  /** Entry names with "/" separators (some zips are made with Windows "\" separators). */
  names(): string[] {
    return [...this.entries.keys()];
  }

  /** Normalised path of an entry ("a\\b.dll" -> "a/b.dll"). */
  static normalise(name: string) {
    return name.replace(/\\/g, '/').replace(/^\/+/, '');
  }

  close() {
    try {
      closeSync(this.fd);
    } catch {}
  }
}
