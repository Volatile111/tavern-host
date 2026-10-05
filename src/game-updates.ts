// Game server updates (Bedrock and Valheim). Every 30 minutes (and on demand) the latest version is compared with each
// server's: Bedrock from Mojang's download service, Valheim from Steam (the public build of the dedicated server app).
// By default the owner is asked (an "update available" notice with Update now); servers with automatic updates on update
// by themselves: in-game countdown if running (games that can message players), stop, back up, update, start again. A
// forced update checks right then and installs the latest version even if the server already looks up to date.
// Bedrock addons stay switched on through an update (the world's pack lists are compared before and after); Valheim mods
// (BepInEx) are extra files Steam leaves alone.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { events } from './events.ts';
import { listInstances, getInstance } from './instances.ts';
import { jobsFor } from './jobs.ts';
import { latestDownload, installedVersion } from './games/bedrock.ts';
import { latestBuild, installedBuild } from './steamcmd.ts';
import { latestTmlVersion, installedTmlVersion } from './games/terraria.ts';
import { SATISFACTORY_APP } from './games/satisfactory.ts';
import { SPACE_ENGINEERS_APP } from './games/spaceengineers.ts';
import { readProperties } from './properties.ts';

type Instance = ReturnType<typeof getInstance>;

export interface UpdateInfo {
  game: string;
  /** What's installed (Bedrock version, or Valheim's Steam build). null: not known yet. */
  current: string | null;
  latest: string | null;
  /** Readable extras, e.g. Valheim's game version from the last start ("0.219.16") and when the latest build came out. */
  currentLabel: string | null;
  latestLabel: string | null;
  available: boolean;
  checkedAt: number | null;
  auto: boolean;
  updating: boolean;
}

interface Source {
  name: string;
  /** Asks the internet for the latest version; `updated` = release time if known. */
  latest(): Promise<{ version: string; updated: number | null }>;
  current(inst: Instance): string | null;
  currentLabel?(inst: Instance): string | null;
  newer(latest: string, current: string): boolean;
  /** Called after a successful update with the version that was being installed. */
  installed?(inst: Instance, version: string): void;
  /** Snapshot of things an update must not change (Bedrock: the world's addon lists). */
  guard?(inst: Instance): string;
}

const newerDotted = (a: string, b: string) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};

/** The world's pack lists (Bedrock), to check an update left every addon switched on. */
function packLists(inst: Instance): string {
  const level = readProperties(path.join(inst.record.installDir, 'server.properties')).values.get('level-name') || 'Bedrock level';
  return ['world_behavior_packs.json', 'world_resource_packs.json']
    .map((f) => path.join(inst.record.installDir, 'worlds', level, f))
    .map((f) => (existsSync(f) ? readFileSync(f, 'utf-8') : ''))
    .join('\n--\n');
}

const VALHEIM_APP = 896660;
// Tavern Host's own note of the Steam build it installed (SteamCMD doesn't always leave its app manifest in the folder).
const buildNote = (inst: Instance) => path.join(inst.record.installDir, '.tavernhost-steam.json');

