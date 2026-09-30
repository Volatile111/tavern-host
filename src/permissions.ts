// Who can do what. Users and API keys share the same model: global permissions plus per-server permissions.
// Servers are granted all at once ('*', which also covers servers added later) or one by one (by id).

export const SERVER_PERMS = [
  'view',
  'console.view',
  'console.command',
  'control.start',
  'control.stop',
  'control.restart',
  'control.kill',
  'settings.edit',
  'server.update',
  'properties.edit',
  'server.delete',
  'files.view',
  'files.edit',
  'addons.manage',
  'addons.share',
  'backups.create',
  'backups.restore',
  'backups.delete',
  'access.edit',
  'tasks.run',
  'tasks.edit',
] as const;
export type ServerPerm = (typeof SERVER_PERMS)[number];

export const GLOBAL_PERMS = ['servers.create', 'files.browse', 'users.manage', 'panel.settings', 'audit.view'] as const;
export type GlobalPerm = (typeof GLOBAL_PERMS)[number];

export interface PermInfo {
  label: string;
  help: string;
  /** Can put programs on this system (mods, server files, Java settings...). */
  danger?: boolean;
}

/** Server permissions in groups, for the editor. */
export const SERVER_PERM_GROUPS: { group: string; perms: [ServerPerm, PermInfo][] }[] = [
  { group: 'Status', perms: [['view', { label: 'See the server', help: 'Overview, players, statistics, crash checks, world checks, game update status, difficulty and Valheim profiles. Every other permission includes this.' }]] },
  {
    group: 'Console',
    perms: [
      ['console.view', { label: 'View console', help: 'Read the live console output.' }],
      ['console.command', { label: 'Send commands', help: 'Type commands into the console (includes viewing it).' }],
    ],
  },
  {
    group: 'Control',
    perms: [
      ['control.start', { label: 'Start', help: 'Start the server, including "Start anyway" when the pre-start check finds a problem.' }],
      ['control.stop', { label: 'Stop', help: 'Stop the server (the world is saved first), with an optional countdown for players.' }],
      ['control.restart', { label: 'Restart', help: 'Restart the server, with an optional countdown. Also needed to switch Valheim profiles while it runs.' }],
      ['control.kill', { label: 'Kill', help: 'Force-close a stuck server without saving.' }],
    ],
  },
  {
    group: 'Server',
    perms: [
      ['settings.edit', { label: 'Change settings', help: 'Name, folder, memory, Java version and arguments, difficulty, and Valheim profiles (create, edit and switch world + mods).', danger: true }],
      ['server.update', { label: 'Update server software', help: 'Download/update the official server software, install Bedrock and Valheim game updates, and turn automatic updates on or off.' }],
      ['properties.edit', { label: 'Edit properties & world', help: 'server.properties (and repairing it), world options, experiments and cheats, and which world is active.' }],
      ['server.delete', { label: 'Remove server', help: 'Remove the server from Tavern Host (its files stay on disk).' }],
    ],
  },
  {
    group: 'Files',
    perms: [
      ['files.view', { label: 'View & download files', help: "Browse and download files in the server's folder, and export worlds." }],
      ['files.edit', { label: 'Edit & upload files', help: "Edit, upload, rename and delete files in the server's folder, and import or delete worlds (includes viewing).", danger: true }],
    ],
  },
  {
    group: 'Mods',
    perms: [
      ['addons.manage', { label: 'Manage mods / plugins / addons', help: 'Add, update, switch and remove mods, plugins and addons (uploads, Thunderstore, Hexium, Nexus Mods, CurseForge), take over mods added by hand, choose which mods players get, and turn on modding.', danger: true }],
      ['addons.share', { label: 'Share mods with players', help: "Turn the players' mod link on/off, and see the link and what's shared." }],
    ],
  },
  {
    group: 'Backups',
    perms: [
      ['backups.create', { label: 'Make backups', help: 'Back up now, change automatic backups, and run world checks.' }],
      ['backups.restore', { label: 'Restore backups', help: 'Replace the world with a backup, bring back backup copies, and accept world-check changes as intended.' }],
      ['backups.delete', { label: 'Delete backups', help: 'Delete backups.' }],
    ],
  },
  { group: 'Players', perms: [['access.edit', { label: 'Edit player lists', help: 'Whitelist/allowlist, operators, bans, kicks, mutes and player notes; Valheim admins, bans and allow list.' }]] },
  {
    group: 'Tasks',
    perms: [
      ['tasks.run', { label: 'Run tasks', help: 'Run scheduled tasks by hand.' }],
      ['tasks.edit', { label: 'Create & edit tasks', help: 'Create, change and delete scheduled tasks.' }],
    ],
  },
];

