// Tavern Client Mod Manager: the players' app. Keeps a player's Valheim mods matched to a Tavern Host server's mods
// (from a thmods:// link), installs BepInEx, and has a Play button that syncs first and then starts Valheim.
// Uses the same install code as Tavern Host (compiled to dist/), so both sides lay out mods identically.
import { app, BrowserWindow, dialog, ipcMain, shell, Menu, nativeImage, safeStorage } from 'electron';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, createWriteStream, mkdtempSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const lib = (p) => import(pathToFileURL(path.join(root, 'dist', p)).href);
const sync = await lib('modsync/sync.js');
const mc = await lib('modsync/minecraft.js');
const vm = await lib('valheim-mods.js');
const scan = await lib('modscan.js');
const nexus = await lib('nexus.js');

app.setAppUserModelId('TavernClientModManager');
app.setName('Tavern Client Mod Manager');
app.commandLine.appendSwitch('force-color-profile', 'srgb');
if (!app.requestSingleInstanceLock()) app.quit();

// ---------- settings ----------

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function loadSettings() {
  try {
    return { autoSync: true, links: [], gameDir: null, ...JSON.parse(readFileSync(settingsFile(), 'utf-8')) };
  } catch {
    return { autoSync: true, links: [], gameDir: null };
  }
}
function saveSettings(s) {
  mkdirSync(path.dirname(settingsFile()), { recursive: true });
  writeFileSync(settingsFile(), JSON.stringify(s, null, 2));
}
let settings = loadSettings();

function gameDir() {
  if (settings.gameDir && sync.isValheimFolder(settings.gameDir)) return settings.gameDir;
  const found = sync.findValheim();
  if (found) {
    settings.gameDir = found;
    saveSettings(settings);
  }
  return found;
}

// ---------- profiles ----------
// "Vanilla" turns BepInEx off (the game starts with no mods; nothing is moved or deleted). Every other profile keeps its
// own set of switched-off mods; mods it hasn't seen yet (new installs) are on. The active modded profile follows what
// the player switches, so switching away and back restores it exactly.

const VANILLA = 'vanilla';

function profiles() {
  if (!Array.isArray(settings.profiles) || !settings.profiles.length) settings.profiles = [{ id: 'modded', name: 'Modded', disabled: [] }];
  if (settings.activeProfile !== VANILLA && !settings.profiles.some((p) => p.id === settings.activeProfile)) settings.activeProfile = settings.profiles[0].id;
  return settings.profiles;
}
const activeProfile = () => (profiles(), settings.activeProfile);

/** Remembers the active modded profile's switches (call before anything that changes profiles). */
function captureActive() {
  const dir = gameDir();
  if (!dir || activeProfile() === VANILLA) return;
  const p = profiles().find((x) => x.id === activeProfile());
  if (p) p.disabled = Object.values(vm.loadRegistry(dir).mods).filter((m) => !m.enabled).map(vm.fullName);
}

/** Makes the game folder match the active profile's loader switch (installing BepInEx turns it back on). */
function enforceProfile() {
  const dir = gameDir();
  if (dir) vm.setLoaderEnabled(dir, activeProfile() !== VANILLA);
}

function switchProfile(id) {
  const dir = gameDir();
  if (!dir) throw new Error("Valheim wasn't found.");
  if (valheimRunning()) throw new Error('Close Valheim first: its mod files are locked while it runs.');
  if (id !== VANILLA && !profiles().some((p) => p.id === id)) throw new Error('That profile no longer exists.');
  captureActive();
  settings.activeProfile = id;
  if (id !== VANILLA) {
    const off = new Set(profiles().find((p) => p.id === id).disabled.map((f) => f.toLowerCase()));
    for (const m of Object.values(vm.loadRegistry(dir).mods)) {
      const full = vm.fullName(m);
      const want = !off.has(full.toLowerCase());
      if (m.enabled !== want) vm.setModEnabled(dir, full, want);
    }
  }
  enforceProfile();
  saveSettings(settings);
  log(`Profile: ${id === VANILLA ? 'Vanilla (no mods)' : profiles().find((p) => p.id === id).name}.`);
}

function createProfile(name) {
  const clean = String(name ?? '').trim().slice(0, 40);
  if (!clean) throw new Error('Give the profile a name.');
  if (profiles().some((p) => p.name.toLowerCase() === clean.toLowerCase()) || clean.toLowerCase() === 'vanilla') throw new Error('A profile with that name already exists.');
  captureActive();
  // Starts as a copy of the mods switched on right now.
  const dir = gameDir();
  const disabled = dir ? Object.values(vm.loadRegistry(dir).mods).filter((m) => !m.enabled).map(vm.fullName) : [];
  const id = `p${Date.now().toString(36)}`;
  settings.profiles.push({ id, name: clean, disabled });
  saveSettings(settings);
  switchProfile(id);
  return id;
}

function renameProfile(id, name) {
  const p = profiles().find((x) => x.id === id);
  if (!p) throw new Error('That profile no longer exists.');
  const clean = String(name ?? '').trim().slice(0, 40);
  if (!clean) throw new Error('Give the profile a name.');
  if (profiles().some((x) => x.id !== id && x.name.toLowerCase() === clean.toLowerCase()) || clean.toLowerCase() === 'vanilla') throw new Error('A profile with that name already exists.');
  p.name = clean;
  saveSettings(settings);
}

function deleteProfile(id) {
  if (profiles().length <= 1) throw new Error('Keep at least one modded profile.');
  if (!profiles().some((p) => p.id === id)) return;
  if (activeProfile() === id) switchProfile(profiles().find((p) => p.id !== id).id);
  settings.profiles = settings.profiles.filter((p) => p.id !== id);
  saveSettings(settings);
}

