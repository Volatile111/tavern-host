// World checker (Bedrock). Every backup's copy of the world is checked in the background (a worker thread), and the
// owner can check on demand. Each check takes a census of the world's chunks and compares it with the last good one
// (see world-census.ts): chunks that vanished, chunks with missing block layers, chunks the game generated again
// because their data was lost, and damaged database blocks. Damage raises an alert straight away, marks the backup,
// and keeps the reference census as it was, so every later check keeps reporting it until the world is repaired or
// the owner accepts the change. The newest backup that passed stays protected from automatic pruning (backups.ts).
import { Worker } from 'node:worker_threads';
import { existsSync, mkdirSync, readdirSync, rmSync, renameSync, linkSync, copyFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { events } from './events.ts';
import { dataPath, readJson, writeJson } from './store.ts';
import { onBackupStaged, setBackupCheck, stageWorld, lastGoodBackup, type BackupTarget } from './backups.ts';
import { getInstance, listInstances } from './instances.ts';
import type { ServerRecord } from './games/types.ts';
import type { CensusResult } from './world-census.ts';

export interface WorldCheckRun {
  at: number;
  source: 'backup' | 'manual' | 'after-force-stop';
  backupId?: string;
  status: 'ok' | 'damaged' | 'failed';
  /** The first check of a world only takes its reference census. */
  reference?: boolean;
  result?: CensusResult;
  error?: string;
  seconds?: number;
}

interface State {
  last?: WorldCheckRun;
  /** When the owner last accepted a flagged state as normal. */
  acceptedAt?: number;
}

export interface WorldCheckInfo {
  supported: boolean;
  running: { done: number; total: number; source: string } | null;
  queued: boolean;
  last: WorldCheckRun | null;
  referenceAt: number | null;
  lastGoodBackup: { id: string; createdAt: number } | null;
}

const dir = (serverId: string) => dataPath('world-checks', serverId);
const stateFile = (serverId: string) => path.join('world-checks', serverId, 'state.json');
const referenceFile = (serverId: string) => path.join(dir(serverId), 'reference.census');
const latestFile = (serverId: string) => path.join(dir(serverId), 'latest.census');

export const worldCheckSupported = (record: ServerRecord) => record.game === 'bedrock';

// ---------- queue: one check at a time across the panel (each reads a whole world) ----------

interface Task {
  serverId: string;
  /** Folder holding the copy of the world (deleted when the check is done). */
  folder: string;
  dbDir: string;
  world: string;
  source: WorldCheckRun['source'];
  backupId?: string;
}

const queue: Task[] = [];
let current: (Task & { done: number; total: number }) | null = null;

function enqueue(t: Task) {
  // A newer copy of the same world replaces one still waiting.
  const i = queue.findIndex((q) => q.serverId === t.serverId);
  if (i >= 0) {
    const [old] = queue.splice(i, 1);
    rmSync(old.folder, { recursive: true, force: true });
    if (old.backupId) setBackupCheck(old.serverId, old.backupId, { status: 'failed', at: Date.now(), summary: 'Skipped: a newer copy was checked instead.' });
  }
  queue.push(t);
  if (t.backupId) setBackupCheck(t.serverId, t.backupId, { status: 'checking' });
  events.emit('world-check', { serverId: t.serverId, phase: 'queued' });
  pump();
}

function pump() {
  if (current || !queue.length) return;
  const t = queue.shift()!;
  current = { ...t, done: 0, total: 0 };
  run(t)
    .catch(() => {})
    .finally(() => {
      rmSync(t.folder, { recursive: true, force: true });
      current = null;
      pump();
    });
}

async function run(t: Task) {
  const started = Date.now();
  mkdirSync(dir(t.serverId), { recursive: true });
  const outFile = path.join(dir(t.serverId), `census-${randomUUID().slice(0, 8)}.tmp`);
  events.emit('world-check', { serverId: t.serverId, phase: 'started' });
  let run: WorldCheckRun;
  try {
    const result = await new Promise<CensusResult>((resolve, reject) => {
      const ext = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
      const worker = new Worker(new URL(`./world-census${ext}`, import.meta.url), {
        workerData: { dbDir: t.dbDir, world: t.world, baselineFile: referenceFile(t.serverId), outFile },
        resourceLimits: { maxOldGenerationSizeMb: 2048 },
      });
      worker.on('message', (m: { type: string; done?: number; total?: number; result?: CensusResult; message?: string }) => {
        if (m.type === 'progress' && current) {
          current.done = m.done ?? 0;
          current.total = m.total ?? 0;
          events.emit('world-check', { serverId: t.serverId, phase: 'progress', done: current.done, total: current.total });
        } else if (m.type === 'done') resolve(m.result!);
        else if (m.type === 'error') reject(new Error(m.message));
      });
      worker.on('error', reject);
      worker.on('exit', (code) => (code ? reject(new Error(`the checker stopped unexpectedly (code ${code})`)) : null));
    });
    const reference = result.baselineChunks === null;
    if (!result.damaged) {
      // Healthy: this census becomes the reference for the next check.
      renameSync(outFile, referenceFile(t.serverId));
      rmSync(latestFile(t.serverId), { force: true });
    } else {
      // Damaged: keep the reference as it was (so later checks keep reporting this), remember this census so the
      // owner can accept it.
      renameSync(outFile, latestFile(t.serverId));
      // A world's very first check has nothing to compare with; only database damage can flag it.
      if (reference && !existsSync(referenceFile(t.serverId))) copyFileSync(latestFile(t.serverId), referenceFile(t.serverId));
    }
    run = { at: Date.now(), source: t.source, backupId: t.backupId, status: result.damaged ? 'damaged' : 'ok', reference, result, seconds: Math.round((Date.now() - started) / 1000) };
  } catch (err) {
    rmSync(outFile, { force: true });
    run = { at: Date.now(), source: t.source, backupId: t.backupId, status: 'failed', error: (err as Error).message, seconds: Math.round((Date.now() - started) / 1000) };
  }
  const state = readJson<State>(stateFile(t.serverId), {});
  state.last = run;
  writeJson(stateFile(t.serverId), state);
  if (t.backupId) setBackupCheck(t.serverId, t.backupId, { status: run.status, at: run.at, summary: summarize(run) });
  try {
    getInstance(t.serverId).log(`World check: ${summarize(run)}`);
  } catch {}
  events.emit('world-check', { serverId: t.serverId, phase: 'done', run });
}

/** One line describing a check's outcome. */
export function summarize(run: WorldCheckRun): string {
  if (run.status === 'failed') return `couldn't finish (${run.error}).`;
  const r = run.result!;
  if (run.status === 'ok') return run.reference ? `took the world's reference census (${r.chunks.toLocaleString()} chunks). Later checks compare with it.` : `no damage found (${r.chunks.toLocaleString()} chunks checked).`;
  const parts = [];
  if (r.gone) parts.push(`${r.gone.toLocaleString()} chunk${r.gone === 1 ? '' : 's'} gone`);
  if (r.regenerated) parts.push(`${r.regenerated.toLocaleString()} regenerated`);
  if (r.holes) parts.push(`${r.holes.toLocaleString()} missing block layers`);
  if (r.problemCount) parts.push(`${r.problemCount} damaged database block${r.problemCount === 1 ? '' : 's'}`);
  const where = r.areas[0] ? ` Biggest area: ${r.areas[0].dimension} around X ${r.areas[0].x}, Z ${r.areas[0].z}.` : '';
  return `DAMAGE FOUND: ${parts.join(', ')}.${where}`;
}

// ---------- sources of world copies ----------

function worldPaths(record: ServerRecord) {
  const src = getInstance(record.id).module.backup?.sources(record);
  if (!src?.world) throw new Error('This server has no world to check yet.');
  return { base: src.base, world: src.world, rel: path.join('worlds', src.world) };
}

// Every backup: check the unpacked copy it was zipped from (taken over from the backup, deleted after the check).
onBackupStaged(({ serverId, backupId, staging, world, record }) => {
  if (!worldCheckSupported(record) || !world) return false;
  const dbDir = path.join(staging, 'worlds', world, 'db');
  if (!existsSync(dbDir)) return false;
  enqueue({ serverId, folder: staging, dbDir, world, source: 'backup', backupId });
  return true;
});

/**
 * A copy of the world to check right now. While the server runs: the game's safe live-backup method. Stopped: the
 * database's table files are hard-linked (instant, and they never change once written) and the small files copied,
 * so the server can start again straight away.
 */
async function snapshot(target: BackupTarget): Promise<{ folder: string; dbDir: string; world: string }> {
  const { base, world, rel } = worldPaths(target.record);
  const folder = dataPath('world-checks', target.record.id, `snapshot-${randomUUID().slice(0, 8)}`);
  if (target.running) {
    await stageWorld(target, folder, { update() {} });
    return { folder, dbDir: path.join(folder, rel, 'db'), world };
  }
  const src = path.join(base, rel, 'db');
  const dbDir = path.join(folder, 'db');
  mkdirSync(dbDir, { recursive: true });
  for (const f of readdirSync(src)) {
    const from = path.join(src, f);
    if (!statSync(from).isFile()) continue;
    if (f.endsWith('.ldb')) {
      try {
        linkSync(from, path.join(dbDir, f));
        continue;
      } catch {}
    }
    copyFileSync(from, path.join(dbDir, f));
  }
  return { folder, dbDir, world };
}

export async function checkNow(serverId: string, source: WorldCheckRun['source'] = 'manual') {
  const inst = getInstance(serverId);
  if (!worldCheckSupported(inst.record)) throw new Error(`World checks are for Bedrock worlds (not ${inst.module.name} yet).`);
  if (current?.serverId === serverId || queue.some((q) => q.serverId === serverId)) throw new Error('A check of this world is already running.');
  const snap = await snapshot(inst.backupTarget());
  enqueue({ serverId, folder: snap.folder, dbDir: snap.dbDir, world: snap.world, source });
}

// ---------- owner actions ----------

/** Accepts the world as it is now (e.g. chunks removed on purpose): the flagged census becomes the reference. */
export function acceptCurrent(serverId: string) {
  if (!existsSync(latestFile(serverId))) throw new Error('There is no flagged check to accept. Run a check first.');
  renameSync(latestFile(serverId), referenceFile(serverId));
  const state = readJson<State>(stateFile(serverId), {});
  state.acceptedAt = Date.now();
  if (state.last?.status === 'damaged') state.last = { ...state.last, status: 'ok', result: state.last.result && { ...state.last.result, damaged: false } };
  writeJson(stateFile(serverId), state);
  events.emit('world-check', { serverId, phase: 'accepted' });
}

/** Forgets the reference (the world was replaced, e.g. a backup restored); the next check takes a new one. */
export function forgetReference(serverId: string) {
  rmSync(referenceFile(serverId), { force: true });
  rmSync(latestFile(serverId), { force: true });
  const state = readJson<State>(stateFile(serverId), {});
  delete state.last;
  writeJson(stateFile(serverId), state);
  events.emit('world-check', { serverId, phase: 'reset' });
}

export function worldCheckInfo(serverId: string): WorldCheckInfo {
  const inst = getInstance(serverId);
  const state = readJson<State>(stateFile(serverId), {});
  const good = lastGoodBackup(serverId);
  let referenceAt: number | null = null;
  try {
    referenceAt = statSync(referenceFile(serverId)).mtimeMs;
  } catch {}
  return {
    supported: worldCheckSupported(inst.record),
    running: current?.serverId === serverId ? { done: current.done, total: current.total, source: current.source } : null,
    queued: queue.some((q) => q.serverId === serverId),
    last: state.last ?? null,
    referenceAt,
    lastGoodBackup: good ? { id: good.id, createdAt: good.createdAt } : null,
  };
}

// A restored backup replaces the world: compare later checks with a fresh reference.
events.on('world-replaced', (serverId: string) => forgetReference(serverId));
// A server that had to be forced closed may not have finished writing: check its world once it's down.
events.on('force-stopped', (serverId: string) => {
  const inst = listInstances().find((i) => i.id === serverId);
  if (!inst || !worldCheckSupported(inst.record)) return;
  setTimeout(() => checkNow(serverId, 'after-force-stop').catch(() => {}), 5_000);
});
events.on('removed', (serverId: string) => {
  rmSync(dir(serverId), { recursive: true, force: true });
});

/** Clears snapshot folders left behind if the panel closed mid-check. */
export function startWorldChecks() {
  try {
    for (const id of readdirSync(dataPath('world-checks'))) {
      for (const f of readdirSync(dataPath('world-checks', id))) if (f.startsWith('snapshot-') || f.endsWith('.tmp')) rmSync(dataPath('world-checks', id, f), { recursive: true, force: true });
    }
  } catch {}
}
