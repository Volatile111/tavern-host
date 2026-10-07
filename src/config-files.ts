// Mod and plugin config files in the formats Minecraft servers use, read as a flat list of settings for the mod settings
// editor (the same shape as BepInEx configs, see bepinex-config.ts) and changed in place, one line at a time, so comments,
// order and formatting stay:
//   toml        Forge/NeoForge configs: [section] headers, "#" comments ("#Range: 1 ~ 10", "#Allowed Values: A, B")
//   yaml        plugin configs (config.yml): nested "key: value" maps
//   json        Fabric mod configs (rewritten as a whole, keeping the file's indentation)
//   properties  key=value files
// Only single-line plain values (text, numbers, true/false) can be changed. Lists, multi-line values, inline tables and
// anything else are listed read-only (edit those in the Files tab).
import { parseCfg, setValues as setCfgValues, type CfgEntry, type CfgChange } from './bepinex-config.ts';

export type ConfigFormat = 'toml' | 'yaml' | 'json' | 'properties' | 'cfg';

export interface ConfigEntry extends CfgEntry {
  /** false: shown, but can't be changed here (lists, multi-line values...). */
  editable: boolean;
}

export function formatOf(file: string): ConfigFormat | null {
  const ext = file.toLowerCase().split('.').pop();
  return ext === 'toml' ? 'toml' : ext === 'yml' || ext === 'yaml' ? 'yaml' : ext === 'json' ? 'json' : ext === 'properties' ? 'properties' : ext === 'cfg' ? 'cfg' : null;
}

const entry = (section: string, key: string, value: string, type: string | null, description: string[], extra: Partial<ConfigEntry> = {}): ConfigEntry => ({
  section,
  key,
  value,
  description: description.join('\n').trim(),
  type,
  default: null,
  options: null,
  multi: false,
  range: null,
  editable: true,
  ...extra,
});

/** Type of a plain value as written in TOML/YAML/properties. */
function scalarType(raw: string): string {
  if (/^(true|false)$/i.test(raw)) return 'Boolean';
  if (/^[+-]?\d+$/.test(raw)) return 'Int32';
  if (/^[+-]?(\d+\.\d*|\.\d+|\d+)(e[+-]?\d+)?$/i.test(raw)) return 'Double';
  return 'String';
}

// ---------- TOML (Forge/NeoForge style) ----------

function unquoteToml(raw: string): { value: string; quoted: boolean } | null {
  if (/^"(?:[^"\\]|\\.)*"$/.test(raw)) {
    try {
      return { value: JSON.parse(raw), quoted: true };
    } catch {
      return null;
    }
  }
  if (/^'[^']*'$/.test(raw)) return { value: raw.slice(1, -1), quoted: true };
  return { value: raw, quoted: false };
}

/** "value  # comment" → "value" (a "#" inside quotes isn't a comment). */
function stripTomlComment(rest: string): string {
  let inStr: string | null = null;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    if (inStr) {
      if (c === '\\' && inStr === '"') i++;
      else if (c === inStr) inStr = null;
    } else if (c === '"' || c === "'") inStr = c;
    else if (c === '#') return rest.slice(0, i).trim();
  }
  return rest.trim();
}

