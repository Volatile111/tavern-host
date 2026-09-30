// Bedrock world settings that normally need the game: experiments and cheats. Experiments live in the world's
// level.dat ("experiments" compound). Cheats are decided by allow-cheats in server.properties (the server copies it into
// level.dat's commandsEnabled on every start), so both are updated together.
// The server rewrites level.dat when it stops, so changes are only written while it's stopped.
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { parseLevelDat, serializeLevelDat, T, type Tag } from './bedrock-nbt.ts';
import { readProperties, writeProperties } from '../properties.ts';

// Keys confirmed against Bedrock Dedicated Server 1.26.5x: the server keeps these when it saves level.dat and drops
// unknown ones. Keys a world already has that aren't listed here are still shown (under their raw name).
export const EXPERIMENTS: { key: string; label: string; help: string }[] = [
  { key: 'gametest', label: 'Beta APIs', help: 'Lets addons use the beta Script API. Many script-based addons need this.' },
  { key: 'upcoming_creator_features', label: 'Upcoming Creator Features', help: 'Early access to new addon features (blocks, items, entities).' },
  { key: 'data_driven_items', label: 'Holiday Creator Features', help: 'Older addon features some addons still rely on for custom items and blocks.' },
  { key: 'experimental_molang_features', label: 'Experimental Molang Features', help: 'New Molang queries used by some addons.' },
  { key: 'data_driven_biomes', label: 'Custom Biomes', help: 'Lets addons add their own biomes.' },
  { key: 'jigsaw_structures', label: 'Data-Driven Jigsaw Structures', help: 'Lets addons generate custom jigsaw structures (villages, dungeons...).' },
  { key: 'villager_trades_rebalance', label: 'Villager Trade Rebalancing', help: "Mojang's reworked villager trades." },
  { key: 'voxel_shapes', label: 'Vanilla Voxel Shapes', help: 'New collision/selection shapes for vanilla blocks.' },
  { key: 'experimental_creator_cameras', label: 'Experimental Creator Cameras', help: 'New camera controls for addons and commands.' },
  { key: 'camera_aim_assist', label: 'Camera Aim Assist', help: 'Aim assist presets for addons.' },
];
const BOOKKEEPING = new Set(['experiments_ever_used', 'saved_with_toggled_experiments']);

// The game's "Cheat settings" (world settings screen). They're game rules stored in level.dat.
export type CheatSetting =
  | { key: string; label: string; help: string; kind: 'bool'; def: boolean }
  | { key: string; label: string; help: string; kind: 'int'; def: number; min: number; max: number }
  | { key: 'daylight'; label: string; help: string; kind: 'choice'; def: string; options: { value: string; label: string; help: string }[] };

export const CHEAT_SETTINGS: CheatSetting[] = [
  {
    key: 'daylight',
    label: 'Daylight cycle',
    help: 'How time passes.',
    kind: 'choice',
    def: 'normal',
    options: [
      { value: 'normal', label: 'Normal', help: 'In-game time passes normally, from day to night.' },
      { value: 'always_day', label: 'Always day', help: "It's always daytime (time is set to midday and stops)." },
      { value: 'lock', label: 'Lock time', help: 'Time stops at the current time of day.' },
    ],
  },
  { key: 'keepinventory', label: 'Keep inventory', help: 'Keep all items in the inventory when you die.', kind: 'bool', def: false },
  { key: 'domobspawning', label: 'Mob spawning', help: 'Mobs spawn naturally.', kind: 'bool', def: true },
  { key: 'mobgriefing', label: 'Mob griefing', help: 'Mobs can move and destroy blocks in your world.', kind: 'bool', def: true },
  { key: 'doentitydrops', label: 'Entities drop loot', help: 'Non-mob entities, like paintings, drop items when destroyed.', kind: 'bool', def: true },
  { key: 'doweathercycle', label: 'Weather cycle', help: 'The possibility to get rain, snow and thunderstorms.', kind: 'bool', def: true },
  { key: 'commandblocksenabled', label: 'Command blocks', help: 'Use commands to program these blocks.', kind: 'bool', def: true },
  { key: 'educationFeaturesEnabled', label: 'Minecraft Education features', help: 'Enables educational items like the chemistry kit.', kind: 'bool', def: false },
  { key: 'randomtickspeed', label: 'Random tick speed', help: 'How fast crops grow, leaves decay and similar random updates happen. Default 1.', kind: 'int', def: 1, min: 0, max: 4096 },
];

// level.dat's daylightCycle: 0 normal, 1 always day, 2 lock time (dodaylightcycle is off for both of the latter).
const DAYLIGHT = ['normal', 'always_day', 'lock'];

