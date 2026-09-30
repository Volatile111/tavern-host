const $ = (id) => document.getElementById(id);
const api = window.modsync;
let st = null;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

let toastTimer;
function toast(msg, bad = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = `show${bad ? ' bad' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ''), 4500);
}

function log(line) {
  const box = $('log');
  const row = el('div', null, `${new Date().toLocaleTimeString()}  ${line}`);
  box.prepend(row);
  while (box.childElementCount > 200) box.lastChild.remove();
}

async function busy(btn, label, fn) {
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = label;
  try {
    return await fn();
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

async function refresh() {
  try {
    st = await api.state();
  } catch (err) {
    return toast(err.message, true);
  }
  render();
}

function render() {
  $('appVersion').textContent = st.version ? `v${st.version}` : '';
  const beta = document.createElement('span');
  beta.className = 'beta-badge';
  beta.textContent = 'Beta';
  beta.title = 'Tavern Client Mod Manager is in beta: it is actively being worked on and updates are frequent.';
  $('appVersion').appendChild(beta);
  // Game
  const g = $('gameInfo');
  g.innerHTML = '';
  if (!st.gameDir) {
    g.append(el('p', 'warn', "Valheim wasn't found automatically."));
    const pick = el('button', 'primary', 'Choose the Valheim folder…');
    pick.addEventListener('click', async () => {
      try {
        if (await api.pickFolder()) refresh();
      } catch (err) {
        toast(err.message, true);
      }
    });
    g.append(pick);
  } else {
    const line = el('div', 'row');
    line.append(el('code', 'path', st.gameDir));
    const open = el('button', 'small ghost', 'Open');
    open.addEventListener('click', () => api.openFolder('game'));
    const change = el('button', 'small ghost', 'Change…');
    change.addEventListener('click', async () => {
      try {
        if (await api.pickFolder()) refresh();
      } catch (err) {
        toast(err.message, true);
      }
    });
    line.append(open, change);
    g.append(line);
    if (st.bepinex?.installed) {
      g.append(
        st.loaderOn === false
          ? el('p', 'muted', `BepInEx ${st.bepinex.version} is installed but switched off: Valheim starts vanilla (profile "Vanilla").`)
          : el('p', 'ok', `✔ BepInEx ${st.bepinex.version} installed (mods are on).`),
      );
    }
    else {
      const p = el('p', 'muted', 'BepInEx (the mod loader) is not installed yet. It is installed automatically when you sync or add a mod, or now:');
      const b = el('button', 'small primary', 'Install BepInEx');
      b.addEventListener('click', () =>
        busy(b, 'Installing…', async () => {
          try {
            await api.installBepInEx();
            toast('BepInEx installed');
            refresh();
          } catch (err) {
            toast(err.message, true);
          }
        }),
      );
      g.append(p, b);
    }
    if (st.running) g.append(el('p', 'warn', 'Valheim is running. Close it before syncing or changing mods.'));
  }
  $('autoSync').checked = st.autoSync;
  renderProfiles();
  renderNexus();

  // Server links
  const links = $('links');
  links.innerHTML = '';
  if (!st.links.length) links.append(el('p', 'muted small', 'No servers yet.'));
  for (const l of st.links) {
    const box = el('div', `link ${l.ok ? '' : 'bad'}`);
    const head = el('div', 'row');
    head.append(el('b', null, l.server ?? 'Server'));
    if (l.ok) {
      const p = l.plan;
      const changes = p ? p.add.length + p.update.length + p.remove.length + (p.needsBepInEx ? 1 : 0) : 0;
      head.append(el('span', `pill ${changes ? 'todo' : 'ok'}`, changes ? `${changes} change${changes === 1 ? '' : 's'} to sync` : '✔ matched'));
    } else head.append(el('span', 'pill bad', 'unreachable'));
    const rm = el('button', 'small ghost', 'Remove');
    rm.addEventListener('click', async () => {
      if (!confirm(`Stop following ${l.server ?? 'this server'}? Mods already installed stay.`)) return;
      await api.removeLink(l.raw);
      refresh();
    });
    head.append(el('span', 'spacer'), rm);
    box.append(head);
    if (!l.ok) box.append(el('div', 'error small', l.error));
    else {
      const p = l.plan;
      const details = [];
      if (p?.needsBepInEx) details.push('install BepInEx');
      for (const m of p?.add ?? []) details.push(`+ ${m.name} ${m.version}`);
      for (const m of p?.update ?? []) details.push(`↑ ${m.name} ${m.from} → ${m.version}`);
      for (const m of p?.remove ?? []) details.push(`− ${m.name}`);
      box.append(el('div', 'muted small', `${l.manifest.mods.length} mod${l.manifest.mods.length === 1 ? '' : 's'} for players${details.length ? ` · ${details.join(' · ')}` : ''}`));
      if (!l.manifest.mods.length) {
        box.append(el('div', 'warn small', "This server isn't sharing any mods right now. If it should be, the owner can see why in Tavern Host → Mods → Share mods with players (for example mods added with another mod manager need taking over first)."));
      }
    }
    links.append(box);
  }

  // Mods
  const mods = $('mods');
  mods.innerHTML = '';
  $('modCount').textContent = st.mods.length ? String(st.mods.length) : '';
  if (!st.mods.length && !st.loose.length) mods.append(el('p', 'muted small', 'No mods installed yet.'));
  const sorted = [...st.mods].sort((a, b) => Number(b.fromServer) - Number(a.fromServer) || a.name.localeCompare(b.name));
  for (const m of sorted) {
    const row = el('div', `mod${m.enabled ? '' : ' off'}`);
    const info = el('div');
    const name = el('div', 'name', m.name.replace(/_/g, ' '));
    name.append(el('span', `badge ${m.fromServer ? 'server' : 'own'}`, m.fromServer ? 'from server' : 'my mod'));
    if (m.asDependency) name.append(el('span', 'badge', 'dependency'));
    const from = m.source === 'hexium' ? ' · from Hexium' : m.namespace === 'Nexus' ? ' · from Nexus Mods' : m.source === 'upload' ? ' · own file' : '';
    info.append(name, el('div', 'muted small', `v${m.version} · by ${m.namespace}${from}${m.description ? ` · ${m.description}` : ''}`));
    row.append(info);
    const actions = el('div', 'row tight');
    if (m.fromServer) actions.append(el('span', 'muted small', 'managed by the server'));
    else {
      const lab = el('label', 'toggle');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = m.enabled;
      cb.addEventListener('change', async () => {
        try {
          await api.toggleMod(m.full, cb.checked);
          refresh();
        } catch (err) {
          toast(err.message, true);
          cb.checked = !cb.checked;
        }
      });
      lab.append(cb, document.createTextNode(' On'));
      if (updates[m.full]) {
        const up = el('button', 'small primary', `↑ Update to ${updates[m.full]}`);
        up.addEventListener('click', () =>
          busy(up, 'Updating…', async () => {
            try {
              (await api.updateMod(m.full)).forEach(log);
              delete updates[m.full];
              toast(`${m.name.replace(/_/g, ' ')} updated`);
            } catch (err) {
              toast(err.message, true);
            }
            refresh();
          }),
        );
        actions.append(up);
      }
      const rm = el('button', 'small danger', 'Remove');
      rm.addEventListener('click', async () => {
        if (!confirm(`Remove ${m.name}?`)) return;
        try {
          await api.removeMod(m.full);
          refresh();
        } catch (err) {
          toast(err.message, true);
        }
      });
      actions.append(lab, rm);
    }
    row.append(actions);
    mods.append(row);
  }
  for (const f of st.loose) {
    const row = el('div', 'mod');
    row.append(el('div', null, f), el('span', 'muted small', 'added by hand (BepInEx/plugins)'));
    mods.append(row);
  }
}

// ---------- profiles ----------

const vanilla = () => st?.activeProfile === 'vanilla';

function renderProfiles() {
  const box = $('profiles');
  box.innerHTML = '';
  const chip = (id, name, sub, extra = '') => {
    const b = el('button', `profile-chip${extra}${st.activeProfile === id ? ' active' : ''}`);
    b.append(el('span', null, `${st.activeProfile === id ? '● ' : ''}${name}`), el('span', 'sub', sub));
    b.disabled = st.running || !st.gameDir;
    b.title = st.running ? 'Close Valheim to switch profiles' : '';
    b.addEventListener('click', async () => {
      if (st.activeProfile === id) return;
      try {
        await api.switchProfile(id);
        toast(`Switched to ${name}`);
      } catch (err) {
        toast(err.message, true);
      }
      refresh();
    });
    box.append(b);
  };
  chip('vanilla', 'Vanilla', 'no mods', ' vanilla');
  for (const p of st.profiles) chip(p.id, p.name, p.off ? `${p.off} mod${p.off === 1 ? '' : 's'} off` : 'all mods on');
  // Rename/delete the active modded profile.
  const actions = $('profileActions');
  actions.innerHTML = '';
  const current = st.profiles.find((p) => p.id === st.activeProfile);
  if (current) {
    const rename = el('button', 'small ghost', 'Rename');
    rename.addEventListener('click', () => nameBox('Rename to', current.name, async (name) => api.renameProfile(current.id, name)));
    const del = el('button', 'small danger', 'Delete');
    del.disabled = st.profiles.length <= 1;
    del.title = del.disabled ? 'Keep at least one modded profile' : '';
    del.addEventListener('click', async () => {
      if (!confirm(`Delete the profile "${current.name}"? Your mods stay installed.`)) return;
      try {
        await api.deleteProfile(current.id);
      } catch (err) {
        toast(err.message, true);
      }
      refresh();
    });
    actions.append(rename, del);
  }
  // Play button colour/label follow the profile.
  $('btnPlay').textContent = vanilla() ? '▶ Play Valheim (vanilla)' : '▶ Play Valheim';
  $('btnPlay').classList.toggle('vanilla', vanilla());
}

/** A small inline name box under the profiles (Electron has no prompt()). */
function nameBox(label, value, save) {
  const actions = $('profileActions');
  actions.innerHTML = '';
  const form = el('form', 'row');
  const input = el('input');
  input.value = value;
  input.placeholder = 'Profile name';
  input.maxLength = 40;
  const ok = el('button', 'small primary', label === 'Rename to' ? 'Rename' : 'Create');
  ok.type = 'submit';
  const cancel = el('button', 'small ghost', 'Cancel');
  cancel.type = 'button';
  cancel.addEventListener('click', () => renderProfiles());
  form.append(el('span', 'muted small', label), input, ok, cancel);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await save(input.value);
      refresh();
    } catch (err) {
      toast(err.message, true);
    }
  });
  actions.append(form);
  input.focus();
  input.select();
}

$('btnNewProfile').addEventListener('click', () =>
  nameBox('New profile (starts with the mods that are on now):', '', async (name) => {
    await api.createProfile(name);
    toast(`Created and switched to ${name.trim()}`);
  }),
);

// ---------- Nexus Mods ----------

function renderNexus() {
  const n = st.nexus;
  $('nexusStatus').textContent = n ? `· linked as ${n.name}${n.premium ? ' (Premium)' : ''}` : '· no API key (Manual download only)';
  $('nexusKeyRemove').hidden = !n;
  $('nexusKeyInput').placeholder = n ? 'Replace the saved key' : 'Nexus Mods API key';
}

$('btnNexus').addEventListener('click', () => api.browseNexus());
$('btnHexium').addEventListener('click', () => api.browseHexium());

// Updating the app itself from a new installer (Tavern-Client-Mod-Manager-Setup-x.y.z.exe).
$('btnUpdateApp').addEventListener('click', async (e) => {
  e.preventDefault();
  try {
    const picked = await api.pickUpdate();
    if (!picked) return;
    const cmp = picked.version.split('.').map(Number).reduce((r, n, i) => r || n - (picked.current.split('.').map(Number)[i] ?? 0), 0);
    const note = cmp > 0 ? '' : cmp === 0 ? '\n\nThat is the version you already have (it will be reinstalled).' : '\n\nThat is an OLDER version than the one you have.';
    if (!confirm(`Update Tavern Client Mod Manager from ${picked.current} to ${picked.version || 'the version in that file'}?${note}\n\nThe app closes, an "Updating" window shows the progress, and the new version opens by itself. Your mods and settings are kept.`)) return;
    await api.runUpdate();
    toast('Updating… watch the "Updating" window');
  } catch (err) {
    toast(err.message, true);
  }
});

// New versions of this app (GitHub releases): a banner when one is out, checked at start and every 6 hours.
let appUpdate = null;
async function checkAppUpdate(force = false) {
  try {
    appUpdate = await api.appUpdate(force);
  } catch (err) {
    if (force) toast(err.message, true);
    return;
  }
  const u = appUpdate;
  $('updateBanner').hidden = !u.available;
  $('updateText').textContent = u.available ? `Tavern Client Mod Manager ${u.latest} is available (you have ${u.current}).` : '';
  $('btnInstallAppUpdate').hidden = !u.canInstall;
  $('aboutUpdate').textContent = u.available
    ? `Version ${u.latest} is available.`
    : u.error
      ? `Couldn't check for updates: ${u.error}`
      : u.latest
        ? `You have the latest version.`
        : 'No releases have been published yet.';
  if (force && !u.available && !u.error) toast('You have the latest version');
}
checkAppUpdate();
setInterval(() => checkAppUpdate(), 6 * 3600_000);