function parseToml(text: string): ConfigEntry[] {
  const out: ConfigEntry[] = [];
  let section = '';
  let desc: string[] = [];
  let extra: Partial<ConfigEntry> = {};
  // Inside a value that spans lines: a list ("]" ends it) or a triple-quoted string.
  let skipUntil: string | null = null;
  let arrayTable = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (skipUntil) {
      if (skipUntil === ']' ? /\]\s*,?\s*(#.*)?$/.test(line) : line.includes(skipUntil)) skipUntil = null;
      continue;
    }
    if (!line) continue;
    let m: RegExpExecArray | null;
    if ((m = /^\[\[(.+)\]\]$/.exec(line))) {
      section = m[1].trim();
      arrayTable = true;
      desc = [];
      extra = {};
    } else if ((m = /^\[(.+)\]$/.exec(line))) {
      section = m[1].trim();
      arrayTable = false;
      desc = [];
      extra = {};
    } else if (line.startsWith('#')) {
      const c = line.replace(/^#+\s?/, '');
      if ((m = /^Range:\s*(\S+)\s*~\s*(\S+)/i.exec(c))) {
        const min = Number(m[1]);
        const max = Number(m[2]);
        if (Number.isFinite(min) && Number.isFinite(max)) extra.range = { min, max };
      } else if ((m = /^Allowed Values:\s*(.+)$/i.exec(c))) extra.options = m[1].split(',').map((s) => s.trim()).filter(Boolean);
      else if ((m = /^Default:\s*(.*)$/i.exec(c))) extra.default = m[1].trim().replace(/^"(.*)"$/, '$1');
      else desc.push(c);
    } else if ((m = /^("(?:[^"\\]|\\.)*"|'[^']*'|[\w.-]+)\s*=\s*(.*)$/.exec(line))) {
      const key = m[1].replace(/^["'](.*)["']$/, '$1');
      const rest = stripTomlComment(m[2]);
      const opensArray = rest.startsWith('[') && !/\]$/.test(rest);
      const plain = !rest.startsWith('[') && !rest.startsWith('{') && !rest.startsWith('"""') && !rest.startsWith("'''");
      const q = plain ? unquoteToml(rest) : null;
      out.push(
        entry(section, key, q ? q.value : rest, q ? (q.quoted ? 'String' : scalarType(rest)) : rest.startsWith('[') ? 'List' : 'Table', desc, {
          ...extra,
          editable: !!q && !arrayTable,
        }),
      );
      const triple = rest.startsWith('"""') ? '"""' : rest.startsWith("'''") ? "'''" : null;
      if (opensArray) skipUntil = ']';
      else if (triple && !rest.slice(3).includes(triple)) skipUntil = triple;
      desc = [];
      extra = {};
    }
  }
  return out;
}

function setToml(text: string, changes: CfgChange[]): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const todo = new Map(changes.map((c) => [`${c.section}\u0000${c.key}`, c]));
  let section = '';
  lines.forEach((raw, i) => {
    const line = raw.trim();
    let m: RegExpExecArray | null;
    if ((m = /^\[\[?(.+?)\]\]?$/.exec(line))) section = m[1].trim();
    else if ((m = /^(\s*)("(?:[^"\\]|\\.)*"|'[^']*'|[\w.-]+)(\s*=\s*)(.*)$/.exec(raw))) {
      const key = m[2].replace(/^["'](.*)["']$/, '$1');
      const c = todo.get(`${section}\u0000${key}`);
      if (!c) return;
      const old = stripTomlComment(m[4]);
      const comment = m[4].slice(m[4].indexOf(old) + old.length);
      const wasString = /^["']/.test(old);
      const value = wasString || scalarType(c.value) === 'String' ? JSON.stringify(c.value) : c.value;
      lines[i] = `${m[1]}${m[2]}${m[3]}${value}${comment}`;
      todo.delete(`${section}\u0000${key}`);
    }
  });
  if (todo.size) throw new Error(`"${[...todo.values()][0].key}" wasn't found in the file.`);
  return lines.join(eol);
}

// ---------- YAML (plugin configs) ----------

interface YamlLine {
  index: number;
  indent: number;
  path: string[];
  key: string;
  raw: string; // value text as written
}

function unquoteYaml(raw: string): { value: string; quoted: boolean } | null {
  if (/^"(?:[^"\\]|\\.)*"$/.test(raw)) {
    try {
      return { value: JSON.parse(raw), quoted: true };
    } catch {
      return null;
    }
  }
  if (/^'(?:[^']|'')*'$/.test(raw)) return { value: raw.slice(1, -1).replace(/''/g, "'"), quoted: true };
  if (/^[|>&*!%@`[{]/.test(raw)) return null; // block scalars, anchors, flow lists/maps...
  return { value: raw, quoted: false };
}

/** "value # comment" → "value" for plain YAML scalars. */
function stripYamlComment(rest: string): string {
  if (/^["']/.test(rest)) {
    const m = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*')/.exec(rest);
    return m ? m[1] : rest.trim();
  }
  const at = rest.search(/\s#/);
  return (at >= 0 ? rest.slice(0, at) : rest).trim();
}

function yamlLines(text: string): { lines: YamlLine[]; comments: Map<number, string[]> } {
  const stack: { indent: number; key: string }[] = [];
  const out: YamlLine[] = [];
  const comments = new Map<number, string[]>();
  let desc: string[] = [];
  let inBlock: number | null = null;
  text.split(/\r?\n/).forEach((raw, index) => {
    if (!raw.trim()) return;
    const indent = raw.length - raw.trimStart().length;
    if (inBlock !== null) {
      if (indent > inBlock) return; // inside a | or > block
      inBlock = null;
    }
    const line = raw.trim();
    if (line.startsWith('#')) {
      desc.push(line.replace(/^#+\s?/, ''));
      return;
    }
    if (line.startsWith('- ') || line === '-') {
      desc = [];
      return; // list items: not editable here
    }
    const m = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^:#][^:]*?)\s*:(?:\s+(.*))?$/.exec(line);
    if (!m) {
      desc = [];
      return;
    }
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const key = m[1].replace(/^["'](.*)["']$/, '$1');
    const rest = (m[2] ?? '').trim();
    if (!rest || rest.startsWith('#')) stack.push({ indent, key });
    else {
      out.push({ index, indent, path: stack.map((s) => s.key), key, raw: stripYamlComment(rest) });
      if (desc.length) comments.set(index, desc);
      if (/^[|>]/.test(rest)) inBlock = indent;
    }
    desc = [];
  });
  return { lines: out, comments };
}

function parseYaml(text: string): ConfigEntry[] {
  const { lines, comments } = yamlLines(text);
  return lines.map((l) => {
    const q = unquoteYaml(l.raw);
    return entry(l.path.join('.'), l.key, q ? q.value : l.raw, q ? (q.quoted ? 'String' : scalarType(l.raw)) : 'Value', comments.get(l.index) ?? [], { editable: !!q });
  });
}

function setYaml(text: string, changes: CfgChange[]): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const out = text.split(/\r?\n/);
  const { lines } = yamlLines(text);
  for (const c of changes) {
    const l = lines.find((x) => x.path.join('.') === c.section && x.key === c.key);
    if (!l) throw new Error(`"${c.key}" wasn't found in the file.`);
    const raw = out[l.index];
    const at = raw.indexOf(l.raw, raw.indexOf(':'));
    if (at < 0) throw new Error(`"${c.key}" couldn't be changed safely; use the Files tab.`);
    // Quote text that YAML would read as something else (or that has special characters).
    const needsQuotes = /^["']/.test(l.raw) || scalarType(c.value) !== scalarType(l.raw.replace(/^["']|["']$/g, '')) || /^[\s#&*!|>%@`{[\]},'"-]|:\s|\s#|^$|^(yes|no|on|off|null|~)$/i.test(c.value);
    const value = needsQuotes && scalarType(c.value) === 'String' ? JSON.stringify(c.value) : c.value;
    out[l.index] = raw.slice(0, at) + value + raw.slice(at + l.raw.length);
  }
  return out.join(eol);
}

// ---------- JSON ----------

function parseJson(text: string): ConfigEntry[] {
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    return [];
  }
  const out: ConfigEntry[] = [];
  const walk = (node: unknown, path: string[]) => {
    if (node && typeof node === 'object' && !Array.isArray(node)) {
      for (const [k, v] of Object.entries(node)) {
        if (v && typeof v === 'object') walk(v, [...path, k]);
        else out.push(entry(path.join('.'), k, String(v), typeof v === 'boolean' ? 'Boolean' : typeof v === 'number' ? (Number.isInteger(v) ? 'Int32' : 'Double') : 'String', [], { editable: v !== null }));
      }
    }
  };
  walk(data, []);
  return out;
}

