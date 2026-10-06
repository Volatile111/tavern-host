# Tavern Host

> **Beta:** Tavern Host and Tavern Client Mod Manager are both in beta. They're actively being worked on and updates are frequent, so expect changes and the odd rough edge. Please report problems on the [Issues](https://github.com/Volatile111/tavern-host/issues) page (or **Help → Report a problem** in either app).

Tavern Host is a Windows app for running your own game servers from one panel. It supports Minecraft Bedrock, Minecraft Java (including BungeeCord networks), Valheim, Terraria (vanilla and tModLoader), Satisfactory and Space Engineers.

- Start, stop and restart servers, with a live console, player list and countdowns that warn players first.
- Run servers on other systems too (nodes), managed from one main panel.
- Automatic backups, plus a world integrity check that warns you before a damaged world gets backed up over a good one.
- Automatic game updates, and Tavern Host updates itself too.
- Mods and addons: Valheim mods from Thunderstore, Hexium and Nexus Mods, Minecraft addons, mods and plugins (CurseForge, Modrinth and others), tModLoader mods, Steam Workshop mods for Space Engineers, and Satisfactory mods through Satisfactory Mod Manager.
- Valheim: server profiles (world plus mods), difficulty presets and world modifiers, and admin, ban and allow-list controls.
- Port forwarding help for each server, and a warning when your public IP changes.
- Users with their own permissions, an HTTP API, and optional Remote access so you can manage your servers from another device.

## Downloads

| App | Who it's for | Download |
|---|---|---|
| **Tavern Host** | Server owners | [Latest release](https://github.com/Volatile111/tavern-host/releases/latest) |
| **Tavern Client Mod Manager** | Players (Valheim, Minecraft Java, Satisfactory and more) | [Latest release](https://github.com/Volatile111/tavern-client-releases/releases/latest) |

Both apps tell you when a new version is out and can install it for you.

## Quick start (server owners)

1. **Install.** Download `Tavern-Host-Setup-<version>.exe` from the latest release and run it. Tavern Host opens when it's done and asks you to create the owner account.
2. **Create a server.** Click **+ New**, pick the game, give it a name and a folder, and Tavern Host downloads the official server software. Already have a server? Use **Import** and point it at the folder.
3. **Start it.** Players on your own network can join straight away with the IP and port shown under the server's name.
4. **Let friends outside your network join.** Click **🌐 Port forwarding** under the server's name. It lists exactly which ports to forward on your router, and your public IP for players to use.
5. **Mods for players (optional).** On the server's **Mods** tab, add mods, then turn on **Share mods with players**. Players install Tavern Client Mod Manager and paste the link once. Valheim and modded Minecraft Java mods then stay matched to the server; Satisfactory players get the mod list for Satisfactory Mod Manager; other games get the join details.

Your game servers keep running when you close the Tavern Host window, and while it updates.

## Quick start (players)

1. Download `Tavern-Client-Mod-Manager-Setup-<version>.exe` from the [mod manager releases](https://github.com/Volatile111/tavern-client-releases/releases/latest) and run it.
2. Paste the link the server owner gives you (it starts with `thmods://`) and click **Add server**. The server shows on its game's tab.
3. **Valheim:** click **▶ Play Valheim**. Your mods are matched to the server first. A **Vanilla** profile switches mods off for playing other servers.
4. **Minecraft Java:** click **Sync now**, then pick the server's profile in the Minecraft Launcher. It has its own folder, so your other worlds and mods aren't touched. (Forge and NeoForge: run the installer the app gives you once.)

## Privacy

Tavern Host and the mod manager don't collect or send any usage data. They only contact these services, and only for the feature named:

| Service | Why |
|---|---|
| GitHub | Checking for and downloading new versions of Tavern Host and the mod manager, and downloading the BepInEx mod loader |
| Mojang / Microsoft, Steam (SteamCMD), PaperMC, Fabric, Forge, NeoForge, Sponge, SpigotMC, BungeeCord, terraria.org, tModLoader (GitHub) | Downloading and updating server software (and Microsoft's XNA Framework for vanilla Terraria) |
| Adoptium, Microsoft (.NET) | Downloading the Java runtime Minecraft Java servers need, and the .NET runtime tModLoader needs |
| Mojang (api.mojang.com), mc-heads.net | Looking up Minecraft Java player names for the player lists, and showing player head pictures |
| Thunderstore, Hexium, Nexus Mods, CurseForge, Steam (Workshop details) | Browsing, downloading and checking mods, when you use them (Nexus and CurseForge only with your own API key) |
| Modrinth, Fabric (meta.fabricmc.net) | Mod manager, Minecraft Java only: checking whether a server's mod file is the same as on Modrinth, and setting up Fabric in the Minecraft Launcher |
| api.ipify.org | Looking up your public IP, for share links, port forwarding help and the "public IP changed" warning |

Everything else (accounts, servers, settings, backups, logs) stays on your own system. Players' mod managers only connect to your Tavern Host through the share link you give them.

## API

Tavern Host has an HTTP API for bots, dashboards and other programs: start and stop servers, send commands, read players and the console, run backups, manage mods and more. Make an API key in **Settings → API keys**. Every request is listed in [API.md](API.md) (also shown in the app under **Settings → API reference**).

## Running from source

You need Node.js 24 or newer.

```
npm install
npm run desktop          # the Tavern Host desktop app
npm run client           # the mod manager
npm run dist             # build the Tavern Host installer (release/)
npm run dist:client      # build the mod manager installer
npm run release          # build Tavern Host and publish it as a GitHub release (needs GH_TOKEN)
npm run release:client   # build the mod manager and publish it to tavern-client-releases
```

## Licence

GPL-3.0. See [LICENSE](LICENSE). Tavern Host is not affiliated with Mojang, Microsoft, Iron Gate, Coffee Stain, Valve, Thunderstore, Hexium, Nexus Mods or CurseForge.
