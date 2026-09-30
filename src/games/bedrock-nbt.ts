// Bedrock level.dat: an 8-byte header (storage version, payload length; both little-endian int32) followed by one
// little-endian NBT compound. Tags keep their exact type so a read/modify/write round trip changes nothing else.

export const T = { End: 0, Byte: 1, Short: 2, Int: 3, Long: 4, Float: 5, Double: 6, ByteArray: 7, String: 8, List: 9, Compound: 10, IntArray: 11, LongArray: 12 } as const;

export type Tag =
  | { type: 1 | 2 | 3; value: number }
  | { type: 4; value: bigint }
  | { type: 5 | 6; value: number }
  | { type: 7; value: Buffer }
  | { type: 8; value: string }
  | { type: 9; itemType: number; value: Tag[] }
  | { type: 10; value: Map<string, Tag> }
  | { type: 11; value: number[] }
  | { type: 12; value: bigint[] };

class Reader {
  pos = 0;
  buf: Buffer;
  constructor(buf: Buffer) {
    this.buf = buf;
  }
  u8() {
    return this.buf.readUInt8(this.pos++);
  }
  i8() {
    return this.buf.readInt8(this.pos++);
  }
  i16() {
    const v = this.buf.readInt16LE(this.pos);
    this.pos += 2;
    return v;
  }
  u16() {
    const v = this.buf.readUInt16LE(this.pos);
    this.pos += 2;
    return v;
  }
  i32() {
    const v = this.buf.readInt32LE(this.pos);
    this.pos += 4;
    return v;
  }
  i64() {
    const v = this.buf.readBigInt64LE(this.pos);
    this.pos += 8;
    return v;
  }
  f32() {
    const v = this.buf.readFloatLE(this.pos);
    this.pos += 4;
    return v;
  }
  f64() {
    const v = this.buf.readDoubleLE(this.pos);
    this.pos += 8;
    return v;
  }
  str() {
    const len = this.u16();
    const v = this.buf.toString('utf-8', this.pos, this.pos + len);
    this.pos += len;
    return v;
  }
  bytes(n: number) {
    const v = Buffer.from(this.buf.subarray(this.pos, this.pos + n));
    this.pos += n;
    return v;
  }
}

function readPayload(r: Reader, type: number): Tag {
  switch (type) {
    case T.Byte:
      return { type, value: r.i8() };
    case T.Short:
      return { type, value: r.i16() };
    case T.Int:
      return { type, value: r.i32() };
    case T.Long:
      return { type, value: r.i64() };
    case T.Float:
      return { type, value: r.f32() };
    case T.Double:
      return { type, value: r.f64() };
    case T.ByteArray:
      return { type, value: r.bytes(r.i32()) };
    case T.String:
      return { type, value: r.str() };
    case T.List: {
      const itemType = r.u8();
      const n = r.i32();
      const value: Tag[] = [];
      for (let i = 0; i < n; i++) value.push(readPayload(r, itemType));
      return { type, itemType, value };
    }
    case T.Compound: {
      const value = new Map<string, Tag>();
      for (;;) {
        const t = r.u8();
        if (t === T.End) break;
        value.set(r.str(), readPayload(r, t));
      }
      return { type, value };
    }
    case T.IntArray: {
      const n = r.i32();
      return { type, value: Array.from({ length: n }, () => r.i32()) };
    }
    case T.LongArray: {
      const n = r.i32();
      return { type, value: Array.from({ length: n }, () => r.i64()) };
    }
    default:
      throw new Error(`Unknown NBT tag type ${type}.`);
  }
}