export const GLOBAL_PERM_INFO: Record<GlobalPerm, PermInfo> = {
  'servers.create': { label: 'Create & import servers', help: 'Add new servers (download software) or import existing ones.' },
  'files.browse': { label: 'Browse all files on this system', help: 'The folder picker sees every drive on this system.', danger: true },
  'users.manage': { label: 'Manage users & API keys', help: 'Add, change and remove users and API keys (never more than they have themselves).', danger: true },
  'panel.settings': { label: 'Panel settings', help: 'Remote access, firewall, integrations (CurseForge and Nexus Mods keys), backup copies and nodes (other systems).' },
  'audit.view': { label: 'View activity log', help: 'See who did what in Tavern Host.' },
};

export const SERVER_PERM_INFO: Record<ServerPerm, PermInfo> = Object.fromEntries(SERVER_PERM_GROUPS.flatMap((g) => g.perms)) as Record<ServerPerm, PermInfo>;

export interface Grants {
  global: GlobalPerm[];
  /** serverId or '*' (all servers, including ones added later) -> permissions on it */
  servers: Record<string, ServerPerm[]>;
}

export type Preset = 'admin' | 'operator' | 'viewer' | 'custom';

const ALL_SERVER: ServerPerm[] = [...SERVER_PERMS];
const MODERATOR: ServerPerm[] = ['view', 'console.view', 'console.command', 'control.start', 'control.stop', 'control.restart', 'access.edit', 'backups.create', 'tasks.run', 'files.view'];

export const PRESETS: Record<Exclude<Preset, 'custom'>, Grants> = {
  admin: { global: ['servers.create', 'files.browse', 'users.manage', 'panel.settings', 'audit.view'], servers: { '*': ALL_SERVER } },
  // "operator" is the id from before the rework; it's shown as "Moderator".
  operator: { global: [], servers: { '*': MODERATOR } },
  viewer: { global: [], servers: { '*': ['view'] } },
};

export const PRESET_LABELS: Record<Preset, string> = { admin: 'Admin', operator: 'Moderator', viewer: 'Viewer', custom: 'Custom' };

/** Whoever is making the request: a logged-in user or an API key. */
export interface Principal {
  kind: 'user' | 'apikey';
  id: string;
  name: string;
  /** The owner can do everything. */
  owner: boolean;
  grants: Grants;
}

/** Permissions that come with others (sending commands shows the console, editing files shows them). */
const IMPLIED: Partial<Record<ServerPerm, ServerPerm[]>> = {
  'console.command': ['console.view'],
  'files.edit': ['files.view'],
};

function serverPermsOf(p: Principal, serverId: string): Set<ServerPerm> {
  const set = new Set<ServerPerm>([...(p.grants.servers['*'] ?? []), ...(p.grants.servers[serverId] ?? [])]);
  for (const perm of [...set]) for (const extra of IMPLIED[perm] ?? []) set.add(extra);
  // Anything on a server includes seeing it.
  if (set.size) set.add('view');
  return set;
}

export function can(p: Principal, perm: ServerPerm, serverId: string): boolean {
  return p.owner || serverPermsOf(p, serverId).has(perm);
}

