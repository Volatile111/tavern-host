// World tools for Minecraft servers: list the worlds in a server folder, switch which one the server loads, export one
// (.mcworld for Bedrock, .zip for Java), import one, and delete ones that aren't in use.
// Bedrock: worlds/<folder>/ (level.dat + db), the active one is server.properties level-name.
// Java: <server folder>/<world>/ (level.dat), plus <world>_nether / <world>_the_end on Paper/Spigot; level-name.
import { existsSync, readdirSync, readFileSync, statSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { updateServer, getInstance } from './instances.ts';

type ServerInstance = ReturnType<typeof getInstance>;
import { readProperties, writeProperties } from './properties.ts';
import { createBackup, extractBackup, deleteBackup, zipFolder, unzipTo } from './backups.ts';
import { recycle } from './files.ts';

export interface WorldInfo {
  folder: string;
  /** Bedrock: levelname.txt; Java: the folder name. */
  name: string;
  size: number;
  modified: number;
  active: boolean;
}

export const supportsWorlds = (inst: ServerInstance) => inst.record.game === 'bedrock' || inst.record.game === 'java';

const props = (inst: ServerInstance) => path.join(inst.record.installDir, 'server.properties');
const rootOf = (inst: ServerInstance) => (inst.record.game === 'bedrock' ? path.join(inst.record.installDir, 'worlds') : inst.record.installDir);

function activeWorld(inst: ServerInstance): string {
  return readProperties(props(inst)).values.get('level-name') || (inst.record.game === 'bedrock' ? 'Bedrock level' : 'world');
}

async function folderSize(dir: string): Promise<number> {
  let total = 0;
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += await folderSize(p);
    else if (e.isFile()) total += (await stat(p).catch(() => ({ size: 0 }))).size;
  }
  return total;
}

/** Java's Nether/End folders that belong to a world (Paper/Spigot keep them next to it). */
const javaExtras = (inst: ServerInstance, folder: string) =>
  [`${folder}_nether`, `${folder}_the_end`].filter((f) => existsSync(path.join(inst.record.installDir, f, 'level.dat')));

export async function listWorlds(inst: ServerInstance): Promise<{ active: string; worlds: WorldInfo[]; running: boolean }> {
  const root = rootOf(inst);
  const active = activeWorld(inst);
  const worlds: WorldInfo[] = [];
  if (existsSync(root)) {
    const dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(path.join(root, d.name, 'level.dat')));
    for (const d of dirs) {
      // Java: the Nether/End folders are part of their world, not worlds of their own.
      if (inst.record.game === 'java' && /_(nether|the_end)$/.test(d.name) && dirs.some((x) => x.name === d.name.replace(/_(nether|the_end)$/, ''))) continue;
      const dir = path.join(root, d.name);
      let name = d.name;
      if (inst.record.game === 'bedrock') {
        try {
          name = readFileSync(path.join(dir, 'levelname.txt'), 'utf-8').trim() || d.name;
        } catch {}
      }
      let size = await folderSize(dir);
      if (inst.record.game === 'java') for (const x of javaExtras(inst, d.name)) size += await folderSize(path.join(root, x));
      worlds.push({ folder: d.name, name, size, modified: statSync(path.join(dir, 'level.dat')).mtimeMs, active: d.name === active });
    }
  }
  worlds.sort((a, b) => Number(b.active) - Number(a.active) || b.modified - a.modified);
  return { active, worlds, running: inst.isRunning };
}

function checkFolder(inst: ServerInstance, folder: string) {
  const f = String(folder ?? '');
  if (!f || /[\\/]|^\.\.?$/.test(f)) throw new Error('Bad world name.');
  if (!existsSync(path.join(rootOf(inst), f, 'level.dat'))) throw new Error(`There's no world "${f}" in this server.`);
  return f;
}

/** Makes `folder` the world the server loads (applies at the next start). */
export function setActiveWorld(inst: ServerInstance, folder: string) {
  const f = checkFolder(inst, folder);
  writeProperties(props(inst), { 'level-name': f });
  // Bedrock keeps server.properties values in its settings too (written at every start); keep them in step.
  if (inst.record.settings['prop:level-name'] !== undefined) updateServer(inst.id, { settings: { 'prop:level-name': f } });
  return f;
}

/**
 * Packs a world for download; returns the file (in a temp folder the caller deletes). The active world of a running
 * server is taken with the game's safe live-backup method.
 */
