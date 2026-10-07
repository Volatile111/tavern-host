// Project Zomboid dedicated server (Steam app 380870, anonymous SteamCMD). Started the way StartServer64.bat does (its
// bundled Java, zombie.network.GameServer), with:
//   -cachedir=<server folder>\Zomboid  so the settings, saves and logs stay in the server folder, not the Windows profile
//   -servername <name>                 which settings/save set to use (Zomboid\Server\<name>.ini)
//   -adminpassword <password>          the first start would otherwise ask for one on the console and wait forever
// It reads typed commands, so it runs under the runner: Console tab, kick/ban, countdown messages ("servermsg"), and Stop
// types "quit" (the server saves first). Tavern Host sets a few keys in <name>.ini before every start and keeps the
// rest; Steam Workshop mods are listed there too (WorkshopItems / Mods), and the server downloads them itself.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { GameModule, LogParser, LogState, ServerRecord, Settings } from './types.ts';
import { STEAM_APPS, num, bool, text, newPassword, steamInstall } from './steam-games.ts';

const JAVA = path.join('jre64', 'bin', 'java.exe');
const cacheDir = (record: ServerRecord) => path.join(record.installDir, 'Zomboid');
const iniFile = (record: ServerRecord) => path.join(cacheDir(record), 'Server', `${record.settings.world}.ini`);

/** Sets key=value lines in the server's .ini (adding missing ones at the end), keeping everything else. */
function writeIni(record: ServerRecord) {
  const s = record.settings;
  const file = iniFile(record);
  mkdirSync(path.dirname(file), { recursive: true });
  const text = existsSync(file) ? readFileSync(file, 'utf-8') : '';
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text ? text.split(/\r?\n/) : [];
  const values: Record<string, string> = {
    PublicName: String(s.serverName),
    PublicDescription: String(s.description ?? ''),
    Public: s.public ? 'true' : 'false',
    DefaultPort: String(s.port),
    UDPPort: String(Number(s.port) + 1),
    MaxPlayers: String(s.maxPlayers),
    Password: String(s.password ?? ''),
    PVP: s.pvp ? 'true' : 'false',
    Open: s.open ? 'true' : 'false',
    WorkshopItems: String(s.workshopItems ?? ''),
    Mods: String(s.mods ?? ''),
  };
  const done = new Set<string>();
  const out = lines.map((l) => {
    const m = /^([A-Za-z]\w*)=/.exec(l);
    if (m && m[1] in values) {
      done.add(m[1]);
      return `${m[1]}=${values[m[1]]}`;
    }
    return l;
  });
  while (out.length && !out[out.length - 1].trim()) out.pop();
  for (const [k, v] of Object.entries(values)) if (!done.has(k)) out.push(`${k}=${v}`);
  writeFileSync(file, out.join(eol) + eol);
}

function createZomboidParser(): LogParser {
  const st: LogState = { ready: false, players: [], playerCount: 0, version: null, lastSave: null, extra: {} };
  const known: Record<string, string> = {};
  const online = new Map<string, number>();
  const sync = () => {
    st.players = [...online].map(([name, joinedAt]) => ({ name, joinedAt }));
    st.playerCount = online.size;
  };
  return {
    feed(line) {
      let m: RegExpExecArray | null;
      if (/\*\*\* SERVER STARTED \*\*\*/.test(line)) st.ready = true;
      if ((m = /version=([\d.]+\S*)/.exec(line)) && !st.version) st.version = m[1];
      if ((m = /\[fully-connected\].*?username="([^"]{1,60})"/.exec(line)) || (m = /ConnectionManager:.*?"([^"]{1,60})" fully connected/i.exec(line))) {
        known[m[1]] = m[1];
        online.set(m[1], Date.now());
        sync();
      } else if ((m = /\[disconnect\].*?username="([^"]{1,60})"/.exec(line)) || (m = /Disconnected player "([^"]{1,60})"/i.exec(line))) {
        online.delete(m[1]);
        sync();
      }
      if (/World saved|Saving finished|saving world/i.test(line)) st.lastSave = Date.now();
    },
    state: () => st,
    knownPlayers: () => known,
  };
}

const quoteName = (s: string) => `"${String(s).replace(/"/g, '')}"`;

