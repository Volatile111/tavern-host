# Security

Tavern Host runs game servers and can be reached from other devices (Remote access), so security problems matter a lot. Thank you for helping keep people's systems safe.

## Reporting a problem

**Please don't open a public issue for security problems.** Everyone could see how to use it before it's fixed.

Instead, report it privately: go to the [Security tab](https://github.com/Volatile111/tavern-host/security) and click **Report a vulnerability**. Include:

- which app and version (Tavern Host or Tavern Client Mod Manager),
- what someone could do with it, and what they'd need first (e.g. a login, Remote access turned on, a share link),
- the steps to make it happen.

You'll get an answer as soon as possible. Fixes go out in a new release, and both apps tell their users when an update is available.

## Supported versions

Only the latest release gets security fixes. Both apps are in beta and update often, so please update before reporting.

## Good to know

- Remote access uses HTTPS with a certificate made on your own system. Share links and node codes contain a fingerprint of it, so the other side can't be fooled by a different server.
- Share links (`thmods://…`), node codes (`thnode://…`) and API keys work like passwords. Don't post them publicly; if one leaks, make a new one (the old one stops working).
