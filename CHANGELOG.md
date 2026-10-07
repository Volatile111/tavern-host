# Changelog

## Tavern Client Mod Manager 0.5.2

**Fixed**
- 0.5.1 wouldn't open: it stopped with "A JavaScript error occurred in the main process" (Cannot find module … bepinex-config.js) because a file was left out of the installer. If you have 0.5.1, download and run this installer; the app can't update itself while it won't start.

## Tavern Host 0.6.1

**New**
- **Mod settings for Valheim servers.** Mods with a settings file (BepInEx/config) get a **Settings** button on the Mods tab once the server has started with them. Every setting is shown with its description, default and allowed values; saving changes only those lines in the file, and the mod uses them at the next restart. Files Tavern Host can't match to a mod are listed under **Other mod settings files**.
- **Send settings to players.** Tick **To players** on a setting and players' Tavern Client Mod Manager (0.5.1 or newer) sets it to the server's value in their own game every time they sync. That's how settings that only work on the player's side are set from the server, for example Server devcommands' automatic debug, god and fly mode for admins (devcommands only switch on for players on the server's admin list). Anyone with the share link can see those values, so don't send passwords or keys.
- Seeing and changing mod settings needs **Manage mods** (settings files can hold webhooks or passwords). Changes are written to the activity log.

## Tavern Client Mod Manager 0.5.1

**New**
- **Mod settings from the server.** When a Valheim server's owner sends mod settings (Tavern Host 0.6.1), syncing sets them in your game's config files. Only those settings change; the rest of each file stays yours. The review shows each one before it's applied.
- A server can only change values in mods' settings files: never BepInEx's own settings, and nothing outside the BepInEx config folder.

## Tavern Host 0.6.0

**New**
- **Create and import servers on your nodes** from the main panel: **+ New** and **Import** have a System choice (this system or any node). The games and versions come from that node, it downloads and installs the server itself, and the server shows under it in the list.
- **BungeeCord networks.** BungeeCord proxies get a Plugins tab (BungeeCord plugins, with a warning for Bukkit/Paper plugins that belong on the servers behind it) and, in Settings, **Servers behind this proxy**: add any of your Tavern Host Minecraft Java servers (on this system or a node) with the address filled in, choose where players land first, or remove one. Only that part of config.yml changes. Optionally sets a Paper/Spigot server up for the proxy (bungeecord: true, online-mode=false), with a warning to keep it reachable only through the proxy.
- **Space Engineers servers.** Installed and updated with SteamCMD. Tavern Host writes its settings (name, world, scenario for a new world, game mode, players, ports) into SpaceEngineers-Dedicated.cfg and keeps everything else in it, and uses the game's Remote API for live players, chat warnings before restarts and updates, and a clean stop. Steam Workshop mods are added by link or ID on the Mods tab (players' games download them by themselves); Admins and Banned lists by Steam ID, applied straight away while the server runs.
- **Satisfactory servers.** Installed and updated with SteamCMD. Tavern Host works with Satisfactory's own server tools instead of duplicating them: it claims a new server with your admin password, creates the first game (starting location, session name), and stops cleanly (save, then shut down) through the server's API; the overview shows the session, players, tech tier and tick rate, and console commands go through the API. Saves, sessions and the rest stay in the in-game Server Manager. Mods are managed with Satisfactory Mod Manager (it supports this server folder and players' games); the Mods tab lists them with links whose Install button opens SMM.
- **Terraria (vanilla) servers**, separate from tModLoader ones (vanilla and modded players can't join each other's servers): the official dedicated server from terraria.org, with the same world settings, Console, kick/ban, countdowns, backups and automatic updates. The install also puts on Microsoft's XNA Framework 4.0, which the Windows server needs (Windows asks for admin once).
- **Terraria (tModLoader) servers.** Create one with **+ New**: Tavern Host downloads tModLoader from its official GitHub releases (checksum-checked) and the .NET runtime it needs, creates the world (size, difficulty, seed), and runs it with the Console tab, commands, kick/ban, countdowns, backups and automatic tModLoader updates. Stop saves the world first. Add mods as .tmod files on the Mods tab; players' games download the server's mods by themselves when they join.
- **Bedrock addon updates from CurseForge.** Addons installed from CurseForge are linked to their project automatically; for others (from MCPEDL or elsewhere), use **Link to CurseForge…** on the addon. **Check for updates** then finds newer files, on the channel you pick: releases only, releases + beta, or releases + beta + alpha (betas and alphas only when they're newer than the newest release). **Update automatically** checks every 6 hours and installs them by itself (loaded at the next restart). Needs a CurseForge API key in Settings → Integrations.
- **Valheim world modifiers, fully customisable**, like a .bat file: start from any difficulty preset and change any modifier on top of it, now including **Normal** (e.g. Hardcore with a normal death penalty). The world settings are grouped under **World modifiers** in Settings, and **Other world keys** passes any other key with -setkey (e.g. nocraftcost, skillgainrate 200).
- Valheim with crossplay on: Tavern Host explains that the local IP can't be used to join (Valheim's crossplay only finds the server by its public address), and what to use instead.
- **Share links for every game** (Mods tab → Share mods with players), for the Tavern Client Mod Manager 0.5.0:
  - **Minecraft Java (Fabric, Forge, NeoForge)**: players' app sets up the same loader in their Minecraft Launcher, in a separate profile, and keeps the mods matched with the server. Each mod has **Server + players** or **Server only** (mods that say they're server-side only start as Server only).
  - **Satisfactory**: players see the server's mods with versions, each one opening in Satisfactory Mod Manager.
  - **Bedrock, Terraria (tModLoader), Space Engineers and Minecraft servers without mods**: these games download what they need when a player joins, so the link gives the join details.