/** Every permission this principal has on a server (for the UI). */
export function permsOn(p: Principal, serverId: string): ServerPerm[] {
  return p.owner ? [...SERVER_PERMS] : [...serverPermsOf(p, serverId)];
}

export function canGlobal(p: Principal, perm: GlobalPerm): boolean {
  return p.owner || p.grants.global.includes(perm);
}

// Grants from before the rework: { manageServers, files, servers: { id: ['view'|'console'|'control'|'edit'] } }.
const LEGACY: Record<string, ServerPerm[]> = {
  view: ['view'],
  console: ['console.view'],
  control: ['control.start', 'control.stop', 'control.restart', 'console.command', 'backups.create', 'tasks.run'],
  edit: [
    'settings.edit',
    'server.update',
    'properties.edit',
    'files.view',
    'files.edit',
    'addons.manage',
    'addons.share',
    'backups.restore',
    'backups.delete',
    'access.edit',
    'tasks.edit',
  ],
};

/** Cleans up grants (from a request or from disk): known permissions only, servers that exist (or '*'); old format converted. */
export function normalizeGrants(input: unknown, serverIds: string[] | null): Grants {
  const g = (input ?? {}) as Record<string, any>;
  const global = new Set<GlobalPerm>((Array.isArray(g.global) ? g.global : []).filter((x: string): x is GlobalPerm => (GLOBAL_PERMS as readonly string[]).includes(x)));
  if (g.manageServers === true) global.add('servers.create');
  if (g.files === true) global.add('files.browse');
  const servers: Record<string, ServerPerm[]> = {};
  for (const [id, perms] of Object.entries((g.servers ?? {}) as Record<string, unknown>)) {
    if (id !== '*' && serverIds && !serverIds.includes(id)) continue;
    const out = new Set<ServerPerm>();
    for (const x of Array.isArray(perms) ? perms : []) {
      if ((SERVER_PERMS as readonly string[]).includes(x)) out.add(x as ServerPerm);
      else for (const y of LEGACY[x as string] ?? []) out.add(y);
    }
    // Old "manage servers" also covered removing them.
    if (g.manageServers === true && out.size) out.add('server.delete');
    if (out.size) servers[id] = [...out];
  }
  return { global: [...global], servers };
}

export function grantsFor(preset: Preset, custom: unknown, serverIds: string[]): Grants {
  return preset === 'custom' ? normalizeGrants(custom, serverIds) : structuredClone(PRESETS[preset]);
}

/**
 * Throws if `wanted` gives anything `giver` doesn't have (people who manage users can't hand out more power than they
 * have). The owner can give anything.
 */
export function assertCanGrant(giver: Principal, wanted: Grants) {
  if (giver.owner) return;
  for (const perm of wanted.global) if (!canGlobal(giver, perm)) throw new Error(`You can't give "${GLOBAL_PERM_INFO[perm].label}" because you don't have it yourself.`);
  for (const [id, perms] of Object.entries(wanted.servers)) {
    for (const perm of perms) {
      const ok = id === '*' ? (giver.grants.servers['*'] ?? []).includes(perm) || (perm === 'view' && (giver.grants.servers['*'] ?? []).length > 0) : can(giver, perm, id);
      if (!ok) throw new Error(`You can't give "${SERVER_PERM_INFO[perm].label}"${id === '*' ? ' on all servers' : ''} because you don't have it yourself.`);
    }
  }
}

/** Short description of which servers a grant covers, for lists. */
export function accessSummary(g: Grants, names: Record<string, string>): { scope: 'all' | 'some' | 'none'; text: string } {
  if (g.servers['*']?.length) return { scope: 'all', text: 'All servers' };
  const ids = Object.keys(g.servers).filter((id) => g.servers[id].length);
  if (!ids.length) return { scope: 'none', text: 'No servers' };
  return { scope: 'some', text: ids.map((id) => names[id] ?? 'removed server').join(', ') };
}
