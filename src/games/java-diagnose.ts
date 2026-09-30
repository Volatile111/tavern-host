// Crash checker for Java servers: reads the console log, Minecraft's crash-reports/ and Java's hs_err_pid*.log, spots
// known causes and explains them in plain words, naming the mod/plugin and suggesting a fix (with a one-click action
// where Tavern Host can do it, e.g. switching a mod off).
import { existsSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import path from 'node:path';
import type { ServerRecord } from './types.ts';
import { listContent, readJar, contentKind } from './java-content.ts';

export interface Finding {
  severity: 'error' | 'warn' | 'info';
  title: string;
  /** What happened, in plain words. */
  detail: string;
  /** What to do about it. */
  fix: string;
  /** Log lines that show it. */
  evidence: string[];
  /** One-click fixes the UI can offer. */
  actions: ({ type: 'disable-content'; id: string; label: string } | { type: 'set-java'; version: number; label: string } | { type: 'open-tab'; tab: string; label: string } | { type: 'accept-eula'; label: string })[];
}

export interface Diagnosis {
  at: number;
  /** Where it looked. */
  sources: string[];
  findings: Finding[];
  /** The crash report's own one-line description, if there is one. */
  description: string | null;
}

/** Last `bytes` of a text file. */
function tail(file: string, bytes = 400_000): string {
  const size = statSync(file).size;
  const fd = openSync(file, 'r');
  try {
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf-8');
  } finally {
    closeSync(fd);
  }
}

/** Newest file in a folder matching a pattern, changed after `since`. */
function newest(dir: string, pattern: RegExp, since: number): string | null {
  if (!existsSync(dir)) return null;
  let best: { f: string; t: number } | null = null;
  for (const f of readdirSync(dir)) {
    if (!pattern.test(f)) continue;
    const t = statSync(path.join(dir, f)).mtimeMs;
    if (t >= since && (!best || t > best.t)) best = { f: path.join(dir, f), t };
  }
  return best?.f ?? null;
}

// Class file version -> Java version ("class file version 65.0" means Java 21).
const CLASS_TO_JAVA: Record<number, number> = { 52: 8, 53: 9, 54: 10, 55: 11, 56: 12, 57: 13, 58: 14, 59: 15, 60: 16, 61: 17, 62: 18, 63: 19, 64: 20, 65: 21, 66: 22, 67: 23, 68: 24, 69: 25 };
const OFFERED_JAVA = [8, 11, 17, 21, 25];

/** Installed mods/plugins by id (mod id or plugin name, lower case) and by file name. */
function contentIndex(record: ServerRecord) {
  const byId = new Map<string, { id: string; name: string }>();
  if (!contentKind(record)) return byId;
  const dir = path.join(record.installDir, contentKind(record)!);
  for (const item of listContent(record)) {
    byId.set(item.id.toLowerCase(), { id: item.id, name: item.name });
    byId.set(item.name.toLowerCase(), { id: item.id, name: item.name });
    try {
      byId.set(readJar(path.join(dir, item.file)).id.toLowerCase(), { id: item.id, name: item.name });
    } catch {}
  }
  return byId;
}

export function diagnoseJava(record: ServerRecord, panelLog: string, since: number): Diagnosis {
  const sources: string[] = [];
  const texts: string[] = [];
  const add = (label: string, file: string | null) => {
    if (!file || !existsSync(file)) return;
    sources.push(label);
    texts.push(tail(file));
  };
  add('console', panelLog);
  add('logs/latest.log', path.join(record.installDir, 'logs', 'latest.log'));
  const crashReport = newest(path.join(record.installDir, 'crash-reports'), /^crash-.*\.txt$/i, since);
  add(crashReport ? `crash-reports/${path.basename(crashReport)}` : '', crashReport);
  const hsErr = newest(record.installDir, /^hs_err_pid\d+\.log$/i, since);
  add(hsErr ? path.basename(hsErr) : '', hsErr);

  const all = texts.join('\n');
  const lines = [...new Set(all.split(/\r?\n/))];
  const findings: Finding[] = [];
  const seen = new Set<string>();
  const push = (key: string, f: Finding) => {
    if (seen.has(key)) return;
    seen.add(key);
    findings.push(f);
  };
  const grep = (re: RegExp, max = 4) => lines.filter((l) => re.test(l)).slice(0, max).map((l) => l.trim().slice(0, 400));
  const mods = contentIndex(record);
  const modAction = (idOrName: string) => {
    const hit = mods.get(idOrName.toLowerCase());
    return hit ? [{ type: 'disable-content' as const, id: hit.id, label: `Switch off ${hit.name}` }] : [];
  };
  const kind = contentKind(record);
  const noun = kind === 'plugins' ? 'plugin' : 'mod';
  let m: RegExpExecArray | null;

  // ---------- Java ----------
  if ((m = /class file version (\d+)\.\d+\), this version of the Java Runtime only recognizes class file versions up to (\d+)/.exec(all))) {
    const need = CLASS_TO_JAVA[Number(m[1])] ?? Number(m[1]) - 44;
    const have = CLASS_TO_JAVA[Number(m[2])] ?? Number(m[2]) - 44;
    const offer = OFFERED_JAVA.find((v) => v >= need);
    push('java-version', {
      severity: 'error',
      title: `Needs Java ${need}, but the server runs Java ${have}`,
      detail: 'Something (the server itself or a mod/plugin) was built for a newer Java than the one this server starts with.',
      fix: offer ? `Change "Java version" in Settings to Java ${offer} (Tavern Host downloads it), then start again.` : `Use a newer Java version in Settings.`,
      evidence: grep(/UnsupportedClassVersionError|class file version/),
      actions: offer ? [{ type: 'set-java', version: offer, label: `Use Java ${offer}` }] : [],
    });
  }
  if (/java\.lang\.OutOfMemoryError/.test(all)) {
    const gc = /GC overhead limit exceeded/.test(all);
    push('oom', {
      severity: 'error',
      title: 'Ran out of memory',
      detail: `Java hit its memory limit (${Number(record.settings.memoryMb) || 4096} MB)${gc ? ' and spent all its time cleaning up memory' : ''}. Large modpacks, many players or big pre-generated worlds need more.`,
      fix: 'Raise "Memory (MB)" in Settings (e.g. 6144-10240 for modpacks), then restart. Make sure this system has that much free RAM.',
      evidence: grep(/OutOfMemoryError/),
      actions: [{ type: 'open-tab', tab: 'settings', label: 'Open Settings' }],
    });
  }
  if (/EXCEPTION_ACCESS_VIOLATION|A fatal error has been detected by the Java Runtime Environment/.test(all)) {
    const frame = /Problematic frame:\s*\n#\s*(.+)/.exec(all)?.[1];
    push('jvm-crash', {
      severity: 'error',
      title: 'Java itself crashed',
      detail: `The Java runtime crashed (not a normal Minecraft error)${frame ? `, in ${frame.trim()}` : ''}. This is usually a mod with native code, a bad Java build, or failing hardware/drivers.`,
      fix: 'Try another Java version in Settings. If it keeps happening, remove recently added performance mods (native code), and check the system\'s RAM.',
      evidence: grep(/Problematic frame|EXCEPTION_ACCESS_VIOLATION|fatal error has been detected/),
      actions: [],
    });
  }

  // ---------- server basics ----------
  if (/FAILED TO BIND TO PORT|Address already in use|BindException/i.test(all)) {
    const port = /Perhaps a server is already running on that port|port.*?(\d{2,5})/i.exec(grep(/FAILED TO BIND|Address already in use/)[0] ?? '')?.[1];
    push('port', {
      severity: 'error',
      title: 'The port is already in use',
      detail: `Another program (often a second copy of this server, or another server) is already using the port${port ? ` ${port}` : ''}.`,
      fix: 'Stop the other server, or give this one its own "server-port" in Properties. Each server on this system needs a different port.',
      evidence: grep(/FAILED TO BIND|Address already in use|BindException/),
      actions: [{ type: 'open-tab', tab: 'properties', label: 'Open Properties' }],
    });
  }
  if (/You need to agree to the EULA/i.test(all)) {
    push('eula', {
      severity: 'error',
      title: "The Minecraft EULA hasn't been accepted",
      detail: 'Minecraft servers only start after the EULA is accepted in eula.txt.',
      fix: 'Accept it here (sets eula=true), then start again.',
      evidence: grep(/EULA/i),
      actions: [{ type: 'accept-eula', label: 'Accept the EULA' }],
    });
  }
  if (/A single server tick took [\d.]+ seconds|ServerHangWatchdog|Considering it to be crashed, server will forcibly shutdown/.test(all)) {
    push('watchdog', {
      severity: 'error',
      title: 'The server froze and the watchdog shut it down',
      detail: 'One game tick took over a minute, so Minecraft assumed it was stuck and stopped it. The crash report\'s stack trace usually shows which mod/plugin was busy.',
      fix: 'Look at the suspected mod below (if any). As a workaround, set "max-tick-time" to -1 in Properties (the server then never self-stops, but can hang).',
      evidence: grep(/single server tick took|Watchdog|forcibly shutdown/),
      actions: [{ type: 'open-tab', tab: 'properties', label: 'Open Properties' }],
    });
  }
  if (/Failed to load level|Exception reading .*level\.dat|Chunk file at .* is (in the wrong location|corrupt)|Couldn't load chunk|RegionFileVersion|Failed to read chunk/i.test(all)) {
    push('world', {
      severity: 'warn',
      title: 'World data looks damaged',
      detail: 'The server had trouble reading the world (level.dat or chunk files). This can follow a crash or a hard shutdown.',
      fix: 'Restore a recent backup from the Backups tab. A few "chunk" warnings on their own are usually harmless.',
      evidence: grep(/level\.dat|Chunk file|load chunk|read chunk|Failed to load level/i),
      actions: [{ type: 'open-tab', tab: 'backups', label: 'Open Backups' }],
    });
  }

  // ---------- Fabric ----------
  if (/Incompatible mods? found!|Mod resolution failed|Incompatible mod set!/.test(all)) {
    // "- Mod 'Sodium' (sodium) 0.5.8 requires version 0.15.x of 'Fabric Loader' (fabricloader), but only the wrong version is present: 0.14.21!"
    // The "- Mod '…' requires …" lines name the mods; Fabric's suggested-solution lines ("- Install fabric-api") repeat them.
    const reqs = lines.filter((l) => /requires (any )?version|is incompatible with|which is missing/.test(l));
    for (const l of reqs.slice(0, 8)) {
      const who = /Mod '([^']+)' \(([^)]+)\)/.exec(l);
      const missing = /which is missing!?|is missing/.test(l);
      push(`fabric:${l}`, {
        severity: 'error',
        title: who ? `${who[1]} can't load` : 'A mod can\'t load',
        detail: l.trim().replace(/^- /, ''),
        fix: missing
          ? 'Install the missing mod (Mods tab → Modrinth/CurseForge), or remove the mod that needs it.'
          : 'Install the right version of the mod it needs, or remove/switch off the mod that complains.',
        evidence: [l.trim()],
        actions: who ? modAction(who[2]) : [],
      });
    }
    if (!reqs.length) {
      push('fabric-generic', { severity: 'error', title: 'Fabric could not load the mods', detail: 'Fabric Loader refused the set of mods.', fix: 'See the lines below for which mods conflict.', evidence: grep(/Incompatible|requires|conflict/i, 8), actions: [] });
    }
  }
  if ((m = /Found (\d+ )?duplicate mods?|Duplicate mods? found|DuplicateModsFoundException/i.exec(all))) {
    push('duplicate', {
      severity: 'error',
      title: 'The same mod is installed twice',
      detail: 'Two jar files contain the same mod (often an old and a new version side by side).',
      fix: 'Remove the older copy from the Mods tab.',
      evidence: grep(/duplicate/i, 6),
      actions: [{ type: 'open-tab', tab: 'addons', label: `Open ${noun === 'mod' ? 'Mods' : 'Plugins'}` }],
    });
  }

  // ---------- Forge / NeoForge ----------
  // "Mod ID: 'create', Requested by: 'createaddition', Expected range: '[0.5.1,)', Actual version: '[MISSING]'"
  for (const l of lines) {
    const dep = /Mod ID: '([^']+)', Requested by: '([^']+)', Expected range: '([^']*)', Actual version: '([^']*)'/.exec(l);
    if (!dep) continue;
    const missing = /MISSING/i.test(dep[4]);
    push(`forge-dep:${dep[1]}:${dep[2]}`, {
      severity: 'error',
      title: missing ? `${dep[2]} needs ${dep[1]}, which isn't installed` : `${dep[2]} needs a different version of ${dep[1]}`,
      detail: missing ? `The mod "${dep[2]}" depends on "${dep[1]}" (${dep[3] || 'any version'}).` : `"${dep[2]}" wants ${dep[1]} ${dep[3]}, but ${dep[4]} is installed.`,
      fix: missing ? `Install ${dep[1]} from the Mods tab, or remove ${dep[2]}.` : `Install ${dep[1]} ${dep[3]}, or use a version of ${dep[2]} that fits.`,
      evidence: [l.trim()],
      actions: modAction(dep[2]),
    });
  }
  if ((m = /Missing or unsupported mandatory dependencies/.exec(all)) && !findings.some((f) => f.title.includes('needs'))) {
    push('forge-deps', { severity: 'error', title: 'Mods are missing things they need', detail: 'Forge/NeoForge listed missing or wrong-version dependencies.', fix: 'Install the listed mods at the right versions, or remove the mods that need them.', evidence: grep(/Mod ID:|mandatory dependencies/, 8), actions: [] });
  }
  // Client-only mod on a dedicated server.
  if (/for invalid dist DEDICATED_SERVER|Attempted to load class net\/minecraft\/client|Cannot load class net\.minecraft\.client|Environment type SERVER is blocked|net\.minecraft\.client\.\w+.*(NoClassDefFound|ClassNotFound)/.test(all)) {
    const modMatch = /Mod file: .*?([\w.+-]+\.jar)|\(([\w-]+)\.mixins\.json\)|mod '([\w-]+)'/i.exec(all);
    const culprit = modMatch?.[1] ?? modMatch?.[2] ?? modMatch?.[3] ?? null;
    const culpritId = culprit?.replace(/\.jar$/i, '') ?? null;
    push('client-mod', {
      severity: 'error',
      title: `A client-only ${noun} is on the server${culprit ? ` (${culprit})` : ''}`,
      detail: 'A mod made for the player\'s game (graphics, HUD, minimap, shaders…) tried to use client-only code, which doesn\'t exist on a server.',
      fix: 'Remove that mod from the server; players keep it in their own game.',
      evidence: grep(/invalid dist|net\/minecraft\/client|net\.minecraft\.client|Environment type/, 4),
      actions: culpritId ? [...modAction(culpritId), ...[...mods.entries()].filter(([k]) => culpritId.toLowerCase().startsWith(k)).slice(0, 1).map(([, v]) => ({ type: 'disable-content' as const, id: v.id, label: `Switch off ${v.name}` }))].slice(0, 1) : [],
    });
  }
  // Mixin failures name the mod's mixin config (e.g. "sodium.mixins.json").
  for (const l of lines) {
    const mx = /Mixin apply (?:for mod ([\w-]+) )?failed ([\w.-]+?)\.mixins?\.json|mixin(?:s)?\.json:([\w.]+)|from mod ([\w-]+) failed/i.exec(l);
    if (!mx || !/fail|error|critical/i.test(l)) continue;
    const modId = (mx[1] ?? mx[2] ?? mx[4] ?? '').split('.')[0];
    if (!modId) continue;
    push(`mixin:${modId}`, {
      severity: 'error',
      title: `The mod "${modId}" failed to patch the game`,
      detail: 'Mods change Minecraft\'s code with "mixins". This one failed, usually because it\'s for a different Minecraft/loader version or conflicts with another mod.',
      fix: `Update or remove ${modId}. If two mods touch the same thing, remove one of them.`,
      evidence: [l.trim().slice(0, 400)],
      actions: modAction(modId),
    });
    if (findings.length > 12) break;
  }
  // Forge/NeoForge crash reports list suspects.
  const suspects = /Suspected Mods?:\s*([^\n]+(?:\n\t[^\n]+)*)/.exec(all)?.[1];
  if (suspects && !/NONE/i.test(suspects)) {
    const list = [...suspects.matchAll(/([^,\n\t]+?)\s*\(([\w-]+)\)/g)].map((x) => ({ name: x[1].trim(), id: x[2] }));
    for (const s of list.slice(0, 3)) {
      push(`suspect:${s.id}`, {
        severity: 'error',
        title: `The crash report points at ${s.name}`,
        detail: `Minecraft's crash report lists ${s.name} (${s.id}) as the suspected cause.`,
        fix: `Update ${s.name}, or switch it off and start again to confirm it's the cause.`,
        evidence: [`Suspected Mods: ${suspects.split('\n')[0].trim()}`],
        actions: modAction(s.id),
      });
    }
  }

  // ---------- Paper / Spigot plugins ----------
  for (const l of lines) {
    const p = /Could not load '(?:plugins[\\/])?([^']+\.jar)' in folder '[^']*'/i.exec(l);
    if (!p) continue;
    const idx = lines.indexOf(l);
    const reason = lines.slice(idx, idx + 4).join(' ');
    const jar = p[1];
    const hit = mods.get(jar.toLowerCase()) ?? [...mods.values()].find((v) => v.id.toLowerCase() === jar.toLowerCase());
    let title = `The plugin ${jar} failed to load`;
    let fix = 'Update the plugin or remove it.';
    let detail = 'Paper/Spigot skipped this plugin while starting.';
    if ((m = /Unknown\/missing dependency plugins: \[([^\]]+)\]/.exec(reason))) {
      title = `${jar} needs ${m[1]}`;
      detail = `This plugin depends on ${m[1]}, which isn't installed.`;
      fix = `Install ${m[1]} from the Plugins tab (Hangar/SpigotMC/Modrinth).`;
    } else if (/Unsupported API version/.test(reason)) {
      const v = /Unsupported API version ([\d.]+)/.exec(reason)?.[1];
      title = `${jar} is built for a newer server`;
      detail = `It needs API version ${v ?? 'newer'}, but this server is older (${record.settings.mcVersion || 'unknown'}).`;
      fix = 'Use an older version of the plugin, or update the server (Settings → Update).';
    } else if (/InvalidDescriptionException|plugin\.yml/.test(reason)) {
      title = `${jar} isn't a valid plugin`;
      detail = 'It has no readable plugin.yml (maybe a mod, a client jar, or a broken download).';
      fix = 'Remove it and download the plugin again.';
    }
    push(`plugin:${jar}`, {
      severity: 'error',
      title,
      detail,
      fix,
      evidence: [l.trim().slice(0, 300), ...lines.slice(idx + 1, idx + 3).map((x) => x.trim().slice(0, 300))].filter(Boolean),
      actions: hit ? [{ type: 'disable-content', id: hit.id, label: `Switch off ${hit.name}` }] : [],
    });
  }
  for (const l of lines) {
    const p = /Error occurred while enabling ([\w .-]+?) v?[\d.]+/.exec(l) ?? /\[([\w .-]+)\] Plugin [\w .-]+ has failed to register events/.exec(l);
    if (!p) continue;
    push(`plugin-enable:${p[1]}`, {
      severity: 'warn',
      title: `${p[1]} crashed while starting up`,
      detail: 'The plugin loaded but threw an error when enabling (often its config, a missing database, or a version mismatch).',
      fix: `Check ${p[1]}'s config in plugins/${p[1]}/ (Files tab), update it, or switch it off.`,
      evidence: [l.trim().slice(0, 300)],
      actions: modAction(p[1]),
    });
  }

  const description = /^Description: (.+)$/m.exec(all)?.[1]?.trim() ?? null;
  if (!findings.length) {
    const exc = grep(/Exception|Error:|FATAL|Caused by/, 6);
    findings.push({
      severity: 'info',
      title: exc.length ? 'No known cause recognised' : 'No errors found',
      detail: exc.length
        ? `Tavern Host didn't recognise this problem${description ? ` ("${description}")` : ''}. The most relevant error lines are below.`
        : 'The logs don\'t show a crash or error Tavern Host knows about.',
      fix: exc.length ? 'Search the first error line online, or check the full log in the Console / Files tab.' : 'If the server still misbehaves, check the Console for warnings.',
      evidence: exc,
      actions: [],
    });
  }
  return { at: Date.now(), sources: sources.filter(Boolean), findings, description };
}