$('updateNotes').addEventListener('click', (e) => {
  e.preventDefault();
  if (appUpdate?.notes) alert(`What's new in ${appUpdate.latest}:\n\n${appUpdate.notes}`);
  else window.open(appUpdate?.url ?? 'https://github.com/Volatile111/tavern-client-releases/releases');
});

api.on('update-progress', (p) => {
  const mb = (n) => (n / 1048576).toFixed(1);
  $('btnInstallAppUpdate').textContent = p.total ? `Downloading ${mb(p.received)} / ${mb(p.total)} MB…` : `Downloading ${mb(p.received)} MB…`;
});

$('btnInstallAppUpdate').addEventListener('click', async () => {
  if (!appUpdate?.available) return;
  if (!confirm(`Update to ${appUpdate.latest}?\n\nIt downloads from GitHub, then the app closes, an "Updating" window shows the progress, and the new version opens by itself. Your mods and settings are kept.`)) return;
  const btn = $('btnInstallAppUpdate');
  btn.disabled = true;
  try {
    await api.installAppUpdate();
    btn.textContent = 'Installing…';
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Update now';
    toast(err.message, true);
  }
});

$('btnAbout').addEventListener('click', (e) => {
  e.preventDefault();
  const v = st?.version ?? '';
  $('aboutVersion').textContent = v ? `v${v}` : '';
  // The bug report form fills in which app and version by itself.
  $('aboutReport').href = `https://github.com/Volatile111/tavern-host/issues/new?template=bug_report.yml&app=${encodeURIComponent('Tavern Client Mod Manager')}&version=${encodeURIComponent(v)}`;
  $('aboutDialog').showModal();
});
$('aboutClose').addEventListener('click', () => $('aboutDialog').close());
$('btnCheckAppUpdate').addEventListener('click', () => busy($('btnCheckAppUpdate'), 'Checking…', () => checkAppUpdate(true)));