export interface WorldSettings {
  /** false until the server has created the world (start it once). */
  exists: boolean;
  world: string;
  cheats: boolean;
  /** Cheat settings with their current values (defaults when the world doesn't exist yet). */
  cheatSettings: (CheatSetting & { value: boolean | number | string })[];
  /** locked = on, and (like in the game) can't be turned off without `force`. */
  experiments: { key: string; label: string; help: string; enabled: boolean; known: boolean; locked: boolean }[];
  everUsedExperiments: boolean;
}

export interface WorldChanges {
  cheats?: boolean;
  experiments?: Record<string, boolean>;
  cheatSettings?: Record<string, boolean | number | string>;
  /** Allow turning experiments off (the game never allows it). */
  force?: boolean;
}

function byteOn(root: Map<string, Tag>, key: string, def: boolean) {
  const t = root.get(key);
  return t && t.type === T.Byte ? t.value !== 0 : def;
}

function readCheatSettings(root: Map<string, Tag> | null) {
  return CHEAT_SETTINGS.map((s) => {
    if (!root) return { ...s, value: s.def };
    if (s.kind === 'choice') {
      const t = root.get('daylightCycle');
      const n = t && t.type === T.Int ? t.value : byteOn(root, 'dodaylightcycle', true) ? 0 : 2;
      return { ...s, value: DAYLIGHT[n] ?? 'normal' };
    }
    if (s.kind === 'int') {
      const t = root.get(s.key);
      return { ...s, value: t && (t.type === T.Int || t.type === T.Short || t.type === T.Byte) ? t.value : s.def };
    }
    return { ...s, value: byteOn(root, s.key, s.def) };
  });
}

/** Sets a number-typed tag, keeping the type it already has. */
function setNumber(root: Map<string, Tag>, key: string, value: number, fallback: 1 | 2 | 3) {
  const t = root.get(key);
  const type = t && (t.type === T.Byte || t.type === T.Short || t.type === T.Int) ? t.type : fallback;
  root.set(key, { type, value } as Tag);
}

function levelFile(installDir: string, level: string) {
  return path.join(installDir, 'worlds', level, 'level.dat');
}
function propsFile(installDir: string) {
  return path.join(installDir, 'server.properties');
}

function experimentsOf(root: Map<string, Tag>): Map<string, Tag> {
  let exp = root.get('experiments');
  if (!exp || exp.type !== T.Compound) {
    exp = { type: T.Compound, value: new Map() };
    root.set('experiments', exp);
  }
  return exp.value;
}

export function readWorldSettings(installDir: string, level: string): WorldSettings {
  const cheats = readProperties(propsFile(installDir)).values.get('allow-cheats') === 'true';
  const file = levelFile(installDir, level);
  const base = { world: level, cheats };
  if (!existsSync(file)) {
    return {
      ...base,
      exists: false,
      everUsedExperiments: false,
      cheatSettings: readCheatSettings(null),
      experiments: EXPERIMENTS.map((e) => ({ ...e, enabled: false, known: true, locked: false })),
    };
  }
  const dat = parseLevelDat(readFileSync(file));
  const exp = experimentsOf(dat.root);
  const on = (k: string) => {
    const t = exp.get(k);
    return !!t && t.type === T.Byte && t.value !== 0;
  };
  const experiments = EXPERIMENTS.map((e) => ({ ...e, enabled: on(e.key), known: true, locked: on(e.key) }));
  for (const key of exp.keys()) {
    if (!BOOKKEEPING.has(key) && !EXPERIMENTS.some((e) => e.key === key)) {
      experiments.push({ key, label: key, help: "Experiment set in this world (not in Tavern Host's list).", enabled: on(key), known: false, locked: on(key) });
    }
  }
  return { ...base, exists: true, everUsedExperiments: on('experiments_ever_used'), cheatSettings: readCheatSettings(dat.root), experiments };
}