const SOURCES: Record<string, Source> = {
  bedrock: {
    name: 'Bedrock',
    latest: async () => ({ version: (await latestDownload()).version, updated: null }),
    // Imported servers have no version file of ours: use the version the server printed at startup instead.
    current: (inst) => installedVersion(inst.record.installDir) || inst.liveState().version || null,
    newer: newerDotted,
    guard: packLists,
  },
  valheim: {
    name: 'Valheim',
    latest: async () => {
      const b = await latestBuild(VALHEIM_APP);
      return { version: b.build, updated: b.updated };
    },
    current: (inst) => {
      const fromSteam = installedBuild(VALHEIM_APP, inst.record.installDir);
      if (fromSteam) return fromSteam;
      try {
        return String(JSON.parse(readFileSync(buildNote(inst), 'utf-8')).build ?? '') || null;
      } catch {
        return null;
      }
    },
    currentLabel: (inst) => {
      const v = inst.liveState().version;
      return v ? `game version ${v.replace(/^l-/, '')}` : null;
    },
    newer: (a, b) => Number(a) > Number(b),
    installed: (inst, build) => {
      try {
        writeFileSync(buildNote(inst), JSON.stringify({ appId: VALHEIM_APP, build, at: Date.now() }, null, 2));
      } catch {}
    },
  },
  // Satisfactory's dedicated server on Steam (public branch build), like Valheim.
  satisfactory: {
    name: 'Satisfactory',
    latest: async () => {
      const b = await latestBuild(SATISFACTORY_APP);
      return { version: b.build, updated: b.updated };
    },
    current: (inst) => {
      const fromSteam = installedBuild(SATISFACTORY_APP, inst.record.installDir);
      if (fromSteam) return fromSteam;
      try {
        return String(JSON.parse(readFileSync(buildNote(inst), 'utf-8')).build ?? '') || null;
      } catch {
        return null;
      }
    },
    newer: (a, b) => Number(a) > Number(b),
    installed: (inst, build) => {
      try {
        writeFileSync(buildNote(inst), JSON.stringify({ appId: SATISFACTORY_APP, build, at: Date.now() }, null, 2));
      } catch {}
    },
  },
  // Space Engineers' dedicated server on Steam (public branch build).
  spaceengineers: {
    name: 'Space Engineers',
    latest: async () => {
      const b = await latestBuild(SPACE_ENGINEERS_APP);
      return { version: b.build, updated: b.updated };
    },
    current: (inst) => {
      const fromSteam = installedBuild(SPACE_ENGINEERS_APP, inst.record.installDir);
      if (fromSteam) return fromSteam;
      try {
        return String(JSON.parse(readFileSync(buildNote(inst), 'utf-8')).build ?? '') || null;
      } catch {
        return null;
      }
    },
    newer: (a, b) => Number(a) > Number(b),
    installed: (inst, build) => {
      try {
        writeFileSync(buildNote(inst), JSON.stringify({ appId: SPACE_ENGINEERS_APP, build, at: Date.now() }, null, 2));
      } catch {}
    },
  },
  // tModLoader releases on GitHub (Terraria itself comes inside them).
  terraria: {
    name: 'tModLoader',
    latest: async () => ({ version: await latestTmlVersion(), updated: null }),
    current: (inst) => installedTmlVersion(inst.record.installDir),
    newer: newerDotted,
  },
};

export const updatesSupported = (game: string) => game in SOURCES;

const latest = new Map<string, { version: string; updated: number | null; checkedAt: number }>();
const updating = new Set<string>();

export function updateInfo(inst: Instance): UpdateInfo {
  const src = SOURCES[inst.record.game];
  if (!src) throw new Error(`${inst.module.name} servers don't have update checks.`);
  const current = src.current(inst);
  const l = latest.get(inst.record.game) ?? null;
  return {
    game: inst.record.game,
    current,
    latest: l?.version ?? null,
    currentLabel: src.currentLabel?.(inst) ?? null,
    latestLabel: l?.updated ? `released ${new Date(l.updated).toLocaleString()}` : null,
    // Unknown current version (e.g. a server installed before update checks existed): one update makes it known.
    available: !!(l && (current ? src.newer(l.version, current) : true)),
    checkedAt: l?.checkedAt ?? null,
    auto: !!inst.record.autoUpdate,
    updating: updating.has(inst.id),
  };
}

/** Asks for the latest version of every game with servers here (at most every 10 minutes unless forced) and acts on it. */
export async function checkUpdates(force = false, only?: string) {
  const games = [...new Set(listInstances().map((i) => i.record.game))].filter((g) => SOURCES[g] && (!only || g === only));
  const errors: string[] = [];
  for (const game of games) {
    const have = latest.get(game);
    if (!force && have && Date.now() - have.checkedAt < 10 * 60_000) continue;
    try {
      const l = await SOURCES[game].latest();
      latest.set(game, { ...l, checkedAt: Date.now() });
    } catch (err) {
      errors.push(`${SOURCES[game].name}: ${(err as Error).message}`);
      continue;
    }
    for (const inst of listInstances()) {
      if (inst.record.game !== game) continue;
      const info = updateInfo(inst);
      events.emit('game-update', { serverId: inst.id, ...info });
      if (info.available && inst.record.autoUpdate && !updating.has(inst.id)) {
        updateGame(inst.id, { countdownMinutes: 5, auto: true }).catch((err) => inst.log(`Automatic update failed: ${(err as Error).message}`));
      }
    }
  }
  if (errors.length && only) throw new Error(errors.join(' '));
}

