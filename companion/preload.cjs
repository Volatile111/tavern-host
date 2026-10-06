// The page gets these functions only, never Node or Electron.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const call = async (name, ...args) => {
  const r = await ipcRenderer.invoke(name, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.data;
};

contextBridge.exposeInMainWorld('modsync', {
  state: () => call('state'),
  addLink: (raw) => call('add-link', String(raw)),
  removeLink: (raw) => call('remove-link', String(raw)),
  /** Downloads and safety-checks every change; returns what the review screen shows. Installs nothing. */
  prepare: (game) => call('prepare', game === 'java' ? 'java' : 'valheim'),
  /** Minecraft: sets up the launcher for a followed server (loader, profile, server list); returns its status. */
  mcSetup: (raw) => call('mc-setup', String(raw)),
  mcOpenFolder: (raw) => call('mc-open-folder', String(raw)),
  /** Opens an allowed outside link (mod pages, loader installers, smmanager://). */
  openExternal: (url) => call('open-external', String(url)),
  /** Installs clean changes plus the ones approved (list of "Author-Mod@version"). */
  apply: (approveNow) => call('apply', Array.isArray(approveNow) ? approveNow.map(String) : []),
  cancel: () => call('cancel'),
  launch: () => call('launch'),
  pickFolder: () => call('pick-folder'),
  openFolder: (which) => call('open-folder', String(which)),
  setAuto: (on) => call('set-auto', !!on),
  installBepInEx: () => call('install-bepinex'),
  toggleMod: (full, on) => call('toggle-mod', String(full), !!on),
  removeMod: (full) => call('remove-mod', String(full)),
  installFile: (file) => call('install-file', webUtils.getPathForFile(file)),
  browse: () => call('browse'),
  browseNexus: () => call('browse-nexus'),
  browseHexium: () => call('browse-hexium'),
  /** Opens the file dialog for a new installer; returns { name, version, current } (or null if cancelled). */
  pickUpdate: () => call('pick-update'),
  runUpdate: () => call('run-update'),
  /** New version of this app on GitHub: { current, latest, available, notes, url, error, canInstall }. */
  appUpdate: (force) => call('app-update', !!force),
  /** Downloads the latest release and installs it (the app closes; the new version opens by itself). */
  installAppUpdate: () => call('install-app-update'),
  installHexium: (input) => call('install-hexium', String(input)),
  /** Newer versions of the player's own mods: { "Author-Mod": "1.2.3" }. */
  checkUpdates: () => call('check-updates'),
  updateMod: (full) => call('update-mod', String(full)),
  switchProfile: (id) => call('switch-profile', String(id)),
  createProfile: (name) => call('create-profile', String(name)),
  renameProfile: (id, name) => call('rename-profile', String(id), String(name)),
  deleteProfile: (id) => call('delete-profile', String(id)),
  /** Saves (after checking with Nexus Mods) or, with '', removes the Nexus API key. */
  setNexusKey: (key) => call('set-nexus-key', String(key)),
  installNexus: (input) => call('install-nexus', String(input)),
  /** Window/taskbar icon from a PNG data URL (the colour-matched logo). */
  setIcon: (dataUrl) => ipcRenderer.invoke('set-icon', String(dataUrl)),
  on: (channel, fn) => {
    if (['log', 'installed', 'auto-synced', 'state-changed', 'needs-review', 'update-progress'].includes(channel)) ipcRenderer.on(channel, (_e, data) => fn(data));
  },
});
