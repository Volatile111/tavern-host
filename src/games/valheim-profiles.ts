// Valheim server profiles: one server, several setups. A profile is a world (save) plus which mods are on, or
// "vanilla" (the server's BepInEx switched off, so it runs plain Valheim without removing any mod). Switching sets the
// server's world and mod switches; the players' Tavern Client Mod Manager follows automatically, because the shared mod
// list is whatever is switched on. The active profile follows what the owner changes (world in Settings, mod switches),
// so switching away and back restores it exactly.
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJson, writeJson } from '../store.ts';
import * as vm from '../valheim-mods.ts';
import type { ServerRecord } from './types.ts';

export interface ValheimProfile {
  id: string;
  name: string;
  world: string;
  /** BepInEx switched off: plain Valheim. */
  vanilla: boolean;
  /** Mods switched off in this profile (mods it hasn't seen yet, i.e. installed later, are on). */
  disabled: string[];
}

interface Store {
  active: string | null;
  profiles: ValheimProfile[];
}

const file = (serverId: string) => path.join('valheim-profiles', `${serverId}.json`);
const load = (serverId: string) => readJson<Store>(file(serverId), { active: null, profiles: [] });
const save = (serverId: string, s: Store) => writeJson(file(serverId), s);

/** Worlds in the save folder: Valheim 1.0 folders (worlds_local/<name>/_main.*.fwl2) and older <name>.fwl files. */
export function listWorlds(record: ServerRecord): string[] {
  const dir = path.join(String(record.settings.saveDir), 'worlds_local');
  const out = new Set<string>();
  try {
    for (const e of readdirSync(dir)) {
      const full = path.join(dir, e);
      if (/\.fwl$/i.test(e)) out.add(e.replace(/\.fwl$/i, ''));
      else if (statSync(full).isDirectory() && readdirSync(full).some((f) => /\.fwl2?$/i.test(f))) out.add(e);
    }
  } catch {}
  return [...out].sort((a, b) => a.localeCompare(b));
}

const offNow = (record: ServerRecord) =>
  Object.values(vm.loadRegistry(record.installDir).mods)
    .filter((m) => !m.enabled)
    .map(vm.fullName);
const loaderOn = (record: ServerRecord) => vm.loaderEnabled(record.installDir) !== false;

/** Records the server's current world and mod switches into the active profile. */
function capture(record: ServerRecord, s: Store) {
  const p = s.profiles.find((x) => x.id === s.active);
  if (!p) return;
  p.world = String(record.settings.world);
  p.vanilla = vm.bepinexStatus(record.installDir).installed ? !loaderOn(record) : true;
  p.disabled = offNow(record);
}

/**
 * Every Valheim server has at least one profile: servers made before profiles existed (e.g. after updating Tavern
 * Host), and new ones, get "Main" = the server exactly as it's set up now, active. Nothing about the server changes.
 */
export function ensureDefaultProfile(record: ServerRecord) {
  const s = load(record.id);
  if (s.profiles.length) return false;
  const main: ValheimProfile = {
    id: randomUUID().slice(0, 8),
    name: 'Main',
    world: String(record.settings.world),
    vanilla: !vm.bepinexStatus(record.installDir).installed || !loaderOn(record),
    disabled: offNow(record),
  };
  save(record.id, { active: main.id, profiles: [main] });
  return true;
}

export function profilesInfo(record: ServerRecord) {
  ensureDefaultProfile(record);
  const s = load(record.id);
  capture(record, s);
  save(record.id, s);
  return {
    active: s.active,
    profiles: s.profiles.map((p) => ({ id: p.id, name: p.name, world: p.world, vanilla: p.vanilla, modsOff: p.disabled.length })),
    worlds: listWorlds(record),
    modded: vm.bepinexStatus(record.installDir).installed,
    modCount: Object.keys(vm.loadRegistry(record.installDir).mods).length,
  };
}

