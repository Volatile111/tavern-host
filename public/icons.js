// Server type icons, one per game / Java server type. Minecraft server types, Bedrock and Valheim are original drawings
// (32x32 rounded tiles with a simple symbol); the other games show their own game icon (public/game-icons, from each
// game's Steam client icon or official website), so the server list says at a glance which game it is.

const tile = (bg, inner) =>
  `<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect width="32" height="32" rx="7" fill="${bg}"/>${inner}</svg>`;

/** The game's own icon (public/game-icons/<name>.png). */
const logo = (name) => `<img src="/game-icons/${name}.png" alt="" draggable="false">`;

// A block drawn as an 8x8 pixel grid filling the tile (rows of colour letters).
function pixelBlock(rows, colours) {
  const px = 32 / 8;
  let cells = '';
  rows.forEach((row, y) => [...row].forEach((c, x) => (cells += `<rect x="${x * px}" y="${y * px}" width="${px}" height="${px}" fill="${colours[c]}"/>`)));
  return `<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" shape-rendering="crispEdges"><clipPath id="pb"><rect width="32" height="32" rx="7"/></clipPath><g clip-path="url(#pb)">${cells}</g></svg>`;
}

const ICONS = {
  // Grass block
  vanilla: tile(
    '#3f6b2a',
    '<rect x="6" y="6" width="20" height="20" rx="2" fill="#8a5a36"/><rect x="6" y="6" width="20" height="7" rx="2" fill="#6fbf3b"/><path d="M6 13h3v2h3v-2h3v3h3v-3h3v2h3v-2h2" stroke="#6fbf3b" stroke-width="2" fill="none"/><rect x="11" y="18" width="3" height="3" fill="#6d4427"/><rect x="18" y="21" width="3" height="3" fill="#6d4427"/>',
  ),
  // Bedrock block: a pixel-art face of mottled black, dark grey and light grey
  bedrock: pixelBlock(
    [
      'DKLMDDKM',
      'MLKDMKLD',
      'KDMLKDDL',
      'DLKDMLKM',
      'LMDKLDMK',
      'KDLMDKLD',
      'MKDLKMDL',
      'DLMKDLKM',
    ],
    { D: '#1c1c1c', K: '#3b3b3b', M: '#5a5a5a', L: '#8a8a8a' },
  ),
  // Paper plane
  paper: tile('#1f4f82', '<path d="M6 16 26 7l-5 19-6-6-4 5v-6z" fill="#f4f6fb"/><path d="M15 20 26 7 11 19z" fill="#c9d4e6"/>'),
  // Tap / faucet
  spigot: tile(
    '#8a4b16',
    '<path d="M7 12h12a4 4 0 0 1 4 4v3h-4v-3H7z" fill="#e8e2d6"/><rect x="11" y="8" width="4" height="4" fill="#e8e2d6"/><rect x="9" y="7" width="8" height="2" rx="1" fill="#f3b04a"/><path d="M21 22c0 2 -1.5 3 -1.5 3S18 24 18 22c0-1.3 1.5-3 1.5-3S21 20.7 21 22z" fill="#7cc4ff"/>',
  ),
  // Woven fabric
  fabric: tile(
    '#d9c9a6',
    '<g stroke-width="3" stroke-linecap="round"><path d="M8 11h16M8 16h16M8 21h16" stroke="#8c7853"/><path d="M11 8v16M16 8v16M21 8v16" stroke="#5b4a31" stroke-dasharray="3 2"/></g>',
  ),
  // Anvil
  forge: tile(
    '#6b2f1a',
    '<path d="M6 11h17c0 3-2 5-5 5h-2v3h3v3H13v-3h3v-3h-3c-4 0-7-2-7-5z" fill="#c8ccd2"/><path d="M23 11h3v2h-3z" fill="#c8ccd2"/><circle cx="24" cy="7" r="1.4" fill="#ffb347"/><circle cx="20" cy="6" r="1" fill="#ffd27a"/>',
  ),
  // Anvil with a new spark
  neoforge: tile(
    '#1f3b4d',
    '<path d="M6 11h17c0 3-2 5-5 5h-2v3h3v3H13v-3h3v-3h-3c-4 0-7-2-7-5z" fill="#e6a44a"/><path d="M23 11h3v2h-3z" fill="#e6a44a"/><path d="M24 4l1 2.5L27.5 7 25 8l-1 2.5L23 8l-2.5-1L23 6z" fill="#8fe3ff"/>',
  ),
  // Sponge
  sponge: tile(
    '#6a5a12',
    '<rect x="6" y="8" width="20" height="16" rx="4" fill="#f2d24b"/><circle cx="11" cy="13" r="1.8" fill="#b8962a"/><circle cx="18" cy="12" r="1.3" fill="#b8962a"/><circle cx="21" cy="18" r="2" fill="#b8962a"/><circle cx="13" cy="19" r="1.4" fill="#b8962a"/>',
  ),
  // Proxy network: one hub linking three servers
  bungeecord: tile(
    '#3b2a63',
    '<g stroke="#c9b8ff" stroke-width="2"><path d="M16 12v5M16 17 9 22M16 17l7 5M16 17v5"/></g><circle cx="16" cy="9" r="3.5" fill="#f0eaff"/><rect x="5" y="21" width="7" height="5" rx="1.5" fill="#c9b8ff"/><rect x="12.5" y="21" width="7" height="5" rx="1.5" fill="#c9b8ff"/><rect x="20" y="21" width="7" height="5" rx="1.5" fill="#c9b8ff"/>',
  ),
  // A plain jar (imported server with its own jar)
  custom: tile(
    '#3a4250',
    '<rect x="10" y="7" width="12" height="3" rx="1" fill="#b3bccb"/><path d="M9 11h14v12a3 3 0 0 1-3 3h-8a3 3 0 0 1-3-3z" fill="#dfe5ee"/><rect x="12" y="15" width="8" height="5" rx="1" fill="#8d99ab"/>',
  ),
  // The games' own icons ("terraria" is Terraria with tModLoader: tModLoader's icon).
  terraria: logo('terraria'),
  'terraria-vanilla': logo('terraria-vanilla'),
  satisfactory: logo('satisfactory'),
  spaceengineers: logo('spaceengineers'),
  factorio: logo('factorio'),
  palworld: logo('palworld'),
  enshrouded: logo('enshrouded'),
  sevendays: logo('sevendays'),
  zomboid: logo('zomboid'),
  vrising: logo('vrising'),
  // Horned helmet
  valheim: tile(
    '#4a1f1a',
    '<path d="M9 18a7 7 0 0 1 14 0v3H9z" fill="#b9bec6"/><rect x="8" y="20" width="16" height="3" rx="1" fill="#8e949d"/><rect x="15" y="12" width="2" height="12" fill="#8e949d"/><path d="M9 17C6 16 4.5 12 5 8c2 3 4 4 6 5z" fill="#efe3c8"/><path d="M23 17c3-1 4.5-5 4-9-2 3-4 4-6 5z" fill="#efe3c8"/>',
  ),
};

/** Icon key for a server (Java servers use their type, e.g. "paper"). */
export function iconKey(server) {
  if (server.game === 'java') return ICONS[server.settings?.flavor] ? server.settings.flavor : 'custom';
  return ICONS[server.game] ? server.game : 'custom';
}

/** An element with the server's icon. */
export function serverIcon(server, className = 'srv-icon') {
  const span = document.createElement('span');
  span.className = className;
  span.innerHTML = ICONS[iconKey(server)];
  return span;
}
