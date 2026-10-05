// Addon updates for Bedrock servers, from CurseForge. Each pack can be linked to its CurseForge project (automatically
// when installed from CurseForge, or by hand for packs from MCPEDL or elsewhere); a link remembers the date of the
// installed file, and any newer file on the server's channel (release, or betas / alphas too when they're newer than
// the newest release) is an update. Optionally installed by themselves every few hours.
import { mkdirSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { newestFile, RELEASE_TYPE_NAME, type CfFile } from '../curseforge.ts';
import { downloadFile } from '../download.ts';
import { getUpdateSettings, installAddonFile, linkPacks, linkedProjects, listPacks, type InstallResult } from './bedrock-addons.ts';

export interface PackUpdate {
  projectId: number;
  name: string;
  file: CfFile;
  /** null = the author only allows downloads from the CurseForge website. */
  canDownload: boolean;
  url: string | null;
}

/** Newer files for every linked project: { "<packId>": "Name 1.2 (beta)" } for the page, plus the details. */
export async function checkPackUpdates(installDir: string, level: string): Promise<{ labels: Record<string, string>; updates: PackUpdate[] }> {
  const { channel } = getUpdateSettings(installDir);
  const packs = listPacks(installDir, level);
  const labels: Record<string, string> = {};
  const updates: PackUpdate[] = [];
  for (const { link, uuids } of linkedProjects(installDir)) {
    const latest = await newestFile(link.projectId, channel);
    if (!latest.file || latest.file.fileDate <= link.fileDate || latest.file.id === link.fileId) continue;
    const type = latest.file.releaseType === 1 ? '' : ` (${RELEASE_TYPE_NAME[latest.file.releaseType]})`;
    updates.push({ projectId: link.projectId, name: latest.name, file: latest.file, canDownload: !!latest.file.downloadUrl, url: latest.url });
    for (const p of packs) if (uuids.includes(p.uuid)) labels[p.id] = `${latest.file.displayName}${type}`;
  }
  return { labels, updates };
}

/** Downloads and installs the newest file of a project; its packs stay linked, now to the new file. */
export async function installPackUpdate(installDir: string, level: string, projectId: number): Promise<InstallResult> {
  const { channel } = getUpdateSettings(installDir);
  const latest = await newestFile(projectId, channel);
  if (!latest.file) throw new Error(`${latest.name} has no files on CurseForge.`);
  if (!latest.file.downloadUrl) {
    throw Object.assign(new Error(`The author of "${latest.name}" only allows downloads from the CurseForge website. Download it there and add the file here.`), { url: latest.url });
  }
  const dir = path.join(os.tmpdir(), `tavernhost-cfupdate-${randomBytes(6).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  try {
    const local = path.join(dir, path.basename(latest.file.fileName).replace(/[^\w.\- ]/g, '_'));
    await downloadFile(latest.file.downloadUrl, local);
    const result = await installAddonFile(installDir, level, local, `CurseForge: ${latest.name}`);
    const old = linkedProjects(installDir).find((g) => g.link.projectId === projectId)?.uuids ?? [];
    linkPacks(installDir, [...new Set([...old, ...(result.uuids ?? [])])], { projectId, name: latest.name, url: latest.url, fileId: latest.file.id, fileDate: latest.file.fileDate });
    return result;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