export async function exportWorld(inst: ServerInstance, folder: string): Promise<{ file: string; name: string; tmp: string }> {
  const f = checkFolder(inst, folder);
  const tmp = path.join(os.tmpdir(), `tavernhost-export-${randomUUID().slice(0, 8)}`);
  const stage = path.join(tmp, 'stage');
  mkdirSync(stage, { recursive: true });
  const bedrock = inst.record.game === 'bedrock';
  const parts = bedrock ? [f] : [f, ...javaExtras(inst, f)];
  if (f === activeWorld(inst) && inst.isRunning && inst.module.backup) {
    // Live: a temporary backup (safe save hold / save-off), unpacked, then just the world taken from it.
    const job = { info: {} as never, update() {}, line() {} };
    const b = await createBackup(inst.backupTarget(), 'manual', job, { noCopy: true });
    const unpacked = path.join(tmp, 'backup');
    try {
      await extractBackup(inst.id, b.id, unpacked);
    } finally {
      deleteBackup(inst.id, b.id);
    }
    const from = bedrock ? path.join(unpacked, 'worlds') : unpacked;
    if (bedrock) cpSync(path.join(from, f), stage, { recursive: true });
    else for (const p of parts) if (existsSync(path.join(from, p))) cpSync(path.join(from, p), path.join(stage, p), { recursive: true });
  } else if (bedrock) {
    // .mcworld = the world folder's contents at the top of the zip.
    cpSync(path.join(rootOf(inst), f), stage, { recursive: true });
  } else {
    for (const p of parts) cpSync(path.join(rootOf(inst), p), path.join(stage, p), { recursive: true });
  }
  rmSync(path.join(stage, 'session.lock'), { force: true });
  for (const p of parts) rmSync(path.join(stage, p, 'session.lock'), { force: true });
  const safe = f.replace(/[^\w\- ]+/g, '_');
  const file = path.join(tmp, `${safe}.${bedrock ? 'mcworld' : 'zip'}`);
  await zipFolder(stage, file);
  return { file, name: path.basename(file), tmp };
}

/** Where level.dat sits inside an unpacked upload (the world's own folder). */
function findWorldRoots(dir: string, depth = 0): string[] {
  if (existsSync(path.join(dir, 'level.dat'))) return [dir];
  if (depth > 3) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) => findWorldRoots(path.join(dir, d.name), depth + 1));
}

/** Adds a world from an uploaded .mcworld/.zip. Returns the folder it went into (never overwrites a world). */
export async function importWorld(inst: ServerInstance, upload: string, wantedName: string, makeActive: boolean): Promise<string> {
  const tmp = path.join(os.tmpdir(), `tavernhost-import-${randomUUID().slice(0, 8)}`);
  try {
    try {
      await unzipTo(upload, tmp);
    } catch {
      throw new Error("That file couldn't be unzipped. Use a .mcworld (Bedrock) or a .zip of the world folder (Java).");
    }
    const roots = findWorldRoots(tmp);
    if (!roots.length) throw new Error('No world found in that file (no level.dat).');
    const bedrock = inst.record.game === 'bedrock';
    // Java: the main world is the one that isn't a _nether/_the_end folder.
    const main = bedrock ? roots[0] : (roots.find((r) => !/_(nether|the_end)$/.test(path.basename(r))) ?? roots[0]);
    if (bedrock && !existsSync(path.join(main, 'db'))) throw new Error("That doesn't look like a Bedrock world (no db folder). Is it a Java world?");
    if (!bedrock && existsSync(path.join(main, 'db'))) throw new Error("That looks like a Bedrock world, not a Java one.");
    let base = String(wantedName ?? '').trim();
    if (!base && bedrock) {
      try {
        base = readFileSync(path.join(main, 'levelname.txt'), 'utf-8').trim();
      } catch {}
    }
    base = (base || path.basename(upload).replace(/\.(mcworld|zip)$/i, '') || 'Imported world').replace(/[^\w\- ]+/g, '').trim().slice(0, 60) || 'Imported world';
    const root = rootOf(inst);
    mkdirSync(root, { recursive: true });
    let folder = base;
    for (let n = 2; existsSync(path.join(root, folder)); n++) folder = `${base} ${n}`;
    cpSync(main, path.join(root, folder), { recursive: true });
    if (!bedrock) {
      for (const suffix of ['_nether', '_the_end']) {
        const extra = roots.find((r) => path.basename(r) === `${path.basename(main)}${suffix}`);
        if (extra && !existsSync(path.join(root, `${folder}${suffix}`))) cpSync(extra, path.join(root, `${folder}${suffix}`), { recursive: true });
      }
    }
    if (makeActive) setActiveWorld(inst, folder);
    return folder;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Sends a world that isn't in use to the Recycle Bin. */
export async function deleteWorld(inst: ServerInstance, folder: string) {
  const f = checkFolder(inst, folder);
  if (f === activeWorld(inst)) throw new Error("That's the world this server loads. Switch to another world first.");
  await recycle(path.join(rootOf(inst), f));
  if (inst.record.game === 'java') for (const x of javaExtras(inst, f)) await recycle(path.join(rootOf(inst), x));
}
