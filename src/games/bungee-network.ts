// BungeeCord network: the servers behind a proxy, kept in the proxy's config.yml ("servers:" and the first listener's
// "priorities:", the server players land on first). Edited as text so the rest of the file (comments included) stays
// exactly as it is. Tavern Host's own Minecraft Java servers can be added with their address filled in, and optionally
// prepared for the proxy (Paper/Spigot: bungeecord: true in spigot.yml, online-mode=false).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ServerRecord } from './types.ts';
import { readProperties, writeProperties } from '../properties.ts';

export interface ProxyServer {
  name: string;
  address: string;
  motd: string;
  restricted: boolean;
}

const configFile = (proxy: ServerRecord) => path.join(proxy.installDir, 'config.yml');
const NAME = /^[A-Za-z0-9_-]{1,32}$/;

function readConfig(proxy: ServerRecord): string {
  const f = configFile(proxy);
  if (!existsSync(f)) throw new Error("This proxy has no config.yml yet. Start it once so BungeeCord writes one.");
  return readFileSync(f, 'utf-8');
}

/** The lines of the top-level "servers:" block: [start, end) line indexes, the indent of its entries. */
function serversBlock(lines: string[]): { start: number; end: number; indent: string } | null {
  const start = lines.findIndex((l) => /^servers:\s*(#.*)?$/.test(l));
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && (/^\s/.test(lines[end]) || lines[end].trim() === '' || lines[end].trimStart().startsWith('#'))) end++;
  // Trailing blank/comment lines belong after the block.
  while (end > start + 1 && (lines[end - 1].trim() === '' || /^#/.test(lines[end - 1]))) end--;
  const first = lines.slice(start + 1, end).find((l) => /^\s+[^\s#]/.test(l));
  return { start, end, indent: first ? /^(\s+)/.exec(first)![1] : '  ' };
}

const unquote = (v: string) => v.trim().replace(/^(['"])(.*)\1$/, '$2');

export function listProxyServers(proxy: ServerRecord): { servers: ProxyServer[]; priorities: string[] } {
  const lines = readConfig(proxy).split(/\r?\n/);
  const block = serversBlock(lines);
  const servers: ProxyServer[] = [];
  if (block) {
    let cur: ProxyServer | null = null;
    for (const line of lines.slice(block.start + 1, block.end)) {
      const entry = new RegExp(`^${block.indent}([^\\s:#][^:]*):\\s*$`).exec(line);
      if (entry) {
        cur = { name: unquote(entry[1]), address: '', motd: '', restricted: false };
        servers.push(cur);
        continue;
      }
      const kv = /^\s+(address|motd|restricted):\s*(.*)$/.exec(line);
      if (cur && kv) {
        if (kv[1] === 'address') cur.address = unquote(kv[2]);
        else if (kv[1] === 'motd') cur.motd = unquote(kv[2]);
        else cur.restricted = /^true$/i.test(kv[2].trim());
      }
    }
  }
  return { servers, priorities: readPriorities(lines) };
}

/** The first listener's "priorities:" list (the server players join first, then the fallbacks). */
function prioritiesRange(lines: string[]): { start: number; end: number; indent: string } | null {
  const listeners = lines.findIndex((l) => /^listeners:\s*$/.test(l));
  if (listeners < 0) return null;
  for (let i = listeners + 1; i < lines.length && (/^\s|^-/.test(lines[i]) || lines[i].trim() === ''); i++) {
    const m = /^(\s*-?\s*)priorities:\s*(\[\])?\s*$/.exec(lines[i]);
    if (!m) continue;
    let end = i + 1;
    while (end < lines.length && /^\s*-\s+\S/.test(lines[end]) && (/^(\s*)-/.exec(lines[end])![1].length > (m[1].replace('-', ' ').length - 1))) end++;
    const itemIndent = end > i + 1 ? /^(\s*)-/.exec(lines[i + 1])![1] : ' '.repeat(m[1].length);
    return { start: i, end, indent: itemIndent };
  }
  return null;
}

function readPriorities(lines: string[]): string[] {
  const r = prioritiesRange(lines);
  return r ? lines.slice(r.start + 1, r.end).map((l) => unquote(l.replace(/^\s*-\s*/, ''))) : [];
}

function write(proxy: ServerRecord, lines: string[], eol: string) {
  writeFileSync(configFile(proxy), lines.join(eol));
}

/** Adds (or replaces) a server in the proxy's list; `first` also puts it at the top of priorities (players land there). */
export function addProxyServer(proxy: ServerRecord, input: { name: string; address: string; motd?: string; restricted?: boolean; first?: boolean }) {
  const name = String(input.name ?? '').trim();
  if (!NAME.test(name)) throw new Error('Server names in BungeeCord: letters, numbers, - and _ (up to 32).');
  const address = String(input.address ?? '').trim();
  if (!/^[\w.-]+:\d{1,5}$/.test(address)) throw new Error('Address must look like host:port, e.g. 127.0.0.1:25566.');
  const text = readConfig(proxy);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  let lines = text.split(/\r?\n/);
  // Replacing an existing entry (e.g. a new address) keeps its place in priorities.
  removeFromLines(lines, name, true);
  let block = serversBlock(lines);
  if (!block) {
    lines.push('servers:');
    block = { start: lines.length - 1, end: lines.length, indent: '  ' };
  }
  const i = block.indent;
  const entry = [`${i}${name}:`, `${i}${i}motd: '${String(input.motd ?? name).replace(/'/g, "''").slice(0, 100)}'`, `${i}${i}address: ${address}`, `${i}${i}restricted: ${input.restricted ? 'true' : 'false'}`];
  lines.splice(block.end, 0, ...entry);
  if (input.first) lines = setFirst(lines, name);
  write(proxy, lines, eol);
}

function removeFromLines(lines: string[], name: string, keepPriorities = false) {
  const block = serversBlock(lines);
  if (!block) return;
  const head = new RegExp(`^${block.indent}(['"]?)${name.replace(/[-]/g, '\\-')}\\1:\\s*$`);
  const at = lines.findIndex((l, n) => n > block.start && n < block.end && head.test(l));
  if (at < 0) return;
  let end = at + 1;
  while (end < block.end && (lines[end].startsWith(block.indent + block.indent) || lines[end].trim() === '')) end++;
  lines.splice(at, end - at);
  if (keepPriorities) return;
  // Also from priorities.
  const r = prioritiesRange(lines);
  if (r) for (let n = r.end - 1; n > r.start; n--) if (unquote(lines[n].replace(/^\s*-\s*/, '')) === name) lines.splice(n, 1);
}

export function removeProxyServer(proxy: ServerRecord, name: string) {
  const text = readConfig(proxy);
  const lines = text.split(/\r?\n/);
  if (!listProxyServers(proxy).servers.some((s) => s.name === name)) throw new Error('That server is not in the proxy’s list.');
  removeFromLines(lines, name);
  write(proxy, lines, text.includes('\r\n') ? '\r\n' : '\n');
}

function setFirst(lines: string[], name: string): string[] {
  const r = prioritiesRange(lines);
  if (!r) return lines;
  const items = lines.slice(r.start + 1, r.end).map((l) => unquote(l.replace(/^\s*-\s*/, ''))).filter((x) => x !== name);
  const head = lines[r.start].replace(/\[\]\s*$/, '').replace(/\s+$/, '');
  return [...lines.slice(0, r.start), head, ...[name, ...items].map((x) => `${r.indent}- ${x}`), ...lines.slice(r.end)];
}

/** Makes `name` the server players land on first. */
export function setDefaultProxyServer(proxy: ServerRecord, name: string) {
  const text = readConfig(proxy);
  if (!listProxyServers(proxy).servers.some((s) => s.name === name)) throw new Error('That server is not in the proxy’s list.');
  const lines = setFirst(text.split(/\r?\n/), name);
  if (!prioritiesRange(lines)) throw new Error("Couldn't find the listener's priorities in config.yml.");
  write(proxy, lines, text.includes('\r\n') ? '\r\n' : '\n');
}

/** A safe BungeeCord name for a Tavern Host server ("Survival World" → "survival-world"). */
export function proxyName(serverName: string): string {
  return (
    serverName
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'server'
  );
}

/**
 * Prepares a Paper/Spigot server for running behind BungeeCord: bungeecord: true in spigot.yml (so player names and
 * UUIDs come from the proxy) and online-mode=false (the proxy checks accounts). Returns what changed.
 */
export function prepareBackend(server: ServerRecord): string[] {
  const done: string[] = [];
  const spigot = path.join(server.installDir, 'spigot.yml');
  if (existsSync(spigot)) {
    const text = readFileSync(spigot, 'utf-8');
    if (/^(\s+)bungeecord:\s*false/m.test(text)) {
      writeFileSync(spigot, text.replace(/^(\s+)bungeecord:\s*false/m, '$1bungeecord: true'));
      done.push('spigot.yml: bungeecord: true');
    } else if (/^(\s+)bungeecord:\s*true/m.test(text)) done.push('spigot.yml already had bungeecord: true');
  } else done.push('spigot.yml not there yet (start the server once, then set it up again)');
  const props = path.join(server.installDir, 'server.properties');
  if (existsSync(props) && readProperties(props).values.get('online-mode') !== 'false') {
    writeProperties(props, { 'online-mode': 'false' });
    done.push('server.properties: online-mode=false');
  }
  return done;
}
