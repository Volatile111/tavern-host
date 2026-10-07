// Mod and plugin settings for Minecraft Java servers, edited from the Mods/Plugins tab (see config-files.ts for the
// formats). Mod servers (Fabric, Forge, NeoForge) keep configs in config/ (and Forge/NeoForge per-world ones in
// <world>/serverconfig, with defaults in defaultconfigs/); plugin servers (Paper, Spigot, BungeeCord) in
// plugins/<Plugin>/. Each file is matched to its mod by the mod ID in its name or folder (config/jei-server.toml → jei,
// config/create/… → create) and to its plugin by folder name, so the mod or plugin gets a Settings button.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ServerRecord } from './types.ts';
import { contentKind, listContent, readJar } from './java-content.ts';
import { readProperties } from '../properties.ts';
import { resolveIn } from '../server-files.ts';
import { formatOf, parseConfig, setConfigValues } from '../config-files.ts';

const MAX_BYTES = 2 * 1024 * 1024;
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** The folders config files are looked for in (relative to the server folder), and how deep. */
function roots(record: ServerRecord): { dir: string; depth: number }[] {
  if (contentKind(record) === 'plugins') return [{ dir: 'plugins', depth: 3 }];
  const level = readProperties(path.join(record.installDir, 'server.properties')).values.get('level-name') || 'world';
  return [
    { dir: 'config', depth: 3 },
    { dir: 'defaultconfigs', depth: 1 },
    { dir: `${level}/serverconfig`, depth: 1 },
  ];
}

function walk(record: ServerRecord, rel: string, depth: number, out: string[]) {
  const full = path.join(record.installDir, rel);
  if (!existsSync(full) || out.length > 2000) return;
  for (const f of readdirSync(full)) {
    const childRel = `${rel}/${f}`;
    const st = statSync(path.join(full, f));
    if (st.isDirectory()) {
      if (depth > 1) walk(record, childRel, depth - 1, out);
    } else if (formatOf(f) && formatOf(f) !== 'cfg' && st.size <= MAX_BYTES) out.push(childRel);
  }
}

/** The installed mods/plugins with the names a config file could carry. */
function owners(record: ServerRecord) {
  const folder = path.join(record.installDir, contentKind(record) ?? 'mods');
  return listContent(record).map((item) => {
    let modId = '';
    try {
      modId = readJar(path.join(folder, item.file)).id;
    } catch {}
    return { id: item.id, keys: [modId, item.name].filter(Boolean).map(squash).filter((k) => k.length >= 3) };
  });
}

/** Which mod/plugin (its list id) a config file belongs to, or null. */
function ownerOf(record: ServerRecord, rel: string, list: ReturnType<typeof owners>): string | null {
  const parts = rel.split('/');
  // plugins/<Plugin>/config.yml, config/<modid>/file.toml, or config/<modid>-server.toml.
  const folder = parts.length > 2 ? parts[1] : null;
  const base = parts[parts.length - 1].replace(/\.[^.]+$/, '').replace(/[-_.](server|common|client|startup|general|config)$/i, '');
  const names = [folder, base, base.split(/[-_.]/)[0]].filter(Boolean).map((n) => squash(n!)).filter((n) => n.length >= 3);
  let best: { id: string; score: number } | null = null;
  for (const o of list) {
    let score = 0;
    for (const k of o.keys) {
      for (const n of names) {
        if (n === k) score = Math.max(score, 3);
        else if (n.length >= 4 && k.length >= 4 && (n.startsWith(k) || k.startsWith(n))) score = Math.max(score, 1);
      }
    }
    if (score && (!best || score > best.score)) best = { id: o.id, score };
  }
  return best?.id ?? null;
}

export function listJavaSettings(record: ServerRecord) {
  if (!contentKind(record)) return [];
  const files: string[] = [];
  for (const r of roots(record)) walk(record, r.dir, r.depth, files);
  const list = owners(record);
  return files
    .map((file) => ({ file, plugin: file.split('/').slice(1).join('/'), version: null, mod: ownerOf(record, file, list), settings: 0, shared: 0 }))
    .sort((a, b) => a.file.localeCompare(b.file));
}

/** A config path from a request: one of this server's config folders, a known format, inside the server folder. */
function checkedPath(record: ServerRecord, file: string): string {
  const rel = String(file ?? '').replace(/\\/g, '/');
  if (!formatOf(rel) || formatOf(rel) === 'cfg' || !roots(record).some((r) => rel.toLowerCase().startsWith(`${r.dir.toLowerCase()}/`))) throw new Error('That is not a mod or plugin settings file.');
  const full = resolveIn(record.installDir, rel);
  if (!existsSync(full)) throw new Error(`${rel} isn't there any more.`);
  if (statSync(full).size > MAX_BYTES) throw new Error('That file is too big to edit here; use the Files tab.');
  return full;
}

export function readJavaSettings(record: ServerRecord, file: string) {
  const full = checkedPath(record, file);
  const rel = file.replace(/\\/g, '/');
  const parsed = parseConfig(readFileSync(full, 'utf-8'), formatOf(rel)!);
  return {
    file: rel,
    plugin: rel.split('/').slice(1).join('/'),
    version: null,
    mod: ownerOf(record, rel, owners(record)),
    // Minecraft players' games don't get settings from the server.
    canShare: false,
    entries: parsed.entries.map((e) => ({ ...e, shared: false })),
  };
}

export function writeJavaSettings(record: ServerRecord, file: string, values: { section: string; key: string; value: string }[]) {
  const full = checkedPath(record, file);
  const text = readFileSync(full, 'utf-8');
  if (values.length) writeFileSync(full, setConfigValues(text, formatOf(file)!, values));
  return { changed: values.length, shared: 0, sharedBefore: 0 };
}
