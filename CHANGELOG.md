# Changelog

## Tavern Host 0.4.0

The first public release.

**New**
- Tavern Host updates itself: it tells you when a new version is out (Settings → Update Tavern Host) and installs it for you. Game servers keep running.
- Port forwarding help for every server (🌐 under the server's name): which ports to forward, to which address, and what players outside your network use to join. For Bedrock it spots a missing or outdated `server-udp-ports` line and fixes it in one click.
- A warning when your public IP changes, and when a Bedrock server still has the old one.
- Valheim world modifiers (combat, death penalty, resources, raids, portals), world settings (no build cost, passive enemies, no map, player-based raids), instance ID and extra launch arguments.
- Help button: report a problem (the form fills in your version), what's new, and the licence.
- Permissions shown when making users and API keys now describe every feature.
- The API reference covers every request, and API.md has it for other programs.

**Fixed**
- A backup cut off by Tavern Host closing (e.g. during an update) no longer leaves the server's saving paused.
- Security: removing a hand-added Valheim mod can no longer reach outside the server's plugins folder; the local panel address only answers requests made to 127.0.0.1/localhost.
- Wording: "PC" is now "system" throughout.

## Tavern Client Mod Manager 0.4.0

The first public release.

**New**
- The app updates itself: a banner tells you when a new version is out, and **Update now** installs it. Your mods and settings are kept.
- About & help: report a problem, what's new, check for updates, and update from a file.
- A link to get Tavern Host, for players who want to run their own server.

**Fixed**
- Security: a server's shared mod list is checked before anything is installed or removed, so a list with unusual names can't touch folders outside Valheim.