// Updates for the player's own mods (Thunderstore / Hexium); mods from a server follow the server.
let updates = {};
$('btnCheckUpdates').addEventListener('click', () =>
  busy($('btnCheckUpdates'), 'Checking…', async () => {
    try {
      updates = await api.checkUpdates();
      const n = Object.keys(updates).length;
      toast(n ? `${n} update${n === 1 ? '' : 's'} available` : 'Your mods are up to date');
      render();
    } catch (err) {
      toast(err.message, true);
    }
  }),
);
$('nexusKeyForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const key = $('nexusKeyInput').value.trim();
  if (!key) return;
  await busy(e.submitter, 'Checking…', async () => {
    try {
      const user = await api.setNexusKey(key);
      $('nexusKeyInput').value = '';
      toast(`Nexus Mods linked as ${user.name}${user.premium ? ' (Premium)' : ''}`);
      refresh();
    } catch (err) {
      toast(err.message, true);
    }
  });
});
$('nexusKeyRemove').addEventListener('click', async () => {
  if (!confirm('Remove the saved Nexus Mods API key from this PC?')) return;
  await api.setNexusKey('');
  toast('Key removed');
  refresh();
});
$('nexusLinkForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('nexusLinkInput').value.trim();
  if (!input) return;
  await busy(e.submitter, 'Installing…', async () => {
    try {
      const hexium = /hexium\.gg\//i.test(input);
      const done = hexium ? await api.installHexium(input) : await api.installNexus(input);
      done.forEach(log);
      $('nexusLinkInput').value = '';
      toast(`Installed from ${hexium ? 'Hexium' : 'Nexus Mods'}`);
    } catch (err) {
      toast(err.message, true);
    }
  });
  refresh();
});