// ---------- Nexus Mods API key (stored encrypted with Windows' own protection) ----------

const NEXUS_APP = { name: 'Tavern Client Mod Manager', version: app.getVersion() };

function nexusKey() {
  try {
    return settings.nexusKey ? safeStorage.decryptString(Buffer.from(settings.nexusKey, 'base64')) : '';
  } catch {
    return '';
  }
}

async function setNexusKey(key) {
  const clean = String(key ?? '').trim();
  if (!clean) {
    delete settings.nexusKey;
    delete settings.nexusUser;
    saveSettings(settings);
    return null;
  }
  const user = await nexus.validateKey(clean, NEXUS_APP); // proves the key works before saving it
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows can't protect the key on this PC, so it wasn't saved.");
  settings.nexusKey = safeStorage.encryptString(clean).toString('base64');
  settings.nexusUser = user;
  saveSettings(settings);
  return user;
}

function valheimRunning() {
  try {
    return /valheim\.exe/i.test(execFileSync('tasklist', ['/FI', 'IMAGENAME eq valheim.exe', '/NH'], { encoding: 'utf-8', windowsHide: true }));
  } catch {
    return false;
  }
}

// ---------- window ----------

let win = null;
const send = (channel, data) => win && !win.isDestroyed() && win.webContents.send(channel, data);
const log = (line) => send('log', line);

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

