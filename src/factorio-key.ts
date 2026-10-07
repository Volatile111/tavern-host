// The owner's factorio.com login (Settings → Integrations): username + auth token, kept with the other integration keys
// in data/integrations.json. Factorio has no anonymous Windows server download (the Windows server is the full game), so
// installing and updating a Factorio server, and downloading mods from the mod portal, need an account that owns the game.
// The token is the one on factorio.com/profile, or the one the game saved in %APPDATA%\Factorio\player-data.json
// ("Import from this PC"). Before it's saved it's checked against factorio.com, which also tells whether the account
// owns Space Age.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readJson, writeJson } from './store.ts';

const FILE = 'integrations.json';
const UA = { 'User-Agent': 'TavernHost' };

export interface FactorioLogin {
  username: string;
  token: string;
  /** The account owns Space Age (can download the expansion build). */
  spaceAge: boolean;
}

interface Integrations {
  factorio?: FactorioLogin;
}

export function factorioLogin(): FactorioLogin | null {
  const f = readJson<Integrations>(FILE, {}).factorio;
  return f?.username && f.token ? f : null;
}

/** What the page may see: never the token. */
export function factorioStatus() {
  const f = factorioLogin();
  return { linked: !!f, username: f?.username ?? null, spaceAge: f?.spaceAge ?? false, canImport: !!playerDataFile() };
}

/** The current stable versions (public, no login needed). */
export async function latestReleases(): Promise<{ stable: Record<string, string>; experimental: Record<string, string> }> {
  const res = await fetch('https://factorio.com/api/latest-releases', { headers: UA, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`factorio.com answered ${res.status}.`);
  return res.json();
}

/** Can this login download that build? (factorio.com answers 403 to a wrong login or a build the account doesn't own.) */
async function canDownload(username: string, token: string, version: string, build: 'alpha' | 'expansion'): Promise<boolean> {
  const url = `https://www.factorio.com/get-download/${version}/${build}/win64-manual?username=${encodeURIComponent(username)}&token=${encodeURIComponent(token)}`;
  const res = await fetch(url, { redirect: 'manual', headers: UA, signal: AbortSignal.timeout(20_000) });
  res.body?.cancel().catch(() => {});
  const to = res.headers.get('location') ?? '';
  return (res.status >= 300 && res.status < 400 && !/\/login/.test(to)) || res.status === 200;
}

export async function setFactorioLogin(username: string | null, token: string | null): Promise<FactorioLogin | null> {
  const u = String(username ?? '').trim();
  const t = String(token ?? '').replace(/\s/g, '');
  const all = readJson<Integrations & Record<string, unknown>>(FILE, {});
  if (!u && !t) {
    delete all.factorio;
    writeJson(FILE, all);
    return null;
  }
  if (!/^[\w.-]{1,60}$/.test(u)) throw new Error('That doesn\'t look like a factorio.com username.');
  if (!/^[0-9a-f]{20,64}$/i.test(t)) throw new Error('That doesn\'t look like a factorio.com token (on factorio.com/profile, or in player-data.json).');
  const { stable } = await latestReleases();
  if (!(await canDownload(u, t, stable.alpha, 'alpha'))) {
    throw new Error("factorio.com didn't accept that username and token (or the account doesn't own Factorio). Check them on factorio.com/profile.");
  }
  const login: FactorioLogin = { username: u, token: t, spaceAge: await canDownload(u, t, stable.expansion, 'expansion').catch(() => false) };
  writeJson(FILE, { ...all, factorio: login });
  return login;
}

/** Where the game keeps the logged-in player's details on this PC (for "Import from this PC"). */
function playerDataFile(): string | null {
  const f = path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'Factorio', 'player-data.json');
  return existsSync(f) ? f : null;
}

/** Reads the username and token the game saved on this PC, checks them and saves them. */
export async function importFactorioLogin(): Promise<FactorioLogin | null> {
  const f = playerDataFile();
  if (!f) throw new Error("Factorio hasn't been run on this PC with a logged-in account (no player-data.json), so there's nothing to import.");
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(readFileSync(f, 'utf-8'));
  } catch {
    throw new Error("Factorio's player-data.json couldn't be read.");
  }
  const username = String(data['service-username'] ?? '');
  const token = String(data['service-token'] ?? '');
  if (!username || !token) throw new Error('player-data.json has no factorio.com login in it (log in to the game once, then try again).');
  return setFactorioLogin(username, token);
}
