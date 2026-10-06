// Mod settings for Valheim servers: the BepInEx config files in BepInEx/config, edited from the Mods tab. Each setting
// can also be sent to players: the share link lists those values, and Tavern Client Mod Manager writes them into the
// players' own copy of the file when it syncs. That's how player-side settings work (e.g. Server devcommands' automatic
// god mode for admins), which the server's own copy of the file can't change.
// Which settings are sent is kept next to the mods, in BepInEx/tavernhost-shared-settings.json.
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { ServerRecord } from './types.ts';
import * as vm from '../valheim-mods.ts';
import { parseCfg, setValues, isCfgName, checkChange, type CfgChange, type CfgEntry } from '../bepinex-config.ts';
import { activeIsVanilla } from './valheim-profiles.ts';

const SHARED_FILE = 'tavernhost-shared-settings.json';
/** BepInEx's own settings: not a mod's, and not something to send to players. */
const LOADER_CFG = 'bepinex.cfg';

/** file -> section -> setting names sent to players. */
type SharedSettings = Record<string, Record<string, string[]>>;

const configDir = (record: ServerRecord) => path.join(record.installDir, 'BepInEx', 'config');

function cfgPath(record: ServerRecord, file: string) {
  if (!isCfgName(file) || file.toLowerCase() === LOADER_CFG) throw new Error('That is not a mod settings file.');
  return path.join(configDir(record), file);
}

function loadShared(record: ServerRecord): SharedSettings {
  try {
    return JSON.parse(readFileSync(path.join(record.installDir, 'BepInEx', SHARED_FILE), 'utf-8'));
  } catch {
    return {};
  }
}

function saveShared(record: ServerRecord, shared: SharedSettings) {
  for (const [file, sections] of Object.entries(shared)) {
    for (const [s, keys] of Object.entries(sections)) if (!keys.length) delete sections[s];
    if (!Object.keys(sections).length) delete shared[file];
  }
  mkdirSync(path.join(record.installDir, 'BepInEx'), { recursive: true });
  writeFileSync(path.join(record.installDir, 'BepInEx', SHARED_FILE), JSON.stringify(shared, null, 2));
}

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Which installed mod a config file belongs to. BepInEx names the file after the plugin's GUID, which has nothing to do
 * with the Thunderstore name, so this compares the plugin name and GUID in the file's header (and the file name) with
 * each mod's name and DLL names.
 */
function ownerOf(record: ServerRecord, file: string, plugin: string | null, guid: string | null): string | null {
  const reg = vm.loadRegistry(record.installDir);
  const names = [plugin, guid, file.replace(/\.cfg$/i, '')].filter(Boolean).map((n) => squash(n!));
  // GUIDs are often "author.modname": the last part counts on its own too.
  for (const n of [guid, file.replace(/\.cfg$/i, '')]) if (n?.includes('.')) names.push(squash(n.split('.').pop()!));
  let best: { full: string; score: number } | null = null;
  for (const m of Object.values(reg.mods)) {
    const full = vm.fullName(m);
    const candidates = [m.name, ...vm.modDlls(record.installDir, full)].map(squash).filter((c) => c.length >= 3);
    // 2: same name; 1: one contains the other (long enough names only, so "Core" doesn't match everything).
    let score = 0;
    for (const c of candidates) {
      for (const n of names) {
        if (n === c) score = 2;
        else if (n.length >= 5 && c.length >= 5 && (n.includes(c) || c.includes(n))) score = Math.max(score, 1);
      }
    }
    if (score && (!best || score > best.score)) best = { full, score };
  }
  return best?.full ?? null;
}

export interface SettingsFileInfo {
  file: string;
  plugin: string | null;
  version: string | null;
  /** The installed mod ("Author-Name") it belongs to, or null if Tavern Host can't tell. */
  mod: string | null;
  settings: number;
  shared: number;
}

/** Every mod settings file on the server. */
export function listSettingsFiles(record: ServerRecord): SettingsFileInfo[] {
  const dir = configDir(record);
  if (!existsSync(dir)) return [];
  const shared = loadShared(record);
  return readdirSync(dir)
    .filter((f) => isCfgName(f) && f.toLowerCase() !== LOADER_CFG)
    .map((file) => {
      const cfg = parseCfg(readFileSync(path.join(dir, file), 'utf-8'));
      return {
        file,
        plugin: cfg.plugin,
        version: cfg.version,
        mod: ownerOf(record, file, cfg.plugin, cfg.guid),
        settings: cfg.entries.length,
        shared: Object.values(shared[file] ?? {}).reduce((n, keys) => n + keys.length, 0),
      };
    })
    .sort((a, b) => (a.plugin ?? a.file).localeCompare(b.plugin ?? b.file));
}

/** One file's settings, with which ones are sent to players. */
export function readSettings(record: ServerRecord, file: string) {
  const full = cfgPath(record, file);
  if (!existsSync(full)) throw new Error(`${file} isn't there any more.`);
  const cfg = parseCfg(readFileSync(full, 'utf-8'));
  const shared = loadShared(record)[file] ?? {};
  return {
    file,
    plugin: cfg.plugin,
    version: cfg.version,
    mod: ownerOf(record, file, cfg.plugin, cfg.guid),
    entries: cfg.entries.map((e: CfgEntry) => ({ ...e, shared: (shared[e.section] ?? []).includes(e.key) })),
  };
}

/**
 * Saves changed values and the full list of settings sent to players for this file. Returns what changed, for the
 * activity log.
 */
export function writeSettings(record: ServerRecord, file: string, values: CfgChange[], sharedKeys: { section: string; key: string }[]) {
  const full = cfgPath(record, file);
  if (!existsSync(full)) throw new Error(`${file} isn't there any more.`);
  const text = readFileSync(full, 'utf-8');
  const known = new Set(parseCfg(text).entries.map((e) => `${e.section}\u0000${e.key}`));
  for (const c of [...values, ...sharedKeys.map((k) => ({ ...k, value: '' }))]) {
    const bad = checkChange(c);
    if (bad) throw new Error(bad);
    if (!known.has(`${c.section}\u0000${c.key}`)) throw new Error(`"${c.key}" isn't a setting in ${file}.`);
  }
  if (values.length) writeFileSync(full, setValues(text, values));
  const shared = loadShared(record);
  const before = Object.values(shared[file] ?? {}).flat().length;
  shared[file] = {};
  for (const k of sharedKeys) {
    const list = (shared[file][k.section] ??= []);
    if (!list.includes(k.key)) list.push(k.key);
  }
  saveShared(record, shared);
  return { changed: values.length, shared: sharedKeys.length, sharedBefore: before };
}

/** What the share link carries: the server's current value of every setting sent to players. */
export function sharedSettings(record: ServerRecord): { file: string; section: string; key: string; value: string }[] {
  if (activeIsVanilla(record)) return [];
  const out: { file: string; section: string; key: string; value: string }[] = [];
  for (const [file, sections] of Object.entries(loadShared(record))) {
    let entries: CfgEntry[];
    try {
      entries = parseCfg(readFileSync(cfgPath(record, file), 'utf-8')).entries;
    } catch {
      continue; // the file (or its mod) is gone
    }
    for (const [section, keys] of Object.entries(sections)) {
      for (const key of keys) {
        const e = entries.find((x) => x.section === section && x.key === key);
        if (e) out.push({ file, section, key, value: e.value });
      }
    }
  }
  return out;
}
