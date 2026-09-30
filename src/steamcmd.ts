// SteamCMD: Valve's official command-line tool for installing and updating dedicated servers (anonymously, no Steam
// account needed). Tavern Host downloads it into its own data folder the first time a Steam game server needs it.
import { existsSync, mkdirSync, rmSync, readdirSync, statSync, readFileSync, type Dirent } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { dataPath } from './store.ts';
import { downloadFile, extractZip, formatBytes } from './download.ts';
import type { Job } from './jobs.ts';

const STEAMCMD_URL = 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip';
const STATES: Record<string, string> = {
  '0x3': 'Preparing',
  '0x5': 'Checking files',
  '0x11': 'Allocating disk space',
  '0x61': 'Downloading',
  '0x81': 'Finishing up',
};

function steamCmdDir() {
  return dataPath('tools', 'steamcmd');
}

function steamCmdExe() {
  return path.join(steamCmdDir(), 'steamcmd.exe');
}

async function ensureSteamCmd(job: Job): Promise<string> {
  if (existsSync(steamCmdExe())) return steamCmdExe();
  mkdirSync(steamCmdDir(), { recursive: true });
  const zip = path.join(steamCmdDir(), 'steamcmd.zip');
  job.update("Downloading SteamCMD (Valve's server installer)…", null);
  await downloadFile(STEAMCMD_URL, zip);
  await extractZip(zip, steamCmdDir());
  rmSync(zip, { force: true });
  job.line('SteamCMD downloaded.');
  return steamCmdExe();
}

function runSteamCmd(args: string[], appId: number, job: Job): Promise<{ success: boolean; error: string | null }> {
  return new Promise((resolve) => {
    const proc = spawn(steamCmdExe(), args, { cwd: steamCmdDir(), windowsHide: true });
    let success = false;
    let error: string | null = null;
    let buffer = '';
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf-8');
      const lines = buffer.split(/\r\n|\n|\r/);
      buffer = lines.pop() ?? '';
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        const progress = /Update state \((0x[0-9a-f]+)\) [\w ]+, progress: ([\d.]+)/i.exec(line);
        if (progress) {
          job.update(`${STATES[progress[1]] ?? 'Working'}…`, Math.min(100, Number(progress[2])));
          continue; // too noisy for the console
        }
        job.line(line);
        if (/Checking for available updates|Downloading update/i.test(line)) job.update('Updating SteamCMD itself…', null);
        if (new RegExp(`Success! App '${appId}' (fully installed|already up to date)`, 'i').test(line)) success = true;
        const err = /^(ERROR!|Error!|FAILED)\s*(.*)$/i.exec(line);
        if (err) error = err[2] || line;
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', (err) => resolve({ success: false, error: err.message }));
    proc.on('close', (code) => resolve({ success, error: error ?? (success ? null : `SteamCMD exited with code ${code}`) }));
  });
}

/** Total size of a folder (best effort; unreadable entries are skipped). */
function folderSize(dir: string): number {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(current, e.name);
      if (e.isDirectory()) stack.push(full);
      else {
        try {
          total += statSync(full).size;
        } catch {}
      }
    }
  }
  return total;
}

/** The Steam build installed in `installDir` (from SteamCMD's app manifest), or null. */
export function installedBuild(appId: number, installDir: string): string | null {
  try {
    const acf = readFileSync(path.join(installDir, 'steamapps', `appmanifest_${appId}.acf`), 'utf-8');
    return /"buildid"\s+"(\d+)"/.exec(acf)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * The newest public Steam build of an app, asked from Steam through SteamCMD (anonymous login). `updated` is when that
 * build went live (ms).
 */
export async function latestBuild(appId: number): Promise<{ build: string; updated: number | null }> {
  const quiet = { update() {}, line() {} } as unknown as Job;
  await ensureSteamCmd(quiet);
  const run = () =>
    new Promise<string>((resolve, reject) => {
      const proc = spawn(steamCmdExe(), ['+login', 'anonymous', '+app_info_update', '1', '+app_info_print', String(appId), '+quit'], { cwd: steamCmdDir(), windowsHide: true });
      let out = '';
      const timer = setTimeout(() => proc.kill(), 120_000);
      proc.stdout.on('data', (d) => (out += d.toString('utf-8')));
      proc.stderr.on('data', (d) => (out += d.toString('utf-8')));
      proc.on('error', (err) => (clearTimeout(timer), reject(err)));
      proc.on('close', () => (clearTimeout(timer), resolve(out)));
    });
  // The "public" branch inside the app's "branches" block.
  const parse = (out: string) => {
    const m = /"branches"\s*\{\s*"public"\s*\{([^}]*)\}/.exec(out);
    const build = m && /"buildid"\s+"(\d+)"/.exec(m[1])?.[1];
    const updated = m && /"timeupdated"\s+"(\d+)"/.exec(m[1])?.[1];
    return build ? { build, updated: updated ? Number(updated) * 1000 : null } : null;
  };
  // SteamCMD sometimes prints stale or no app info on a run where it updated itself first; one retry covers that.
  const found = parse(await run()) ?? parse(await run());
  if (!found) throw new Error("Steam didn't say which version is current (SteamCMD gave no app info). Try again in a minute.");
  return found;
}

/** Installs or updates a Steam dedicated server into `installDir` (validating files). */
export async function steamAppUpdate(appId: number, installDir: string, job: Job): Promise<void> {
  await ensureSteamCmd(job);
  mkdirSync(installDir, { recursive: true });
  // force_install_dir must come before login.
  const args = ['+force_install_dir', installDir, '+login', 'anonymous', '+app_update', String(appId), 'validate', '+quit'];
  job.update('Connecting to Steam…', null);

  // SteamCMD holds back its progress output when it isn't writing to a real console, so show how much has
  // arrived in the folder instead.
  const startSize = folderSize(installDir);
  const watcher = setInterval(() => {
    const grown = folderSize(installDir) - startSize;
    if (grown > 1024 * 1024) job.update(`Downloading from Steam… ${formatBytes(grown)} so far`, null);
  }, 2000);
  try {
    let result = await runSteamCmd(args, appId, job);
    if (!result.success) {
      // On its very first run SteamCMD updates itself and sometimes exits before doing the job; one retry covers that.
      job.line('Retrying once…');
      result = await runSteamCmd(args, appId, job);
    }
    if (!result.success) throw new Error(result.error ?? 'SteamCMD did not finish the install.');
  } finally {
    clearInterval(watcher);
  }
}