class Writer {
  parts: Buffer[] = [];
  push(b: Buffer) {
    this.parts.push(b);
  }
  u8(v: number) {
    const b = Buffer.alloc(1);
    b.writeUInt8(v);
    this.push(b);
  }
  i8(v: number) {
    const b = Buffer.alloc(1);
    b.writeInt8(v);
    this.push(b);
  }
  i16(v: number) {
    const b = Buffer.alloc(2);
    b.writeInt16LE(v);
    this.push(b);
  }
  i32(v: number) {
    const b = Buffer.alloc(4);
    b.writeInt32LE(v);
    this.push(b);
  }
  i64(v: bigint) {
    const b = Buffer.alloc(8);
    b.writeBigInt64LE(v);
    this.push(b);
  }
  str(s: string) {
    const data = Buffer.from(s, 'utf-8');
    const b = Buffer.alloc(2);
    b.writeUInt16LE(data.length);
    this.push(b);
    this.push(data);
  }
}

function writePayload(w: Writer, tag: Tag) {
  switch (tag.type) {
    case T.Byte:
      return w.i8(tag.value);
    case T.Short:
      return w.i16(tag.value);
    case T.Int:
      return w.i32(tag.value);
    case T.Long:
      return w.i64(tag.value);
    case T.Float: {
      const b = Buffer.alloc(4);
      b.writeFloatLE(tag.value);
      return w.push(b);
    }
    case T.Double: {
      const b = Buffer.alloc(8);
      b.writeDoubleLE(tag.value);
      return w.push(b);
    }
    case T.ByteArray:
      w.i32(tag.value.length);
      return w.push(tag.value);
    case T.String:
      return w.str(tag.value);
    case T.List:
      w.u8(tag.itemType);
      w.i32(tag.value.length);
      for (const item of tag.value) writePayload(w, item);
      return;
    case T.Compound:
      for (const [name, child] of tag.value) {
        w.u8(child.type);
        w.str(name);
        writePayload(w, child);
      }
      return w.u8(T.End);
    case T.IntArray:
      w.i32(tag.value.length);
      for (const v of tag.value) w.i32(v);
      return;
    case T.LongArray:
      w.i32(tag.value.length);
      for (const v of tag.value) w.i64(v);
      return;
  }
}

/** Reads one named tag (type, name, payload) at `pos`; used for NBT stored back to back, e.g. in world databases. */
export function readNamedTag(buf: Buffer, pos: number): { name: string; tag: Tag; end: number } {
  const r = new Reader(buf);
  r.pos = pos;
  const type = r.u8();
  const name = r.str();
  const tag = readPayload(r, type);
  return { name, tag, end: r.pos };
}

export interface LevelDat {
  storageVersion: number;
  rootName: string;
  root: Map<string, Tag>;
}

export function parseLevelDat(buf: Buffer): LevelDat {
  if (buf.length < 9) throw new Error('level.dat is too short.');
  const storageVersion = buf.readInt32LE(0);
  const length = buf.readInt32LE(4);
  if (length !== buf.length - 8) throw new Error('level.dat looks damaged (length mismatch).');
  const r = new Reader(buf.subarray(8));
  const type = r.u8();
  if (type !== T.Compound) throw new Error('level.dat looks damaged (no root compound).');
  const rootName = r.str();
  const root = readPayload(r, T.Compound) as Extract<Tag, { type: 10 }>;
  return { storageVersion, rootName, root: root.value };
}

export function serializeLevelDat(dat: LevelDat): Buffer {
  const w = new Writer();
  w.u8(T.Compound);
  w.str(dat.rootName);
  writePayload(w, { type: T.Compound, value: dat.root });
  const body = Buffer.concat(w.parts);
  const header = Buffer.alloc(8);
  header.writeInt32LE(dat.storageVersion, 0);
  header.writeInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

/** Plain-JS view of a tag, for debugging and display. */
export function toPlain(tag: Tag): unknown {
  switch (tag.type) {
    case T.Compound:
      return Object.fromEntries([...tag.value].map(([k, v]) => [k, toPlain(v)]));
    case T.List:
      return tag.value.map(toPlain);
    case T.Long:
      return tag.value.toString();
    case T.LongArray:
      return tag.value.map(String);
    case T.ByteArray:
      return `<${tag.value.length} bytes>`;
    default:
      return tag.value;
  }
}
