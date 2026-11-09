# Security

Botons runs AI agents on your computer, with your logins. This page is the map: what protects you, and where each part is explained. The trust model and how to report a vulnerability are in [SECURITY.md](../SECURITY.md).

## The short version

- **A paired device is the owner.** Devices pair once by a code you approve on the server or from a paired device; a code alone gets nobody in, and a code that reached you in a chat should never be approved. [Pairing devices](access.md#pairing-devices)
- **Keep it private.** The server listens on `127.0.0.1` (and the machine's Tailscale address) unless you choose otherwise; the access mode refuses other networks. Use Tailscale or HTTPS behind a proxy to reach it from other devices, never plain HTTP across a network you don't control. [Access, HTTPS and pairing](access.md)
- **Give each Boton only the access it needs.** Workspace access keeps a Boton in a sandbox with its own workspace (Linux, bubblewrap). Full computer access runs it as your user: it can read and change everything you can. [What each Boton may do](using-botons.md#what-each-boton-may-do-and-the-audit-log)
- **Risky steps can wait for you.** Ask first rules pause a tool call for your OK, and Allow once allows exactly that one call. The managed browser acts on a page only through a card that shows the exact request. [The managed browser](browser.md)
- **Connectors are yours, and only the ones you give.** Botons never loads your CLIs' own MCP servers; each Boton has exactly the connectors you gave it, and local command connectors start sandboxed. [Connectors](connectors.md)
- **Secrets stay out of sight.** API keys and connector secrets are never shown again after saving, never sent to agent CLIs, and left out of configuration exports. Backups do hold them, unencrypted: keep backups somewhere you trust, and encrypt one before it leaves the machine. [API keys](api-keys.md), [Backups](backups.md#moving-your-configuration-to-another-server)
- **Everything consequential is recorded.** The audit log lists pairing, access changes, grants, approvals and key changes, never a secret. [Audit log](using-botons.md#what-each-boton-may-do-and-the-audit-log)

## Where each protection is described

| Topic | Read |
| --- | --- |
| Access modes, and what no mode can see (forwarders, proxies, tunnels) | [access.md](access.md#access-modes) |
| HTML previews in a sandboxed frame, and what a page can still send | [files.md](files.md#files-a-boton-shares) |
| The trash: deletes that never follow links or leave the workspace | [files.md](files.md#deleting-files-and-the-trash) |
| Starter templates and skill packages: reviewed before anything is granted | [using-botons.md](using-botons.md#starter-templates) |
| The API key brains' tool sandbox, spending caps and key redaction | [api-keys.md](api-keys.md#botons-on-an-api-key) |
| OAuth connectors: PKCE, HTTPS only, no redirects, refresh-token safety | [connectors.md](connectors.md#oauth-sign-in-connectors) |
| The managed browser: allowed sites, read-only by default, handovers | [browser.md](browser.md) |
| Limits on macOS (no weaker sandbox substituted) | [install.md](install.md#macos) |
| Docker's safety defaults | [DOCKER.md](DOCKER.md) |