/** Waits for a server's current job (backup/install) to finish; throws if it failed. */
async function waitForJob(serverId: string, jobId: string) {
  for (;;) {
    const job = jobsFor(serverId).find((j) => j.id === jobId);
    if (!job || job.status === 'done') return;
    if (job.status === 'failed') throw new Error(job.error ?? 'failed');
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/**
 * Updates a server to the latest version: warns players and stops it (if running), backs it up, installs the new
 * version, and starts it again if it was running. `force` installs even when the server already looks current.
 */
export async function updateGame(serverId: string, opts: { countdownMinutes?: number; auto?: boolean; force?: boolean } = {}) {
  const inst = getInstance(serverId);
  const src = SOURCES[inst.record.game];
  if (!src) throw new Error(`${inst.module.name} servers can't be updated this way.`);
  if (updating.has(serverId)) throw new Error('This server is already updating.');
  updating.add(serverId);
  events.emit('state', serverId);
  const target = latest.get(inst.record.game)?.version;
  const targetLabel = target ? `${src.name} ${inst.record.game === 'valheim' ? `build ${target}` : target}` : `the latest ${src.name} version`;
  try {
    const wasRunning = inst.isRunning;
    inst.log(`${opts.auto ? 'Automatic update' : opts.force ? 'Forced update' : 'Update'} to ${targetLabel} started.`);
    if (wasRunning) {
      const minutes = Math.max(0, Math.min(Number(opts.countdownMinutes ?? 0), 60));
      if (inst.canAnnounce) {
        const marks = minutes ? [minutes, ...[30, 15, 10, 5, 2, 1].filter((m) => m < minutes)] : [];
        const went = await inst.countdownThen('stop', marks, `Server updating to ${targetLabel} in {time}. Back in a few minutes!`, `update to ${targetLabel}`);
        if (!went) {
          inst.log('Update cancelled (the countdown was cancelled).');
          return { cancelled: true };
        }
      } else {
        // Games that can't message players (Valheim): an automatic update waits until nobody is online (at most an
        // hour); "Update now" waits the minutes chosen.
        const online = () => inst.liveState().playerCount ?? inst.liveState().players?.length ?? 0;
        const until = Date.now() + (opts.auto ? 60 : minutes) * 60_000;
        if (opts.auto && online()) inst.log(`Waiting for the server to be empty before updating (${online()} online; at most an hour).`);
        else if (minutes) inst.log(`Stopping for the update in ${minutes} minute${minutes === 1 ? '' : 's'}.`);
        while (Date.now() < until && inst.isRunning && (!opts.auto || online() > 0)) await new Promise((r) => setTimeout(r, 15_000));
        if (inst.isRunning) await inst.stop();
      }
    }
    // A backup first, so the update can be undone.
    const backup = inst.backupNow('manual');
    await waitForJob(serverId, backup.id);
    const before = src.guard?.(inst);
    const job = inst.installSoftware(`Updating to ${targetLabel}`, { force: opts.force });
    await waitForJob(serverId, job.id);
    if (target) src.installed?.(inst, target);
    if (src.guard) inst.log(src.guard(inst) !== before ? "Note: the world's addon lists changed during the update; check the Addons tab." : 'All addons are still switched on.');
    if (wasRunning) await inst.start();
    inst.log(`Updated to ${targetLabel}.`);
    events.emit('game-update', { serverId, ...updateInfo(inst) });
    return { cancelled: false };
  } finally {
    updating.delete(serverId);
    events.emit('state', serverId);
  }
}

export function startUpdateChecks() {
  const run = () => checkUpdates(true).catch(() => {});
  setTimeout(run, 60_000).unref();
  setInterval(run, 30 * 60_000).unref();
}