export const zomboid: GameModule = {
  id: 'zomboid',
  name: 'Project Zomboid',
  processName: 'java.exe',

  fields: [
    { key: 'serverName', label: 'Server name', type: 'text', help: 'Shown in the public server list.', restart: true },
    { key: 'description', label: 'Description', type: 'text', restart: true },
    { key: 'port', label: 'Port', type: 'number', help: 'Default 16261 (UDP). The next port up (16262) is used too.', restart: true },
    { key: 'password', label: 'Password', type: 'password', help: 'Optional. Players type it to join.', restart: true },
    { key: 'adminPassword', label: 'Admin password', type: 'password', help: 'For the "admin" account: log in with it in the game to get admin tools.', restart: true },
    { key: 'maxPlayers', label: 'Max players', type: 'number', restart: true },
    { key: 'public', label: 'List publicly', type: 'boolean', restart: true },
    { key: 'open', label: 'Anyone can join', type: 'boolean', help: 'Off: only accounts on the whitelist (made by admins) can join.', restart: true },
    { key: 'pvp', label: 'PvP', type: 'boolean', restart: true },
    { key: 'memoryMb', label: 'Memory (MB)', type: 'number', help: 'Java memory for the server. 4096 is fine for a few players; more for many players or mods.', restart: true },
    { key: 'world', label: 'Server profile name', type: 'text', help: 'Zomboid\\Server\\<name>.ini and its save. A new name starts a new world.', restart: true, section: 'World' },
    { key: 'workshopItems', label: 'Steam Workshop item IDs', type: 'text', help: 'Separated by ; (the server downloads them).', restart: true, section: 'Mods' },
    { key: 'mods', label: 'Mod IDs', type: 'text', help: "Separated by ; (each mod's ID, from its Workshop page).", restart: true, section: 'Mods' },
  ],
  quickFields: ['serverName', 'port', 'password', 'adminPassword', 'maxPlayers'],

  defaults: () => ({
    serverName: 'My Zomboid Server',
    description: 'Hosted with Tavern Host',
    port: 16261,
    password: '',
    adminPassword: newPassword(),
    maxPlayers: 16,
    public: false,
    open: true,
    pvp: false,
    memoryMb: 4096,
    world: 'servertest',
    workshopItems: '',
    mods: '',
  }),

  validate(s: Settings): Settings {
    const world = text(s.world || 'servertest', 'Server profile name', 40);
    if (!/^[\w-]+$/.test(world)) throw new Error('Server profile name can only use letters, numbers, - and _.');
    const workshopItems = text(s.workshopItems, 'Workshop item IDs', 4000).replace(/\s/g, '');
    if (workshopItems && !/^\d+(;\d+)*;?$/.test(workshopItems)) throw new Error('Workshop item IDs are numbers separated by ;.');
    const adminPassword = text(s.adminPassword, 'Admin password', 64, true);
    if (/["\s]/.test(adminPassword)) throw new Error('The admin password can\'t contain spaces or ".');
    return {
      serverName: text(s.serverName, 'Server name', 60, true),
      description: text(s.description, 'Description', 200),
      port: num(s.port, 'Port', 1024, 65534),
      password: text(s.password, 'Password', 64),
      adminPassword,
      maxPlayers: num(s.maxPlayers, 'Max players', 1, 100),
      public: bool(s.public),
      open: bool(s.open, true),
      pvp: bool(s.pvp),
      memoryMb: num(s.memoryMb ?? 4096, 'Memory', 1024, 65536),
      world,
      workshopItems,
      mods: text(s.mods, 'Mod IDs', 4000).replace(/\s*;\s*/g, ';'),
    };
  },

  checkInstall(installDir) {
    if (!existsSync(path.join(installDir, JAVA)) || !existsSync(path.join(installDir, 'java', 'projectzomboid.jar'))) throw new Error('jre64\\bin\\java.exe and java\\projectzomboid.jar were not found in that folder.');
  },

  async prepare(record) {
    writeIni(record);
  },

  launch(record) {
    const s = record.settings;
    return {
      exe: path.join(record.installDir, JAVA),
      args: [
        '-Djava.awt.headless=true',
        '-Dzomboid.steam=1',
        '-Dzomboid.znetlog=1',
        '-XX:+UseZGC',
        '-XX:-CreateCoredumpOnCrash',
        '-XX:-OmitStackTraceInFastThrow',
        `-Xms${s.memoryMb}m`,
        `-Xmx${s.memoryMb}m`,
        '-Djava.library.path=natives/',
        '-cp',
        'java/;java/projectzomboid.jar',
        'zombie.network.GameServer',
        '-statistic',
        '0',
        `-cachedir=${cacheDir(record)}`,
        '-servername',
        String(s.world),
        '-adminpassword',
        String(s.adminPassword),
      ],
      cwd: record.installDir,
    };
  },

  // Under the runner (typed commands). "quit" saves and shuts down.
  commands: { stop: 'quit' },
  announceCommand: (text) => `servermsg ${quoteName(text)}`,
  playerCommands: {
    kick: (n, r) => `kickuser ${quoteName(n)}${r ? ` -r ${quoteName(r)}` : ''}`,
    ban: (n, r) => `banuser ${quoteName(n)}${r ? ` -r ${quoteName(r)}` : ''}`,
    pardon: (n) => `unbanuser ${quoteName(n)}`,
    op: (n) => `setaccesslevel ${quoteName(n)} admin`,
    deop: (n) => `setaccesslevel ${quoteName(n)} none`,
    'whitelist-add': (n) => `addusertowhitelist ${quoteName(n)}`,
    'whitelist-remove': (n) => `removeuserfromwhitelist ${quoteName(n)}`,
  },

  createParser: createZomboidParser,

  connection: (record) => ({ port: Number(record.settings.port) || 16261, protocol: 'UDP', maxPlayers: Number(record.settings.maxPlayers) || null }),

  memoryLimit: (record) => ({ mb: Number(record.settings.memoryMb) || 4096, label: 'Java memory limit', note: 'Change it with Memory in Settings (restart to apply).' }),

  backup: {
    sources: (record) => ({
      base: cacheDir(record),
      include: ['Saves', 'Server', 'db'].filter((p) => existsSync(path.join(cacheDir(record), p))),
      world: 'Saves',
    }),
  },

  install: (record, job) => steamInstall(record, job, STEAM_APPS.zomboid, JAVA, 'Project Zomboid'),
};