// ---------- actions ----------

$('linkForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const raw = $('linkInput').value.trim();
  if (!raw) return;
  const ok = confirm(
    'Follow this server?\n\nThe server owner will decide which mods run in your game. Mods are programs that run on your PC, so only follow servers whose owner you trust.\n\nEvery mod is safety-checked before it is installed (Windows Defender, Thunderstore status and a scan for malware-like behaviour). Anything that is not from Thunderstore, or that the check flags, waits for your approval.',
  );
  if (!ok) return;
  const btn = e.submitter;
  await busy(btn, 'Checking…', async () => {
    try {
      const name = await api.addLink(raw);
      $('linkInput').value = '';
      toast(`Following ${name}`);
      log(`Added server ${name}.`);
      await refresh();
    } catch (err) {
      toast(err.message, true);
    }
  });
});

// ---------- sync with review ----------

let afterReview = null; // what to do once the review is closed (e.g. start Valheim)

function scanBadge(scan) {
  const cls = scan.verdict === 'clean' ? 'ok' : scan.verdict === 'blocked' ? 'bad' : 'todo';
  const label = scan.verdict === 'clean' ? '✔ passed checks' : scan.verdict === 'blocked' ? '⛔ blocked' : '⚠ needs review';
  return el('span', `pill ${cls}`, label);
}

