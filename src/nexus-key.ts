// Tavern Host's Nexus Mods API key (Settings → Integrations), kept with the other integration keys in
// data/integrations.json. Checked with Nexus Mods before it's saved.
import { readJson, writeJson } from './store.ts';
import { validateKey, type NexusUser } from './nexus.ts';

const FILE = 'integrations.json';
export const NEXUS_APP = { name: 'Tavern Host', version: '1' };

interface Integrations {
  nexusKey?: string;
  nexusUser?: NexusUser;
}

export function nexusKey(): string | null {
  return readJson<Integrations>(FILE, {}).nexusKey || null;
}

export function nexusUser(): NexusUser | null {
  const i = readJson<Integrations>(FILE, {});
  return i.nexusKey ? (i.nexusUser ?? { name: 'linked', premium: false }) : null;
}

export async function setNexusKey(key: string | null): Promise<NexusUser | null> {
  const clean = String(key ?? '').replace(/[\s​-‍﻿"'`]/g, '');
  const user = clean ? await validateKey(clean, NEXUS_APP) : null;
  writeJson(FILE, { ...readJson<Integrations>(FILE, {}), nexusKey: clean || undefined, nexusUser: user ?? undefined });
  return user;
}