function setJson(text: string, changes: CfgChange[]): string {
  const data = JSON.parse(text.replace(/^﻿/, ''));
  for (const c of changes) {
    let node = data;
    for (const part of c.section ? c.section.split('.') : []) node = node?.[part];
    if (!node || typeof node !== 'object' || !(c.key in node) || (node[c.key] && typeof node[c.key] === 'object')) throw new Error(`"${c.key}" wasn't found in the file.`);
    const old = node[c.key];
    node[c.key] = typeof old === 'boolean' ? c.value === 'true' : typeof old === 'number' ? Number(c.value) : c.value;
    if (typeof old === 'number' && !Number.isFinite(node[c.key])) throw new Error(`"${c.key}" must be a number.`);
  }
  const indent = /^\{\r?\n(\s+)/.exec(text)?.[1] ?? '  ';
  return JSON.stringify(data, null, indent.includes('\t') ? '\t' : indent.length) + (text.endsWith('\n') ? '\n' : '');
}

// ---------- .properties ----------

function parseProperties(text: string): ConfigEntry[] {
  const out: ConfigEntry[] = [];
  let desc: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^[#!]/.test(line)) {
      desc.push(line.replace(/^[#!]\s?/, ''));
      continue;
    }
    const m = /^([^=:\s]+)\s*[=:]\s*(.*)$/.exec(line);
    if (m) out.push(entry('', m[1], m[2], scalarType(m[2]), desc, { editable: !m[2].endsWith('\\') }));
    desc = [];
  }
  return out;
}

function setProperties(text: string, changes: CfgChange[]): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  for (const c of changes) {
    const i = lines.findIndex((l) => new RegExp(`^\\s*${c.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[=:]`).test(l));
    if (i < 0) throw new Error(`"${c.key}" wasn't found in the file.`);
    lines[i] = lines[i].replace(/^(\s*[^=:\s]+\s*[=:]\s*).*$/, `$1${c.value}`);
  }
  return lines.join(eol);
}

// ---------- the whole file ----------

export function parseConfig(text: string, format: ConfigFormat): { plugin: string | null; version: string | null; entries: ConfigEntry[] } {
  if (format === 'cfg') {
    const c = parseCfg(text);
    return { plugin: c.plugin, version: c.version, entries: c.entries.map((e) => ({ ...e, editable: true })) };
  }
  const entries = format === 'toml' ? parseToml(text) : format === 'yaml' ? parseYaml(text) : format === 'json' ? parseJson(text) : parseProperties(text);
  return { plugin: null, version: null, entries };
}

/** Changes values (only editable entries; checked against the file first). */
export function setConfigValues(text: string, format: ConfigFormat, changes: CfgChange[]): string {
  if (!changes.length) return text;
  for (const c of changes) if (/[\r\n]/.test(c.value + c.key + c.section)) throw new Error('Settings must be on one line.');
  const editable = new Set(parseConfig(text, format).entries.filter((e) => e.editable).map((e) => `${e.section}\u0000${e.key}`));
  for (const c of changes) if (!editable.has(`${c.section}\u0000${c.key}`)) throw new Error(`"${c.key}" can't be changed here (edit it in the Files tab).`);
  if (format === 'cfg') return setCfgValues(text, changes);
  return format === 'toml' ? setToml(text, changes) : format === 'yaml' ? setYaml(text, changes) : format === 'json' ? setJson(text, changes) : setProperties(text, changes);
}