**Fixed**
- Security: Tavern Vault calls that would hand out something secret (for example an encryption recovery key, a password or a token) always need **Manage storage**, even when they're named like a read-only call.

## Tavern Client Mod Manager 0.5.0

**New**
- **More games.** Server links now work for Valheim, Minecraft Java, Satisfactory, Minecraft Bedrock, Terraria (tModLoader) and Space Engineers servers (from Tavern Host 0.6.0). Paste any link in **Add a server**; each game has its own tab.
- **Minecraft Java (Fabric, Forge, NeoForge)**: each modded server gets its own Minecraft Launcher profile and folder, so its mods never mix with your other worlds. The server's mods are added, updated and removed with it; jars you add to that folder yourself are left alone. The server is in Multiplayer straight away. Fabric is set up automatically; for Forge and NeoForge the app gives you the right installer to run once.
- Minecraft mods are checked before they're installed: Windows Defender, and whether Modrinth has the exact same file. Files Modrinth doesn't know wait for your approval.
- **Satisfactory**: the server's mods with versions, each opening in Satisfactory Mod Manager to install.
- **Other games**: the server's address to copy, and how the game gets its mods.

**Fixed**
- Sync results no longer show twice in Activity.

## Tavern Host 0.5.3

**Improved**
- Storage works with everything new in Tavern Vault 0.3 (drive health, burn-in, hot spares, snapshots, backups, bay map, capacity forecasts, speed, encryption, moving data, TrueNAS and the health report). People with **See storage** can open all of its read-only pages; changes still need **Manage storage**.
- Things only the Tavern Vault window on that PC can do (its file pickers, saving files, node mode, its direct link, updating it) now say so clearly instead of failing.

## Tavern Host 0.5.2

**Fixed**
- Valheim: Kall no longer shows as defeated just because a world has a defeat marker Tavern Host doesn't recognise (older worlds and mods can carry other ones). Kall shows as unknown ("?") instead, with the marker named when you hover it.
- Storage changes made through a node link are logged with that link's own key name too, so a key can't make its changes look like someone else's.

## Tavern Host 0.5.1

**New**
- **Storage is now a switch**: Settings → Storage (Tavern Vault), off until you turn it on. It covers showing storage here and sharing this system's storage with a main panel. The "needs Tavern Vault" notes live there too, with each system's state (this system and every node).
- A system gets a **Storage** entry in the list on the left only when Tavern Vault is actually connected there. A main panel without Tavern Vault of its own no longer shows Storage for itself.
- **Systems with only Tavern Vault** (no Tavern Host) can be added as nodes: Tavern Vault makes its own code (thvault://…) in its Settings → Node mode; paste it into Settings → Nodes as usual. They show with their Storage. Needs Tavern Vault 0.2.0 or newer there.
- **The panel's name follows what it does**:
  - **Tavern Master**: manages other systems (nodes) and has no game servers or Tavern Vault of its own.
  - **Tavern Super**: manages other systems and has its own game servers or Tavern Vault too.
  - **Tavern Node**: another panel uses this system as a node (its node code has been used).
  - **Tavern Super Node**: a node with Tavern Vault on it.
  - **Tavern Host**: none of the above.
  The name shows in the header, the window title and the login screen, and changes by itself.

## Tavern Host 0.5.0

**New**
- **Storage, with Tavern Vault.** Each system in the list on the left now has a **Storage** entry: its drive pools (Storage Spaces), SnapRAID arrays, drive health and schedules, with everything Tavern Vault can do (create, grow and repair pools, replace drives, run SnapRAID…). This needs **Tavern Vault**, a separate app, on the system that has the drives, with its Node mode turned on. Without it, Storage explains what to install.
- Storage works for nodes too, through the same node link: a node's storage shows under it on the main panel. The main panel doesn't need Tavern Vault itself. Nodes need Tavern Host 0.5.0 or newer.
- New permissions: **See storage** and **Manage storage** (Manage can destroy data; it's marked as dangerous). Admins get both. Node links made before 0.5.0 get them automatically, once (noted in the activity log).
- Settings has a new **Storage (Tavern Vault)** section showing whether Tavern Vault is connected on this system.
- Storage changes made through Tavern Host show in Tavern Vault's activity log with who made them, and in Tavern Host's activity log. Tavern Vault's practice mode and safety checks apply exactly as in its own window.

## Tavern Host 0.4.3

**New**
- After an update, Tavern Host shows what's new in the version you just got (once).
- Every step of an update is written to update.log in Tavern Host's data folder, so a failed update can be traced.

## Tavern Host 0.4.2

**Fixed**
- Installing an update from inside Tavern Host closed the app without installing anything (and didn't reopen it). The update now installs and Tavern Host opens again by itself. If you're on 0.4.0 or 0.4.1, install this version by hand once; updates work from the app after that.
- The downloaded installer is deleted once the update is done.

## Tavern Client Mod Manager 0.4.1

**Fixed**
- **Update now** closed the app without installing anything. The update now installs and the app opens again by itself. If you're on 0.4.0, install this version by hand once; updates work from the app after that.

## Tavern Host 0.4.1

**Fixed**
- Importing a world (.mcworld or .zip) did nothing in the desktop app. The same went for kick/ban reasons, player notes, the countdown before a game update and renaming a node: they now use Tavern Host's own dialog.
- Servers added on a node now show up on the main panel even after the connection to the node dropped quietly (network blip, the node sleeping or restarting). The main panel reconnects by itself and re-checks each node's servers every 2 minutes.
- Port forwarding help for Valheim now says TCP & UDP.

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