function showReview(review) {
  const body = $('reviewBody');
  body.innerHTML = '';
  let needsTick = 0;
  for (const srv of review) {
    body.append(el('h3', null, srv.server));
    if (srv.bepinex) {
      const row = el('div', 'change');
      row.append(el('div', 'name', `Install BepInEx ${srv.bepinex.version} (the mod loader)`), scanBadge(srv.bepinex.scan));
      body.append(row);
    }
    for (const c of srv.changes) {
      const row = el('div', `change ${c.blocked ? 'blocked' : ''}`);
      const info = el('div');
      const title = el('div', 'name', `${c.action === 'add' ? '+ Add' : '↑ Update'} ${c.name} ${c.from ? `${c.from} → ` : ''}${c.version}`);
      title.append(el('span', `badge ${c.source === 'upload' ? 'own' : ''}`, c.source === 'upload' ? 'not on Thunderstore' : c.source === 'hexium' ? `by ${c.author} · Hexium` : `by ${c.author}`));
      info.append(title, el('div', 'muted small', c.scan.summary));
      for (const f of c.scan.flags) info.append(el('div', `small ${f.level === 'high' ? 'error' : 'warn'}`, `${f.level === 'high' ? '⛔' : '⚠'} ${f.text}${f.file ? ` (${f.file})` : ''}`));
      if (c.source === 'upload' && !c.scan.flags.length) info.append(el('div', 'small warn', '⚠ Uploaded by the server owner, not from Thunderstore: nobody else has checked it.'));
      row.append(info);
      const right = el('div', 'change-right');
      right.append(scanBadge(c.scan));
      if (c.blocked) right.append(el('span', 'small error', "Won't be installed"));
      else if (c.needsApproval) {
        const lab = el('label', 'toggle small');
        const cb = el('input');
        cb.type = 'checkbox';
        cb.dataset.key = c.key;
        cb.checked = c.approvedBefore;
        if (!c.approvedBefore) needsTick++;
        lab.append(cb, document.createTextNode(c.approvedBefore ? ' Approved before' : ' I trust this mod'));
        right.append(lab);
      }
      row.append(right);
      body.append(row);
    }
    for (const r of srv.removals) body.append(el('div', 'change', `− Remove ${r} (the server no longer uses it)`));
    for (const u of srv.unavailable ?? []) body.append(el('div', 'change blocked', `⚠ Can't download ${u}. Ask the server owner to check it in Tavern Host (Mods → Share mods with players). The other mods still install.`));
  }
  $('reviewNote').textContent = needsTick ? 'Unticked mods are skipped (the others are still installed).' : '';
  $('reviewDialog').showModal();
}

