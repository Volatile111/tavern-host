// CurseForge API client (https://docs.curseforge.com). Needs the owner's own API key (free, from
// console.curseforge.com), stored in data/integrations.json. Authors can disable third-party downloads; for those the
// API returns no download URL and we send the user to the project page instead.
import { readJson, writeJson } from './store.ts';

const API = 'https://api.curseforge.com/v1';
const FILE = 'integrations.json';

interface Integrations {
  curseforgeKey?: string;
}

export function curseforgeKey(): string | null {
  return readJson<Integrations>(FILE, {}).curseforgeKey || null;
}

export async function setCurseforgeKey(key: string | null) {
  // Pasted keys often pick up quotes, spaces, line breaks or zero-width characters.
  const clean = String(key ?? '')
    .replace(/[\s​-‍﻿"'`]/g, '')
    .replace(/^x-api-key:/i, '');
  if (clean) {
    // Check the key works before saving it.
    const res = await fetch(`${API}/games?pageSize=1`, { headers: { 'x-api-key': clean, Accept: 'application/json' } });
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `CurseForge rejected that API key (HTTP ${res.status}). Copy the key again from console.curseforge.com → API keys (it starts with "$2a$10$") and check the key is active there.`,
      );
    }
    if (!res.ok) throw new Error(`Couldn't check the key with CurseForge (HTTP ${res.status}).`);
  }
  writeJson(FILE, { ...readJson<Integrations>(FILE, {}), curseforgeKey: clean || undefined });
}

async function cf<T>(path: string): Promise<T> {
  const key = curseforgeKey();
  if (!key) throw Object.assign(new Error('Add a CurseForge API key in Settings → Integrations to browse CurseForge.'), { status: 400 });
  const res = await fetch(`${API}${path}`, { headers: { 'x-api-key': key, Accept: 'application/json' } });
  if (res.status === 403 || res.status === 401) throw new Error('CurseForge refused the request; check the API key in Settings.');
  if (!res.ok) throw new Error(`CurseForge error (HTTP ${res.status}).`);
  return ((await res.json()) as { data: T }).data;
}

const gameIds = new Map<string, number>();

/** CurseForge's numeric id for a game slug, e.g. "minecraft-bedrock" (looked up once, then cached). */
async function gameId(slug: string): Promise<number> {
  if (gameIds.has(slug)) return gameIds.get(slug)!;
  const games = await cf<{ id: number; slug: string; name: string }[]>('/games?pageSize=50');
  const game = games.find((g) => g.slug === slug) ?? games.find((g) => g.name.toLowerCase().replace(/\s+/g, '-') === slug);
  if (!game) throw new Error(`CurseForge doesn't list "${slug}".`);
  gameIds.set(slug, game.id);
  return game.id;
}

export interface CfProject {
  id: number;
  name: string;
  summary: string;
  downloads: number;
  thumbnail: string | null;
  url: string | null;
  author: string | null;
  updated: string | null;
  categories: string[];
}

interface RawMod {
  id: number;
  name: string;
  summary: string;
  downloadCount: number;
  logo?: { thumbnailUrl?: string };
  links?: { websiteUrl?: string };
  authors?: { name: string }[];
  dateModified?: string;
  categories?: { name: string }[];
  allowModDistribution?: boolean | null;
  latestFiles?: RawFile[];
}
interface RawFile {
  id: number;
  displayName: string;
  fileName: string;
  downloadUrl: string | null;
  fileDate: string;
  gameVersions?: string[];
}

function toProject(m: RawMod): CfProject {
  return {
    id: m.id,
    name: m.name,
    summary: m.summary,
    downloads: m.downloadCount,
    thumbnail: m.logo?.thumbnailUrl ?? null,
    url: m.links?.websiteUrl ?? null,
    author: m.authors?.[0]?.name ?? null,
    updated: m.dateModified ?? null,
    categories: (m.categories ?? []).map((c) => c.name),
  };
}

/** Searches a game's projects, most popular first. */
export async function searchProjects(slug: string, query: string, page = 0): Promise<{ results: CfProject[]; total: number }> {
  const id = await gameId(slug);
  const params = new URLSearchParams({ gameId: String(id), searchFilter: query, index: String(page * 20), pageSize: '20', sortField: '2', sortOrder: 'desc' });
  const key = curseforgeKey()!;
  const res = await fetch(`${API}/mods/search?${params}`, { headers: { 'x-api-key': key, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`CurseForge search failed (HTTP ${res.status}).`);
  const body = (await res.json()) as { data: RawMod[]; pagination?: { totalCount: number } };
  return { results: body.data.map(toProject), total: body.pagination?.totalCount ?? body.data.length };
}

/** The newest file of a project and where to download it (null download = author disabled third-party downloads). */
export async function latestFile(modId: number): Promise<{ name: string; fileName: string; downloadUrl: string | null; projectUrl: string | null }> {
  const mod = await cf<RawMod>(`/mods/${modId}`);
  const files = await cf<RawFile[]>(`/mods/${modId}/files?pageSize=20`);
  const newest = [...files].sort((a, b) => b.fileDate.localeCompare(a.fileDate))[0];
  if (!newest) throw new Error('That project has no files to download.');
  return { name: mod.name, fileName: newest.fileName, downloadUrl: mod.allowModDistribution === false ? null : newest.downloadUrl, projectUrl: mod.links?.websiteUrl ?? null };
}