function createWindow() {
  win = new BrowserWindow({
    width: 1000,
    height: 760,
    minWidth: 720,
    minHeight: 520,
    title: 'Tavern Client Mod Manager',
    icon: path.join(here, 'icon.png'),
    backgroundColor: '#0d1219',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.loadFile(path.join(here, 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ---------- state for the page ----------

// Links saved before the app knew other games are Valheim links.
const gameOf = (entry) => entry.game ?? 'valheim';
const linksFor = (game) => settings.links.filter((l) => gameOf(l) === game);

/** The address players join with: the link's host and the game's port. */
function joinAddress(link, any) {
  if (!any.join) return null;
  return any.game === 'java' && any.join.port === 25565 ? link.host : `${link.host}:${any.join.port}`;
}

/** Satisfactory: mods to install with Satisfactory Mod Manager (names are checked: they go into smmanager:// links). */
function checkSatisfactory(any) {
  const list = Array.isArray(any.raw.mods) ? any.raw.mods.slice(0, 1000) : [];
  return list
    .filter((m) => /^[A-Za-z0-9_]{1,64}$/.test(String(m?.id ?? '')))
    .map((m) => ({ id: String(m.id), name: String(m.name ?? m.id).slice(0, 100), version: String(m.version ?? '').slice(0, 40) }));
}

async function linkStatus(entry) {
  const game = gameOf(entry);
  try {
    const link = sync.parseLink(entry.raw);
    const any = await sync.fetchAnyManifest(link);
    entry.server = any.server;
    const base = { raw: entry.raw, server: any.server, game: any.game, gameName: any.gameName, mode: any.mode, note: any.note, address: joinAddress(link, any), ok: true, checkedAt: Date.now() };
    if (game === 'valheim') {
      if (!Array.isArray(any.raw.mods)) throw new Error('That link is not a Valheim mod list.');
      const manifest = sync.checkManifest(any.raw);
      const dir = gameDir();
      return { ...base, manifest, plan: dir ? sync.planSync(dir, manifest, link) : null };
    }
    if (game === 'java' && any.mode === 'sync') {
      const manifest = mc.checkJavaManifest(any);
      entry.folder ??= mc.folderName(any.server, link);
      return {
        ...base,
        java: { loader: mc.loaderName(manifest.loader), mcVersion: manifest.mcVersion, loaderVersion: manifest.loaderVersion, mods: manifest.mods.length, folder: entry.folder },
        plan: mc.planJava(entry.folder, manifest),
        setup: mc.launcherStatus(entry.folder, manifest),
        installed: mc.installedJava(entry.folder),
      };
    }
    if (game === 'satisfactory') return { ...base, mods: checkSatisfactory(any) };
    return base;
  } catch (err) {
    return { raw: entry.raw, server: entry.server ?? null, game, ok: false, error: err.message, checkedAt: Date.now() };
  }
}

async function state() {
  const dir = gameDir();
  const links = await Promise.all(settings.links.map(linkStatus));
  captureActive();
  saveSettings(settings);
  const firstLink = linksFor('valheim')[0] ? sync.parseLink(linksFor('valheim')[0].raw) : null;
  return {
    version: app.getVersion(),
    gameDir: dir,
    bepinex: dir ? vm.bepinexStatus(dir) : null,
    profiles: profiles().map((p) => ({ id: p.id, name: p.name, off: p.disabled.length })),
    activeProfile: activeProfile(),
    loaderOn: dir ? vm.loaderEnabled(dir) : null,
    nexus: settings.nexusKey ? (settings.nexusUser ?? { name: 'linked', premium: false }) : null,
    autoSync: settings.autoSync,
    running: valheimRunning(),
    links,
    mods: dir ? sync.installedMods(dir, firstLink) : [],
    loose: dir ? vm.looseMods(dir) : [],
  };
}

// ---------- syncing: download + safety check everything first, install only what's clean or approved ----------

/** Approvals are remembered per exact mod version ("Author-Mod@1.2.3"). */
const approvedSet = () => new Set(settings.approved ?? []);
let pending = []; // Prepared syncs waiting for the player's review

function discardPending() {
  for (const p of pending) rmSync(p.workDir, { recursive: true, force: true });
  pending = [];
}

/**
 * Downloads and checks every change for the followed servers of one game ('valheim' or 'java'; null = every game
 * that can be synced right now). Nothing is installed yet.
 */
async function prepareAll(game = 'valheim') {
  const dir = gameDir();
  if (game === 'valheim' && !dir) throw new Error("Valheim wasn't found. Choose its folder first.");
  discardPending();
  const work = path.join(os.tmpdir(), 'tavern-client-mods');
  if ((game === 'valheim' || game === null) && dir) {
    for (const entry of linksFor('valheim')) {
      const link = sync.parseLink(entry.raw);
      log(`Checking ${entry.server ?? link.host}…`);
      const manifest = await sync.fetchManifest(link);
      pending.push(await sync.prepareSync(dir, manifest, link, work, log));
    }
  }
  if (game === 'java' || game === null) {
    for (const entry of linksFor('java')) {
      const link = sync.parseLink(entry.raw);
      log(`Checking ${entry.server ?? link.host}…`);
      const any = await sync.fetchAnyManifest(link);
      if (any.mode !== 'sync') continue; // a server without mods: nothing to sync
      const manifest = mc.checkJavaManifest(any);
      entry.folder ??= mc.folderName(any.server, link);
      pending.push(await mc.prepareJava(entry.folder, manifest, link, joinAddress(link, any), work, log));
    }
    saveSettings(settings);
  }
  return pending;
}

const canAuto = (p, approved) => (p.kind === 'java' ? mc.canAutoApplyJava(p, approved) : sync.canAutoApply(p, approved));

/** What the review screen shows. */
function reviewOf(list) {
  const approved = approvedSet();
  return list.map((p) => p.kind === 'java' ? {
    server: p.manifest.server,
    bepinex: null,
    changes: p.changes.map((c) => ({
      key: c.key,
      name: c.mod.name,
      author: '',
      version: c.mod.version,
      from: c.from,
      action: c.action,
      source: c.modrinth ? 'modrinth' : 'server',
      scan: c.scan,
      needsApproval: c.needsApproval,
      blocked: c.blocked,
      approvedBefore: approved.has(c.key),
    })),
    removals: p.removals,
    unavailable: p.unavailable,
    same: p.same,
  } : {
    server: p.manifest.server,
    bepinex: p.bepinex ? { version: p.bepinex.version, scan: p.bepinex.scan } : null,
    changes: p.changes.map((c) => ({
      key: c.key,
      name: c.mod.name.replace(/_/g, ' '),
      author: c.mod.namespace,
      version: c.mod.version,
      from: c.from,
      action: c.action,
      source: c.mod.site === 'hexium' ? 'hexium' : c.mod.source,
      scan: c.scan,
      needsApproval: c.needsApproval,
      blocked: c.blocked,
      approvedBefore: approved.has(c.key),
    })),
    removals: p.removals.map((m) => m.name.replace(/_/g, ' ')),
    unavailable: p.unavailable ?? [],
    same: p.same,
    // Mod settings the server owner sends (Valheim): what changes in the player's config files.
    settings: (p.settings ?? []).map((s) => ({ file: s.file, section: s.section, key: s.key, value: s.value, from: s.from })),
  });
}

const hasChanges = (list) => list.some((p) => p.bepinex || p.changes.length || p.removals.length || p.unavailable?.length || p.settings?.length);

/** Installs the pending changes: clean ones, remembered approvals and the ones approved now. */
async function applyPending(approveNow = []) {
  const dir = gameDir();
  if (pending.some((p) => p.kind !== 'java') && valheimRunning()) throw new Error('Close Valheim first: its mod files are locked while it runs.');
  settings.approved = [...new Set([...(settings.approved ?? []), ...approveNow])];
  saveSettings(settings);
  const approved = approvedSet();
  const summary = [];
  try {
    for (const p of pending) {
      if (p.kind === 'java') {
        const r = await mc.applyJava(p, approved, log);
        summary.push(`${p.manifest.server}: ${r.installed.length} installed, ${r.removed.length} removed${r.skipped.length ? `, skipped ${r.skipped.join(', ')}` : ''}`);
        if (r.setup && !r.setup.loaderReady) summary.push(`${p.manifest.server}: ${mc.loaderName(p.manifest.loader)} isn't in the Minecraft Launcher yet: run its installer once (see the Minecraft tab).`);
        continue;
      }
      const r = await sync.applyPrepared(dir, p, approved, log);
      summary.push(
        `${p.manifest.server}: ${r.installed.length} installed, ${r.removed.length} removed${r.settings.length ? `, ${r.settings.length} mod setting${r.settings.length === 1 ? '' : 's'} set` : ''}${r.skipped.length ? `, skipped ${r.skipped.join(', ')}` : ''}`,
      );
    }
  } finally {
    pending = [];
    // Syncing can install BepInEx (turning the loader on) and switches synced mods on: keep the profile in charge.
    enforceProfile();
    captureActive();
    saveSettings(settings);
  }
  // The page logs the summary (after a review, or when it hears about an automatic sync).
  return summary;
}

// ---------- IPC ----------

const handle = (name, fn) =>
  ipcMain.handle(name, async (_e, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

handle('state', state);
handle('add-link', async (raw) => {
  const link = sync.parseLink(String(raw));
  const any = await sync.fetchAnyManifest(link); // proves the link works before saving it
  settings.links = settings.links.filter((l) => sync.parseLink(l.raw).token !== link.token);
  settings.links.push({ raw: link.raw, server: any.server, game: any.game, ...(any.game === 'java' ? { folder: mc.folderName(any.server, link) } : {}) });
  saveSettings(settings);
  return { server: any.server, game: any.game, gameName: any.gameName };
});
handle('remove-link', async (raw) => {
  settings.links = settings.links.filter((l) => l.raw !== raw);
  saveSettings(settings);
});
// Sync now: download + check, then the page shows the review (or reports nothing to do).
handle('prepare', async (game) => {
  const list = await prepareAll(game === 'java' ? 'java' : 'valheim');
  return { review: reviewOf(list), changes: hasChanges(list), auto: list.every((p) => canAuto(p, approvedSet())) };
});
// Minecraft: set the launcher up again (after running the Forge/NeoForge installer, or if the profile was deleted).
handle('mc-setup', async (raw) => {
  const entry = linksFor('java').find((l) => l.raw === raw);
  if (!entry) throw new Error('That server is no longer followed.');
  const link = sync.parseLink(entry.raw);
  const any = await sync.fetchAnyManifest(link);
  const manifest = mc.checkJavaManifest(any);
  entry.folder ??= mc.folderName(any.server, link);
  saveSettings(settings);
  return mc.setupLauncher(entry.folder, manifest, joinAddress(link, any), log);
});
handle('mc-open-folder', async (raw) => {
  const entry = linksFor('java').find((l) => l.raw === raw);
  if (!entry?.folder) return;
  const dir = path.join(mc.instanceDir(entry.folder), 'mods');
  mkdirSync(dir, { recursive: true });
  await shell.openPath(dir);
});
// Links the page may open outside the app: mod pages, loader installers and Satisfactory Mod Manager.
handle('open-external', async (url) => {
  const u = String(url);
  const ok =
    /^smmanager:\/\/install\?modID=[A-Za-z0-9_]{1,64}(&version=[\w.\-+]{1,40})?$/.test(u) ||
    /^https:\/\/(ficsit\.app|smm\.ficsit\.app|maven\.minecraftforge\.net|maven\.neoforged\.net|www\.minecraft\.net)\//.test(u);
  if (!ok) throw new Error('That link is not allowed.');
  await shell.openExternal(u);
});
handle('apply', async (approveNow) => applyPending(Array.isArray(approveNow) ? approveNow.map(String) : []));
handle('cancel', async () => discardPending());
handle('launch', async () => {
  log('Starting Valheim…');
  await shell.openExternal(`steam://rungameid/${sync.VALHEIM_APP_ID}`);
});
handle('pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose the Valheim folder (with valheim.exe)', properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  if (!sync.isValheimFolder(r.filePaths[0])) throw new Error("That folder doesn't contain valheim.exe.");
  settings.gameDir = r.filePaths[0];
  saveSettings(settings);
  return settings.gameDir;
});
handle('open-folder', async (which) => {
  const dir = gameDir();
  if (!dir) return;
  await shell.openPath(which === 'plugins' ? path.join(dir, 'BepInEx', 'plugins') : dir);
});
handle('set-auto', async (on) => {
  settings.autoSync = !!on;
  saveSettings(settings);
});
handle('install-bepinex', async () => {
  const dir = gameDir();
  if (!dir) throw new Error("Valheim wasn't found.");
  await vm.installWithDependencies(dir, { ...vm.BEPINEX_PACK }, log, { check: askIfFlagged });
  enforceProfile();
});
handle('toggle-mod', async (full, enabled) => {
  vm.setModEnabled(gameDir(), full, !!enabled);
  captureActive();
  saveSettings(settings);
});
handle('remove-mod', async (full) => {
  const needed = vm.dependents(gameDir(), full);
  if (needed.length) throw new Error(`${needed.join(', ')} need${needed.length === 1 ? 's' : ''} this mod.`);
  vm.removeMod(gameDir(), full);
});
handle('install-file', async (file) => {
  const dir = gameDir();
  if (!dir) throw new Error("Valheim wasn't found.");
  return installZip(dir, file, 'upload');
});
handle('browse', async () => openBrowser('https://thunderstore.io/c/valheim/', 'Thunderstore'));
handle('browse-nexus', async () => openBrowser('https://www.nexusmods.com/games/valheim/mods', 'Nexus Mods'));
handle('browse-hexium', async () => openBrowser(vm.HEXIUM, 'Hexium'));

// ---------- updating this app from a new installer file ----------

let pickedInstaller = null;
handle('pick-update', async () => {
  if (!app.isPackaged) throw new Error('Updating from a file only works in the installed app (this copy runs from the source files).');
  const r = await dialog.showOpenDialog(win, { title: 'Choose a Tavern Client Mod Manager installer', filters: [{ name: 'Installer', extensions: ['exe'] }], properties: ['openFile'] });
  if (r.canceled || !r.filePaths[0]) return null;
  const file = r.filePaths[0];
  let info = {};
  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', '$v = (Get-Item -LiteralPath $env:TH_FILE).VersionInfo; @{ product = $v.ProductName; version = $v.ProductVersion } | ConvertTo-Json -Compress'],
      { encoding: 'utf-8', windowsHide: true, timeout: 20_000, env: { ...process.env, TH_FILE: file } },
    );
    info = JSON.parse(out.trim() || '{}');
  } catch {}
  const version = String(info.version ?? /(\d+\.\d+\.\d+)/.exec(path.basename(file))?.[1] ?? '').replace(/\.0$/, '');
  if (!/Tavern Client Mod Manager/i.test(`${info.product ?? ''} ${path.basename(file)}`)) throw new Error("That isn't a Tavern Client Mod Manager installer.");
  pickedInstaller = { file, version };
  return { name: path.basename(file), version, current: app.getVersion() };
});
handle('run-update', async () => {
  // Only the file just picked in the dialog above, never a path from the page.
  const picked = pickedInstaller;
  pickedInstaller = null;
  if (!picked || !existsSync(picked.file)) throw new Error('Choose the installer again.');
  if (valheimRunning()) throw new Error('Close Valheim first.');
  runUpdateWithWindow(picked.file, { product: 'Tavern Client Mod Manager', version: picked.version, note: 'Your mods and settings are kept.' });
  setTimeout(() => app.quit(), 800);
});

// ---------- updates from GitHub releases ----------
// New versions are published at github.com/Volatile111/tavern-client-releases. Checked at start and every 6 hours;
// installing downloads the installer here (never from a page-given address) and runs it like "Update from a file".

const RELEASES = 'Volatile111/tavern-client-releases';
const INSTALLER_ASSET = /^Tavern-Client-Mod-Manager-Setup-(\d+\.\d+\.\d+)\.exe$/;
let latestRelease = { at: 0, info: null, error: null };

function isNewer(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0;
  }
  return false;
}

async function fetchRelease() {
  const res = await fetch(`https://api.github.com/repos/${RELEASES}/releases/latest`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': app.getName() }, signal: AbortSignal.timeout(15_000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  const r = await res.json();
  const asset = (r.assets ?? []).find((a) => INSTALLER_ASSET.test(a.name));
  if (!asset) throw new Error("The latest release doesn't have an installer.");
  return { version: INSTALLER_ASSET.exec(asset.name)[1], notes: String(r.body ?? '').slice(0, 4000), url: r.html_url, asset };
}

handle('app-update', async (force) => {
  if (force || Date.now() - latestRelease.at > 6 * 3600_000) {
    try {
      latestRelease = { at: Date.now(), info: await fetchRelease(), error: null };
    } catch (err) {
      latestRelease = { at: Date.now(), info: latestRelease.info, error: err.message };
    }
  }
  const { info, error, at } = latestRelease;
  const current = app.getVersion();
  return { current, latest: info?.version ?? null, available: !!info && isNewer(info.version, current), notes: info?.notes ?? '', url: info?.url ?? `https://github.com/${RELEASES}/releases`, error, checkedAt: at, canInstall: app.isPackaged };
});

let appUpdating = false;
handle('install-app-update', async () => {
  if (!app.isPackaged) throw new Error('Updates install only in the installed app (this copy runs from the source files).');
  if (valheimRunning()) throw new Error('Close Valheim first.');
  if (appUpdating) throw new Error('The update is already downloading.');
  appUpdating = true;
  try {
    const info = await fetchRelease();
    if (!info || !isNewer(info.version, app.getVersion())) throw new Error(`You already have the latest version (${app.getVersion()}).`);
    const dl = await fetch(info.asset.browser_download_url, { headers: { 'User-Agent': app.getName() } });
    if (!dl.ok || !dl.body) throw new Error(`The download failed (${dl.status}).`);
    const total = Number(dl.headers.get('content-length')) || info.asset.size || 0;
    const dir = path.join(app.getPath('temp'), `tavern-update-${randomBytes(4).toString('hex')}`);
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, info.asset.name);
    const hash = createHash('sha256');
    const out = createWriteStream(file);
    let received = 0;
    let lastSent = 0;
    for await (const chunk of dl.body) {
      hash.update(chunk);
      received += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      if (Date.now() - lastSent > 200) {
        lastSent = Date.now();
        win?.webContents.send('update-progress', { received, total, version: info.version });
      }
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
    if (info.asset.size && received !== info.asset.size) throw new Error('The download was incomplete. Try again.');
    const digest = /^sha256:([0-9a-f]{64})$/i.exec(info.asset.digest ?? '');
    if (digest && digest[1].toLowerCase() !== hash.digest('hex')) {
      rmSync(dir, { recursive: true, force: true });
      throw new Error("The downloaded installer doesn't match the release's checksum, so it wasn't run.");
    }
    runUpdateWithWindow(file, { product: 'Tavern Client Mod Manager', version: info.version, note: 'Your mods and settings are kept.', cleanup: dir });
    setTimeout(() => app.quit(), 800);
    return { version: info.version };
  } finally {
    appUpdating = false;
  }
});

/**
 * Runs an installer silently behind a small "Updating…" window: it waits for this app to close, runs the installer
 * (/S --force-run starts the new version when it's done), and shows each step (closing → installing → done, or the
 * error). Same helper as Tavern Host's (desktop/main.js).
 */
function runUpdateWithWindow(installer, { product, version, note = '', cleanup = null }) {
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '[System.Windows.Forms.Application]::EnableVisualStyles()',
    '$nl = [Environment]::NewLine',
    '$form = New-Object System.Windows.Forms.Form',
    '$form.Text = "Updating " + $env:TH_PRODUCT',
    '$form.ClientSize = New-Object System.Drawing.Size(470, 134)',
    "$form.FormBorderStyle = 'FixedDialog'; $form.MaximizeBox = $false; $form.MinimizeBox = $false",
    "$form.StartPosition = 'CenterScreen'; $form.TopMost = $true",
    '$label = New-Object System.Windows.Forms.Label',
    '$label.SetBounds(18, 14, 434, 62)',
    "$label.Font = New-Object System.Drawing.Font('Segoe UI', 10)",
    '$label.Text = "Closing " + $env:TH_PRODUCT + "..."',
    '$bar = New-Object System.Windows.Forms.ProgressBar',
    '$bar.SetBounds(18, 90, 434, 20)',
    "$bar.Style = 'Marquee'; $bar.MarqueeAnimationSpeed = 25",
    '$form.Controls.Add($label); $form.Controls.Add($bar)',
    "$script:state = 'closing'; $script:proc = $null; $script:started = Get-Date",
    '$timer = New-Object System.Windows.Forms.Timer',
    '$timer.Interval = 400',
    '$timer.Add_Tick({',
    "  if ($script:state -eq 'closing') {",
    '    $alive = Get-Process -Id ([int]$env:TH_WAIT_PID) -ErrorAction SilentlyContinue',
    '    if (-not $alive -or ((Get-Date) - $script:started).TotalSeconds -gt 20) {',
    '      $label.Text = "Installing " + $env:TH_PRODUCT + " " + $env:TH_VERSION + "..." + $nl + "This takes a minute and it starts again by itself. " + $env:TH_NOTE',
    "      $script:proc = Start-Process -FilePath $env:TH_INSTALLER -ArgumentList '/S','--force-run' -PassThru",
    '      $null = $script:proc.Handle',
    "      $script:state = 'installing'",
    '    }',
    "  } elseif ($script:state -eq 'installing' -and $script:proc.HasExited) {",
    '    $timer.Stop()',
    "    $bar.Style = 'Continuous'; $bar.Value = 100",
    '    if ($script:proc.ExitCode -eq 0) {',
    '      $label.Text = $env:TH_PRODUCT + " " + $env:TH_VERSION + " is installed. Starting it..."',
    '      if ($env:TH_CLEANUP) { Remove-Item -LiteralPath $env:TH_CLEANUP -Recurse -Force -ErrorAction SilentlyContinue }',
    '      $close = New-Object System.Windows.Forms.Timer; $close.Interval = 4000; $close.Add_Tick({ $form.Close() }); $close.Start()',
    '    } else {',
    '      $label.Text = "The update did not finish (installer exit code " + $script:proc.ExitCode + ")." + $nl + "Run the installer yourself: " + $env:TH_INSTALLER',
    '    }',
    '  }',
    '})',
    '$timer.Start()',
    '[void]$form.ShowDialog()',
  ].join('\n');
  // The script goes in a file, started through "cmd /c start": that gives PowerShell a console of its own (hidden by
  // -WindowStyle). Launched straight from this app (detached, no console) PowerShell quit at once without running
  // anything, so the app closed and nothing was installed.
  const dir = cleanup ?? mkdtempSync(path.join(app.getPath('temp'), 'tavern-updater-'));
  const ps1 = path.join(dir, 'update.ps1');
  writeFileSync(ps1, `﻿${script}`, 'utf-8');
  spawn('cmd.exe', ['/d', '/s', '/c', `"start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${ps1}""`], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    windowsVerbatimArguments: true,
    env: { ...process.env, TH_INSTALLER: installer, TH_PRODUCT: product, TH_VERSION: version || 'the new version', TH_NOTE: note, TH_WAIT_PID: String(process.pid), TH_CLEANUP: cleanup ?? '' },
  }).unref();
}
// A pasted Hexium mod page (latest version, or the one in the address).
handle('install-hexium', async (input) => {
  const pkg = vm.parseHexiumUrl(String(input));
  if (!pkg) throw new Error('Paste a Hexium mod page address, e.g. https://valheim.hexium.gg/mods/Author/ModName');
  return installFromHexium(pkg);
});
// Updates for the player's own mods (mods that follow a server update with the server).
handle('check-updates', async () => {
  const dir = gameDir();
  if (!dir) return {};
  const out = {};
  const mods = Object.values(vm.loadRegistry(dir).mods).filter((m) => !m.syncedFrom && vm.registryOf(m.source));
  await Promise.all(
    mods.map(async (m) => {
      try {
        const latest = await vm.latestPackage(m.namespace, m.name, vm.registryOf(m.source));
        if (vm.compareVersions(latest.version, m.version) > 0) out[vm.fullName(m)] = latest.version;
      } catch {}
    }),
  );
  return out;
});
handle('update-mod', async (full) => {
  const dir = gameDir();
  if (!dir) throw new Error("Valheim wasn't found.");
  if (valheimRunning()) throw new Error('Close Valheim first.');
  const m = vm.loadRegistry(dir).mods[String(full)];
  if (!m) throw new Error('That mod is not installed.');
  if (m.syncedFrom) throw new Error('That mod follows a server: it updates when the server updates it.');
  const report = await vm.installWithDependencies(dir, { namespace: m.namespace, name: m.name, side: m.side, source: m.source }, log, { check: askIfFlagged });
  enforceProfile();
  return report.installed.filter((i) => i.action !== 'kept').map((i) => `${i.action} ${i.name} ${i.version}`);
});
handle('switch-profile', async (id) => switchProfile(String(id)));
handle('create-profile', async (name) => createProfile(name));
handle('rename-profile', async (id, name) => renameProfile(String(id), name));
handle('delete-profile', async (id) => deleteProfile(String(id)));
handle('set-nexus-key', async (key) => setNexusKey(key));
// A pasted nxm:// link or nexusmods.com/valheim/mods/… address (the latter needs Premium).
handle('install-nexus', async (input) => installFromNexus(String(input)));
ipcMain.handle('set-icon', async (_e, dataUrl) => {
  if (!win || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,') || dataUrl.length > 2_000_000) return;
  const image = nativeImage.createFromDataURL(dataUrl);
  if (!image.isEmpty()) win.setIcon(image);
});

/**
 * Safety check for the player's own installs (drag-and-drop, Thunderstore window): a Defender detection stops it;
 * anything else suspicious asks first.
 */
async function askIfFlagged(zipFile, pkg) {
  const site = pkg.namespace === 'Local' || pkg.namespace === 'Nexus' ? null : vm.registryOf(pkg.source);
  const status = site ? await vm.versionStatus(pkg.namespace, pkg.name, pkg.version, site) : { active: null, deprecated: false };
  const r = await scan.scanPackage(zipFile, { fullName: `${pkg.namespace}-${pkg.name}`, thunderstoreActive: status.active, deprecated: status.deprecated });
  log(`Safety check ${pkg.name} ${pkg.version}: ${r.summary}`);
  if (r.verdict === 'blocked') throw new Error(`${pkg.name} was not installed: ${r.summary}.`);
  if (r.verdict === 'review') {
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      title: 'Safety check',
      message: `${pkg.name} ${pkg.version} did something the safety check flags:`,
      detail: `${r.flags.map((f) => `• ${f.text}${f.file ? ` (${f.file})` : ''}`).join('\n')}\n\nThis doesn't prove it's harmful, but mods are programs that run on your PC. Only install it if you trust where it came from.`,
      buttons: ['Don\'t install', 'Install anyway'],
      defaultId: 0,
      cancelId: 0,
    });
    if (response !== 1) throw new Error(`${pkg.name} was not installed.`);
  }
}

async function installZip(dir, file, origin) {
  const ref = origin === 'nexus' ? null : vm.refFromFileName(file);
  // Thunderstore-window downloads are saved as "thsync-<time>-<file name>".
  const nx = !ref ? nexus.nexusFromFileName(path.basename(file).replace(/^thsync-\d+-/, '')) : null;
  const manifest = vm.readPackageZip(file);
  const namespace = ref?.namespace ?? nx?.namespace ?? 'Local';
  const name = ref?.name ?? nx?.name ?? (manifest.name || path.basename(file, '.zip')).replace(/[^\w.]/g, '_');
  const report = await vm.installWithDependencies(dir, { namespace, name, version: manifest.version || ref?.version || nx?.version, zipFile: file, source: ref ? 'thunderstore' : 'upload' }, log, { check: askIfFlagged });
  enforceProfile();
  return report.installed.filter((i) => i.action !== 'kept').map((i) => `${i.action} ${i.name} ${i.version}`);
}

/** Installs a Hexium mod (and what it needs; dependencies Hexium doesn't have come from Thunderstore). */
async function installFromHexium(pkg) {
  const dir = gameDir();
  if (!dir) throw new Error("Valheim wasn't found.");
  if (valheimRunning()) throw new Error('Close Valheim first.');
  const report = await vm.installWithDependencies(dir, { namespace: pkg.namespace, name: pkg.name, version: pkg.version ?? undefined, source: 'hexium' }, log, { check: askIfFlagged });
  enforceProfile();
  return report.installed.filter((i) => i.action !== 'kept').map((i) => `${i.action} ${i.name} ${i.version}`);
}

/** Hexium's "Install with Gale" button: gale://install/hexium/<Author>/<Mod>/<version>. */
function parseGale(url) {
  const m = /^gale:\/\/install\/hexium\/([\w.]+)\/([\w.]+)(?:\/(\d+\.\d+\.\d+))?/i.exec(url);
  return m ? { namespace: m[1], name: m[2], version: m[3] ?? null } : null;
}

async function handleHexium(pkg) {
  const target = browser && !browser.isDestroyed() ? browser : win;
  const label = `${pkg.name}${pkg.version ? ` ${pkg.version}` : ''}`;
  try {
    const { response } = await dialog.showMessageBox(target, {
      type: 'question',
      title: 'Install this mod?',
      message: `Install ${label} (by ${pkg.namespace}) from Hexium into Valheim?`,
      detail: 'It and what it needs are downloaded and safety-checked first.',
      buttons: ['Cancel', 'Install'],
      defaultId: 1,
      cancelId: 0,
    });
    if (response !== 1) throw new Error('Not installed (cancelled).');
    send('installed', { filename: label, done: await installFromHexium(pkg) });
  } catch (err) {
    send('installed', { filename: label, error: err.message });
  }
}

/** Downloads a Nexus file with the API key (nxm:// link or mod page), safety-checks it and installs it. */
async function installFromNexus(input) {
  const dir = gameDir();
  if (!dir) throw new Error("Valheim wasn't found.");
  if (valheimRunning()) throw new Error('Close Valheim first.');
  const key = nexusKey();
  if (!key) throw new Error('Add your Nexus Mods API key first (My mods → Nexus Mods key), or use "Manual download" in the Nexus window.');
  const tmp = path.join(os.tmpdir(), `thnexus-${Date.now()}.zip`);
  try {
    const info = await nexus.downloadNexus(input, tmp, key, NEXUS_APP, log);
    const pkg = nexus.nexusPackage(info);
    const manifest = vm.readPackageZip(tmp);
    const report = await vm.installWithDependencies(
      dir,
      { namespace: pkg.namespace, name: pkg.name, version: manifest.version || pkg.version, zipFile: tmp, source: 'upload' },
      log,
      { check: askIfFlagged },
    );
    enforceProfile();
    return report.installed.filter((i) => i.action !== 'kept').map((i) => `${i.action} ${info.modName} ${i.version}`);
  } finally {
    rmSync(tmp, { force: true });
  }
}

// Thunderstore / Nexus Mods in a window: downloaded zips are installed into the game (the player's own mods). On Nexus,
// "Mod Manager Download" buttons open nxm:// links, which are downloaded through the API with the player's key.
let browser = null;

async function handleNxm(url) {
  const target = browser && !browser.isDestroyed() ? browser : win;
  try {
    if (!nexusKey()) throw new Error('"Mod Manager Download" needs your Nexus Mods API key (My mods → Nexus Mods key). Or use "Manual download" instead.');
    const { response } = await dialog.showMessageBox(target, {
      type: 'question',
      title: 'Install this mod?',
      message: 'Install this Nexus Mods file into Valheim?',
      detail: 'It will be safety-checked first. Only install mods from sources you trust.',
      buttons: ['Cancel', 'Install'],
      defaultId: 1,
      cancelId: 0,
    });
    if (response !== 1) throw new Error('Not installed (cancelled).');
    send('installed', { filename: 'Nexus Mods download', done: await installFromNexus(url) });
  } catch (err) {
    send('installed', { filename: 'Nexus Mods download', error: err.message });
  }
}

function openBrowser(url, site) {
  if (browser && !browser.isDestroyed()) {
    browser.setTitle(`${site} – Tavern Client Mod Manager`);
    browser.loadURL(url);
    browser.focus();
    return;
  }
  browser = new BrowserWindow({ width: 1150, height: 820, title: `${site} – Tavern Client Mod Manager`, icon: path.join(here, 'icon.png'), webPreferences: { partition: 'persist:mods', sandbox: true, contextIsolation: true } });
  // Nexus "Mod Manager Download" (nxm://) and Hexium "Install with Gale" (gale://) links.
  const catchNxm = (e, next) => {
    if (/^nxm:\/\//i.test(next)) {
      e.preventDefault();
      handleNxm(next);
    } else if (parseGale(next)) {
      e.preventDefault();
      handleHexium(parseGale(next));
    }
  };
  browser.webContents.on('will-navigate', catchNxm);
  browser.webContents.on('will-frame-navigate', (e) => !e.isMainFrame && catchNxm(e, e.url));
  const go = (fn) => () => browser && !browser.isDestroyed() && fn(browser.webContents);
  browser.setMenu(
    Menu.buildFromTemplate([
      { label: '◀ Back', click: go((w) => w.navigationHistory.canGoBack() && w.navigationHistory.goBack()) },
      { label: 'Forward ▶', click: go((w) => w.navigationHistory.canGoForward() && w.navigationHistory.goForward()) },
      { label: '⟳ Reload', accelerator: 'F5', click: go((w) => w.reload()) },
      { label: '⌂ Home', click: go((w) => w.loadURL(url)) },
    ]),
  );
  browser.webContents.setWindowOpenHandler(({ url: next }) => {
    if (/^nxm:\/\//i.test(next)) handleNxm(next);
    else if (parseGale(next)) handleHexium(parseGale(next));
    else if (/^https?:\/\//.test(next)) browser.loadURL(next);
    return { action: 'deny' };
  });
  browser.webContents.session.on('will-download', (_e, item) => {
    const filename = item.getFilename();
    // Hexium's "Download" gives just "<version>.zip": install it by name from the mod page being viewed instead.
    if (/^https:\/\/cdn\.hexium\.gg\//i.test(item.getURL())) {
      const page = /^https?:\/\/(?:valheim\.)?hexium\.gg\/mods\/([\w.]+)\/([\w.]+)/i.exec(browser && !browser.isDestroyed() ? browser.webContents.getURL() : '');
      if (page) {
        item.cancel();
        handleHexium({ namespace: page[1], name: page[2], version: /^(\d+\.\d+\.\d+)\.zip$/i.exec(filename)?.[1] ?? null });
        return;
      }
    }
    if (/\.(7z|rar)$/i.test(filename)) {
      item.cancel();
      send('installed', { filename, error: 'Only .zip mods can be installed. Download it in your normal browser, repack it as a .zip and drop that here.' });
      return;
    }
    if (!/\.zip$/i.test(filename)) return;
    const tmp = path.join(os.tmpdir(), `thsync-${Date.now()}-${filename.replace(/[^\w.\- ]/g, '_')}`);
    item.setSavePath(tmp);
    log(`Downloading ${filename}…`);
    item.once('done', async (_ev, st) => {
      try {
        if (st !== 'completed') throw new Error(`Download ${st}.`);
        const dir = gameDir();
        if (!dir) throw new Error("Valheim wasn't found.");
        if (valheimRunning()) throw new Error('Close Valheim first.');
        // Websites can start downloads on their own: always ask before installing one.
        const { response } = await dialog.showMessageBox(browser && !browser.isDestroyed() ? browser : win, {
          type: 'question',
          title: 'Install this mod?',
          message: `Install ${filename} into Valheim?`,
          detail: 'It will be safety-checked first. Only install mods from sources you trust.',
          buttons: ['Cancel', 'Install'],
          defaultId: 1,
          cancelId: 0,
        });
        if (response !== 1) throw new Error('Not installed (cancelled).');
        const done = await installZip(dir, tmp);
        send('installed', { filename, done });
      } catch (err) {
        send('installed', { filename, error: err.message });
      } finally {
        rmSync(tmp, { force: true });
      }
    });
  });
  browser.on('closed', () => (browser = null));
  browser.loadURL(url);
}

// Check the links every 10 minutes while the app is open. With auto-sync on, changes install by themselves only when
// every one is a Thunderstore mod that passed all the safety checks (or was approved before); otherwise the player is
// asked to review them.
setInterval(async () => {
  if (!settings.links.length || pending.length) return;
  try {
    const st = await state();
    const changed = (l) => l.ok && l.plan && l.plan.add.length + l.plan.update.length + l.plan.remove.length + (l.plan.needsBepInEx ? 1 : 0) > 0;
    // Valheim: nothing changes behind the player's back while they're playing vanilla, or while the game runs.
    const valheim = gameDir() && activeProfile() !== VANILLA && !valheimRunning() && st.links.some((l) => l.game === 'valheim' && changed(l));
    const java = st.links.some((l) => l.game === 'java' && changed(l));
    if (!valheim && !java) return;
    if (!settings.autoSync) return send('state-changed');
    for (const game of [valheim && 'valheim', java && 'java'].filter(Boolean)) {
      const list = await prepareAll(game);
      if (list.every((p) => canAuto(p, approvedSet()))) send('auto-synced', await applyPending());
      else {
        send('needs-review', { review: reviewOf(list), game });
        break; // one review at a time
      }
    }
    send('state-changed');
  } catch {}
}, 10 * 60_000);

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