async function prepareAndReview(thenLaunch) {
  const btn = thenLaunch ? $('btnPlay') : $('btnSync');
  await busy(btn, 'Checking…', async () => {
    try {
      // Vanilla: just start the game (no syncing into a game that won't load the mods anyway).
      if (thenLaunch && vanilla()) {
        await api.launch();
        return;
      }
      if (!st?.links.length) {
        if (thenLaunch) await api.launch();
        else toast('Add a server link first');
        return;
      }
      const r = await api.prepare();
      if (!r.changes) {
        const empty = st.links.filter((l) => l.ok && !l.manifest.mods.length).map((l) => l.server);
        log(empty.length ? `${empty.join(', ')} isn't sharing any mods right now.` : 'Your mods already match the server.');
        if (thenLaunch) await api.launch();
        else toast(empty.length ? `${empty.join(', ')} isn't sharing any mods (the owner can check why in Tavern Host)` : 'Already up to date', !!empty.length);
        return;
      }
      afterReview = thenLaunch ? () => api.launch() : null;
      showReview(r.review);
    } catch (err) {
      toast(err.message, true);
    }
  });
  refresh();
}

$('reviewApply').addEventListener('click', async () => {
  const approve = [...$('reviewBody').querySelectorAll('input[data-key]:checked')].map((c) => c.dataset.key);
  $('reviewApply').disabled = true;
  try {
    const summary = await api.apply(approve);
    toast('Mods updated');
    $('reviewDialog').close();
    if (afterReview) await afterReview();
    summary.forEach(log);
  } catch (err) {
    toast(err.message, true);
  } finally {
    $('reviewApply').disabled = false;
    afterReview = null;
    refresh();
  }
});
$('reviewCancel').addEventListener('click', async () => {
  await api.cancel();
  $('reviewDialog').close();
  afterReview = null;
  log('Sync cancelled; nothing was installed.');
});

$('btnSync').addEventListener('click', () => prepareAndReview(false));
$('btnPlay').addEventListener('click', () => prepareAndReview(true));
api.on('needs-review', (r) => {
  toast('A server added or changed mods: please review them');
  afterReview = null;
  showReview(r.review);
});

