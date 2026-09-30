// One difficulty selector for every server type (Settings → Difficulty).
//   Bedrock / Java: `difficulty` in server.properties; a running server also gets the `difficulty` command, so the
//     change is live straight away (and kept for the next start).
//   Valheim: a world preset (-preset) applied when the server starts.
import path from 'node:path';
import { getInstance, updateServer } from './instances.ts';
import { readProperties, writeProperties } from './properties.ts';
import { VALHEIM_PRESETS } from './games/valheim.ts';

export interface DifficultyInfo {
  supported: boolean;
  options: { value: string; label: string; help?: string }[];
  value: string | null;
  /** How a change takes effect: right away (running Minecraft server) or at the next start. */
  applies: 'now' | 'restart';
  note: string | null;
}

const MINECRAFT = [
  { value: 'peaceful', label: 'Peaceful', help: 'No hostile mobs; health and hunger refill.' },
  { value: 'easy', label: 'Easy', help: 'Hostile mobs do less damage.' },
  { value: 'normal', label: 'Normal', help: 'The standard game.' },
  { value: 'hard', label: 'Hard', help: 'Hostile mobs do more damage; hunger can kill.' },
];
const NUMBERED = ['peaceful', 'easy', 'normal', 'hard'];

const propsFile = (installDir: string) => path.join(installDir, 'server.properties');

export function difficultyInfo(serverId: string): DifficultyInfo {
  const inst = getInstance(serverId);
  const game = inst.record.game;
  if (game === 'bedrock' || game === 'java') {
    const raw = (readProperties(propsFile(inst.record.installDir)).values.get('difficulty') ?? 'easy').trim().toLowerCase();
    const value = /^\d$/.test(raw) ? (NUMBERED[Number(raw)] ?? raw) : raw;
    const hardcore = game === 'java' && readProperties(propsFile(inst.record.installDir)).values.get('hardcore') === 'true';
    return {
      supported: true,
      options: MINECRAFT,
      value,
      applies: inst.isRunning && inst.module.commands ? 'now' : 'restart',
      note: hardcore ? 'This is a hardcore world: Minecraft keeps it on Hard whatever is chosen here.' : null,
    };
  }
  if (game === 'valheim') {
    return {
      supported: true,
      options: VALHEIM_PRESETS,
      value: String(inst.record.settings.preset ?? 'keep'),
      applies: 'restart',
      note: 'Valheim applies the preset when the server starts. It changes the world\'s modifiers; choose Normal (not "Keep") to go back to the standard game.',
    };
  }
  return { supported: false, options: [], value: null, applies: 'restart', note: null };
}

export async function setDifficulty(serverId: string, value: string): Promise<DifficultyInfo> {
  const inst = getInstance(serverId);
  const info = difficultyInfo(serverId);
  if (!info.supported) throw new Error(`${inst.module.name} servers don't have a difficulty setting here.`);
  if (!info.options.some((o) => o.value === value)) throw new Error('Unknown difficulty.');
  if (inst.record.game === 'valheim') {
    updateServer(serverId, { settings: { ...inst.record.settings, preset: value } });
  } else {
    writeProperties(propsFile(inst.record.installDir), { difficulty: value });
    if (inst.isRunning && inst.module.commands) await inst.sendCommand(`difficulty ${value}`);
  }
  inst.log(`Difficulty set to ${info.options.find((o) => o.value === value)!.label}${info.applies === 'now' ? ' (live now)' : ' (from the next start)'}.`);
  return difficultyInfo(serverId);
}
