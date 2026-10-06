// BepInEx config files (BepInEx/config/<plugin GUID>.cfg), shared by Tavern Host (the mod settings editor) and Tavern
// Client Mod Manager (settings the server sends to players). A file looks like:
//
//   ## Settings file was created by plugin Server Devcommands v1.115.0
//   ## Plugin GUID: server_devcommands
//
//   [1. General]
//
//   ## Automatically tries to enable devcommands when joining servers.
//   # Setting type: Boolean
//   # Default value: true
//   Automatic devcommands = true
//
// Values are changed in place, line by line, so everything else in the file (comments, order, other settings) stays.

export interface CfgEntry {
  section: string;
  key: string;
  value: string;
  description: string;
  /** BepInEx's type name: Boolean, Int32, Single, String, KeyCode, an enum's name... */
  type: string | null;
  default: string | null;
  /** "Acceptable values" (enums and lists). */
  options: string[] | null;
  /** Several options can be set at once, separated by ", " (flag enums). */
  multi: boolean;
  range: { min: number; max: number } | null;
}

export interface CfgFile {
  /** From the header BepInEx writes: the plugin's name, version and GUID. */
  plugin: string | null;
  version: string | null;
  guid: string | null;
  entries: CfgEntry[];
}

export function parseCfg(text: string): CfgFile {
  const out: CfgFile = { plugin: null, version: null, guid: null, entries: [] };
  let section = '';
  let pending = { description: [] as string[], type: null as string | null, default: null as string | null, options: null as string[] | null, multi: false, range: null as CfgEntry['range'] };
  const reset = () => (pending = { description: [], type: null, default: null, options: null, multi: false, range: null });
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    let m: RegExpExecArray | null;
    if (!line) continue;
    if ((m = /^## Settings file was created by plugin (.+?) v(\S+)$/.exec(line))) {
      out.plugin = m[1];
      out.version = m[2];
    } else if ((m = /^## Plugin GUID: (.+)$/.exec(line))) out.guid = m[1].trim();
    else if ((m = /^\[(.+)\]$/.exec(line))) {
      section = m[1].trim();
      reset();
    } else if (line.startsWith('## ')) pending.description.push(line.slice(3));
    else if (line === '##') pending.description.push('');
    else if ((m = /^# Setting type: (.+)$/.exec(line))) pending.type = m[1].trim();
    else if ((m = /^# Default value:(.*)$/.exec(line))) pending.default = m[1].trim();
    else if ((m = /^# Acceptable values: (.+)$/.exec(line))) pending.options = m[1].split(',').map((s) => s.trim()).filter(Boolean);
    else if ((m = /^# Acceptable value range: From (\S+) to (\S+)$/.exec(line))) {
      const min = Number(m[1]);
      const max = Number(m[2]);
      if (Number.isFinite(min) && Number.isFinite(max)) pending.range = { min, max };
    } else if (/^# Multiple values can be set/.test(line)) pending.multi = true;
    else if (line.startsWith('#')) continue;
    else {
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const { description, ...rest } = pending;
      out.entries.push({ section, key: line.slice(0, eq).trim(), value: line.slice(eq + 1).trim(), description: description.join('\n').trim(), ...rest });
      reset();
    }
  }
  return out;
}

export interface CfgChange {
  section: string;
  key: string;
  value: string;
}

/** Names and values that would break the file's line format (or reach another setting). */
export function checkChange(c: CfgChange): string | null {
  if (typeof c.section !== 'string' || typeof c.key !== 'string' || typeof c.value !== 'string') return 'Settings must be text.';
  if (/[\r\n]/.test(c.section + c.key + c.value)) return 'Settings must be on one line.';
  if (!c.section.trim() || c.section.includes(']') || c.section.length > 200) return `Bad section name "${c.section.slice(0, 60)}".`;
  if (!c.key.trim() || c.key.includes('=') || /^[#[]/.test(c.key.trim()) || c.key.length > 200) return `Bad setting name "${c.key.slice(0, 60)}".`;
  if (c.value.length > 4000) return `The value of "${c.key.slice(0, 60)}" is too long.`;
  return null;
}

/**
 * Sets values in a config file's text. Existing lines are changed in place; settings that aren't in the file yet are
 * added at the end of their section (or in a new section at the end). BepInEx keeps values it doesn't know yet, and
 * uses them once the mod asks for that setting.
 */
export function setValues(text: string, changes: CfgChange[]): string {
  for (const c of changes) {
    const bad = checkChange(c);
    if (bad) throw new Error(bad);
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.length ? text.split(/\r?\n/) : [];
  const id = (section: string, key: string) => `${section}\u0000${key}`;
  const todo = new Map(changes.map((c) => [id(c.section.trim(), c.key.trim()), { ...c, section: c.section.trim(), key: c.key.trim(), value: c.value.trim() }]));
  const lastLine = new Map<string, number>(); // last non-empty line of each section
  let section = '';
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const head = /^\[(.+)\]$/.exec(line);
    if (head) section = head[1].trim();
    else if (!line.startsWith('#')) {
      const eq = line.indexOf('=');
      const c = eq > 0 ? todo.get(id(section, line.slice(0, eq).trim())) : undefined;
      if (c) {
        lines[i] = `${c.key} = ${c.value}`;
        todo.delete(id(c.section, c.key));
      }
    }
    lastLine.set(section, i);
  });
  // The rest: into their section if it exists (bottom-up so earlier positions stay right), else new sections.
  const bySection = new Map<string, CfgChange[]>();
  for (const c of todo.values()) bySection.set(c.section, [...(bySection.get(c.section) ?? []), c]);
  const existing = [...bySection.keys()].filter((s) => s && lastLine.has(s)).sort((a, b) => lastLine.get(b)! - lastLine.get(a)!);
  for (const s of existing) lines.splice(lastLine.get(s)! + 1, 0, ...bySection.get(s)!.map((c) => `${c.key} = ${c.value}`));
  for (const [s, list] of bySection) {
    if (lastLine.has(s) && s) continue;
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    if (lines.length) lines.push('');
    lines.push(`[${s}]`, '', ...list.map((c) => `${c.key} = ${c.value}`));
  }
  if (lines.length && lines[lines.length - 1] !== '') lines.push('');
  return lines.join(eol);
}

/** Config file names as BepInEx makes them (<GUID>.cfg), checked so a name can't point outside the config folder. */
export function isCfgName(name: string) {
  return /^[\w.\- ]{1,150}\.cfg$/i.test(name) && !name.includes('..');
}