/** Applies cheat-setting changes to level.dat's root; returns notes. */
function applyCheatSettings(root: Map<string, Tag>, changes: Record<string, boolean | number | string>): string[] {
  const notes: string[] = [];
  const current = readCheatSettings(root);
  for (const [key, value] of Object.entries(changes)) {
    const s = current.find((x) => x.key === key);
    if (!s) throw new Error(`Unknown cheat setting "${key}".`);
    if (s.value === value) continue;
    if (s.kind === 'choice') {
      const n = DAYLIGHT.indexOf(String(value));
      if (n < 0) throw new Error('Daylight cycle must be normal, always_day or lock.');
      setNumber(root, 'daylightCycle', n, T.Int);
      setNumber(root, 'dodaylightcycle', n === 0 ? 1 : 0, T.Byte);
      if (n === 1) {
        // Always day: jump to midday of the current day and stay there.
        const t = root.get('Time');
        if (t && t.type === T.Long) root.set('Time', { type: T.Long, value: t.value - (t.value % 24000n) + 6000n });
      }
      notes.push(`Daylight cycle: ${s.options.find((o) => o.value === value)?.label}`);
    } else if (s.kind === 'int') {
      const n = Number(value);
      if (!Number.isInteger(n) || n < s.min || n > s.max) throw new Error(`${s.label} must be a whole number from ${s.min} to ${s.max}.`);
      setNumber(root, key, n, T.Int);
      notes.push(`${s.label}: ${n}`);
    } else {
      if (typeof value !== 'boolean') throw new Error(`${s.label} must be on or off.`);
      setNumber(root, key, value ? 1 : 0, T.Byte);
      notes.push(`${s.label} ${value ? 'on' : 'off'}`);
    }
  }
  return notes;
}

/**
 * Writes cheats, cheat settings and experiments. The caller must make sure the server is stopped. Everything is checked
 * before anything is written. Returns short notes of what changed.
 */
export function writeWorldSettings(installDir: string, level: string, changes: WorldChanges): string[] {
  const notes: string[] = [];
  const file = levelFile(installDir, level);
  const cheatsNow = readProperties(propsFile(installDir)).values.get('allow-cheats') === 'true';
  const cheatsChange = changes.cheats !== undefined && changes.cheats !== cheatsNow;
  const needsWorld = Object.keys(changes.experiments ?? {}).length > 0 || Object.keys(changes.cheatSettings ?? {}).length > 0;

  let dat: ReturnType<typeof parseLevelDat> | null = null;
  let worldChanged = false;
  if (existsSync(file)) {
    dat = parseLevelDat(readFileSync(file));
    const exp = experimentsOf(dat.root);
    for (const [key, enabled] of Object.entries(changes.experiments ?? {})) {
      if (!/^[a-z0-9_]{1,64}$/.test(key) || BOOKKEEPING.has(key)) throw new Error(`"${key}" isn't a valid experiment name.`);
      const was = exp.get(key);
      const wasOn = !!was && was.type === T.Byte && was.value !== 0;
      if (wasOn === enabled) continue;
      const label = EXPERIMENTS.find((e) => e.key === key)?.label ?? key;
      // Like the game: experiments are one-way, because the world may now contain experimental content.
      if (!enabled && !changes.force) throw new Error(`"${label}" can't be turned off once it's on (the game doesn't allow it either).`);
      exp.set(key, { type: T.Byte, value: enabled ? 1 : 0 });
      worldChanged = true;
      notes.push(`${label} ${enabled ? 'on' : 'off'}`);
    }
    const cheatNotes = applyCheatSettings(dat.root, changes.cheatSettings ?? {});
    if (cheatNotes.length) worldChanged = true;
    notes.push(...cheatNotes);
    if (changes.cheats !== undefined) {
      // Keep level.dat in step (the server also does this from allow-cheats when it starts).
      const cur = dat.root.get('commandsEnabled');
      const want = changes.cheats ? 1 : 0;
      if (!cur || cur.type !== T.Byte || cur.value !== want) {
        dat.root.set('commandsEnabled', { type: T.Byte, value: want });
        worldChanged = true;
      }
    }
    if (worldChanged) {
      const anyOn = [...exp].some(([k, t]) => !BOOKKEEPING.has(k) && t.type === T.Byte && t.value !== 0);
      // Same bookkeeping the game does: once a world has used experiments it stays marked.
      if (anyOn) exp.set('experiments_ever_used', { type: T.Byte, value: 1 });
      exp.set('saved_with_toggled_experiments', { type: T.Byte, value: anyOn ? 1 : 0 });
    }
  } else if (needsWorld) {
    throw new Error("This world hasn't been created yet. Start the server once so it creates the world, stop it, then change experiments and cheat settings.");
  }

  // Everything checked: write.
  if (cheatsChange) {
    writeProperties(propsFile(installDir), { 'allow-cheats': String(changes.cheats) });
    notes.unshift(`Cheats ${changes.cheats ? 'on' : 'off'}`);
  }
  if (dat && worldChanged) {
    copyFileSync(file, `${file}.tavernhost-bak`);
    writeFileSync(file, serializeLevelDat(dat));
  }
  return notes;
}