/** A new profile. It starts as a copy of the server as it is now (world, mods), or vanilla. */
export function createProfile(record: ServerRecord, input: { name: string; world?: string; vanilla?: boolean }) {
  const s = load(record.id);
  const name = String(input.name ?? '').trim().slice(0, 40);
  if (!name) throw new Error('Give the profile a name.');
  if (s.profiles.some((p) => p.name.toLowerCase() === name.toLowerCase())) throw new Error('A profile with that name already exists.');
  const world = String(input.world ?? record.settings.world).trim();
  if (!/^[\w -]{1,60}$/.test(world)) throw new Error('World name can only use letters, numbers, spaces, - and _.');
  capture(record, s);
  // (Servers always have "Main" by now: see ensureDefaultProfile. This covers one made before that ran.)
  if (!s.profiles.length) {
    const first: ValheimProfile = { id: randomUUID().slice(0, 8), name: 'Main', world: String(record.settings.world), vanilla: !vm.bepinexStatus(record.installDir).installed || !loaderOn(record), disabled: offNow(record) };
    if (first.name.toLowerCase() !== name.toLowerCase()) {
      s.profiles.push(first);
      s.active = first.id;
    }
  }
  const p: ValheimProfile = { id: randomUUID().slice(0, 8), name, world, vanilla: !!input.vanilla || !vm.bepinexStatus(record.installDir).installed, disabled: offNow(record) };
  s.profiles.push(p);
  s.active ??= p.id;
  save(record.id, s);
  return p;
}

export function updateProfile(record: ServerRecord, id: string, input: { name?: string; world?: string; vanilla?: boolean }) {
  const s = load(record.id);
  capture(record, s);
  const p = s.profiles.find((x) => x.id === id);
  if (!p) throw new Error('That profile no longer exists.');
  if (input.name !== undefined) {
    const name = String(input.name).trim().slice(0, 40);
    if (!name) throw new Error('Give the profile a name.');
    if (s.profiles.some((x) => x.id !== id && x.name.toLowerCase() === name.toLowerCase())) throw new Error('A profile with that name already exists.');
    p.name = name;
  }
  if (input.world !== undefined) {
    const world = String(input.world).trim();
    if (!/^[\w -]{1,60}$/.test(world)) throw new Error('World name can only use letters, numbers, spaces, - and _.');
    p.world = world;
  }
  if (input.vanilla !== undefined) p.vanilla = !!input.vanilla;
  save(record.id, s);
  return { profile: p, isActive: s.active === id };
}

export function deleteProfile(record: ServerRecord, id: string) {
  const s = load(record.id);
  // The active profile can't be deleted, so one always remains.
  if (s.active === id) throw new Error('Switch to another profile before deleting this one.');
  s.profiles = s.profiles.filter((p) => p.id !== id);
  save(record.id, s);
}

/**
 * Applies a profile to the (stopped) server: its mod switches and loader. Returns the world the server must use (the
 * caller saves it in the server's settings). `placeMod` puts each mod where the server loads it (or doesn't).
 */
export function applyProfile(record: ServerRecord, id: string, placeMod: (full: string) => void): { world: string; profile: ValheimProfile } {
  const s = load(record.id);
  const p = s.profiles.find((x) => x.id === id);
  if (!p) throw new Error('That profile no longer exists.');
  capture(record, s);
  if (vm.bepinexStatus(record.installDir).installed) {
    const off = new Set(p.disabled.map((f) => f.toLowerCase()));
    for (const m of Object.values(vm.loadRegistry(record.installDir).mods)) {
      const full = vm.fullName(m);
      const want = !off.has(full.toLowerCase());
      if (m.enabled !== want) vm.setModEnabled(record.installDir, full, want);
      placeMod(full);
    }
    vm.setLoaderEnabled(record.installDir, !p.vanilla);
  } else if (!p.vanilla) {
    throw new Error('This server has modding off. Turn on modding (Mods tab) to use a modded profile.');
  }
  s.active = id;
  save(record.id, s);
  return { world: p.world, profile: p };
}

/** Whether players should be told to use mods: false while a vanilla profile is active. */
export function activeIsVanilla(record: ServerRecord): boolean {
  const s = load(record.id);
  const p = s.profiles.find((x) => x.id === s.active);
  return p ? p.vanilla : vm.bepinexStatus(record.installDir).installed ? !loaderOn(record) : false;
}

export const worldExists = (record: ServerRecord, world: string) =>
  existsSync(path.join(String(record.settings.saveDir), 'worlds_local', world)) || existsSync(path.join(String(record.settings.saveDir), 'worlds_local', `${world}.fwl`));