$('autoSync').addEventListener('change', () => api.setAuto($('autoSync').checked));
$('btnBrowse').addEventListener('click', () => api.browse());
$('btnPlugins').addEventListener('click', () => api.openFolder('plugins'));

async function installFiles(files) {
  for (const f of files) {
    try {
      const done = await api.installFile(f);
      done.forEach((d) => log(d));
      toast(`Installed ${f.name}`);
    } catch (err) {
      toast(`${f.name}: ${err.message}`, true);
    }
  }
  refresh();
}
$('fileInput').addEventListener('change', () => {
  installFiles([...$('fileInput').files]);
  $('fileInput').value = '';
});
for (const evt of ['dragenter', 'dragover']) $('drop').addEventListener(evt, (e) => (e.preventDefault(), $('drop').classList.add('over')));
for (const evt of ['dragleave', 'drop']) $('drop').addEventListener(evt, () => $('drop').classList.remove('over'));
$('drop').addEventListener('drop', (e) => {
  e.preventDefault();
  installFiles([...e.dataTransfer.files]);
});

api.on('log', log);
api.on('installed', (r) => {
  if (r.error) toast(`${r.filename}: ${r.error}`, true);
  else {
    r.done.forEach(log);
    toast(`Installed ${r.filename}`);
  }
  refresh();
});
api.on('auto-synced', (summary) => {
  summary.forEach(log);
  toast('Your mods were updated to match the server');
  refresh();
});
api.on('state-changed', refresh);

// ---------- colour theme (hue picker, bottom-left; same as Tavern Host) ----------

const DEFAULT_HUE = 32; // tavern amber
const PRESET_HUES = [32, 0, 50, 95, 145, 185, 210, 265, 300, 330];
let logoImage = null;

function loadHue() {
  try {
    const v = localStorage.getItem('tcmm-hue');
    return v !== null && Number.isFinite(Number(v)) ? Number(v) : DEFAULT_HUE;
  } catch {
    return DEFAULT_HUE;
  }
}

/** The logo recoloured to the hue, for the window/taskbar icon. */
async function recolouredIcon(hue) {
  if (!logoImage) {
    logoImage = new Image();
    logoImage.src = 'icon.png';
    await logoImage.decode();
  }
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext('2d');
  ctx.filter = `hue-rotate(${hue - DEFAULT_HUE}deg)`;
  ctx.drawImage(logoImage, 0, 0, 256, 256);
  return canvas.toDataURL('image/png');
}

let iconTimer;
function applyHue(hue, save = true) {
  document.documentElement.style.setProperty('--hue', String(hue));
  $('themeHue').value = String(hue);
  if (save) {
    try {
      localStorage.setItem('tcmm-hue', String(hue));
    } catch {}
  }
  clearTimeout(iconTimer);
  iconTimer = setTimeout(async () => {
    try {
      api.setIcon(await recolouredIcon(hue));
    } catch {}
  }, 250);
}

for (const hue of PRESET_HUES) {
  const b = el('button');
  b.type = 'button';
  b.title = hue === DEFAULT_HUE ? 'Tavern amber' : `Hue ${hue}`;
  b.style.background = `hsl(${hue} 84% 55%)`;
  b.addEventListener('click', () => applyHue(hue));
  $('themeSwatches').appendChild(b);
}
$('themeHue').addEventListener('input', () => applyHue(Number($('themeHue').value)));
$('themeReset').addEventListener('click', () => applyHue(DEFAULT_HUE));
$('btnTheme').addEventListener('click', (e) => {
  e.stopPropagation();
  $('themePop').hidden = !$('themePop').hidden;
  $('btnTheme').setAttribute('aria-expanded', String(!$('themePop').hidden));
});
document.addEventListener('click', (e) => {
  if (!$('themePop').hidden && !e.target.closest('.theme-corner')) {
    $('themePop').hidden = true;
    $('btnTheme').setAttribute('aria-expanded', 'false');
  }
});
applyHue(loadHue(), false);

refresh();
