# First run

## Claim the server

A new server has no owner. Open it (`http://localhost:7777`, or its Tailscale address): the page shows a code. **Claim** the server by approving that code on the server's computer:

```sh
botons pair --approve <code>                              # an install made by the installer
npm run pair -- --approve <code>                          # a checkout or release folder
docker compose exec botons botons pair --approve <code>   # Docker
```

The page then signs in by itself. Only someone who can run commands on the server can approve, and the code alone gets nobody in, so it is safe for the page to be reachable while you do this. Your own Tailscale devices can also claim it with one click. The device that claims it is recorded as the owner's first device. More devices pair the same way: see [Pairing devices](access.md#pairing-devices).

## Setup

The web app then walks you through setup. You can change all of it later in **Settings**:

1. **Your name**, which Botons use when they talk about you.
2. **Who can connect** (the [access mode](access.md#access-modes)): this machine only, Tailscale, the local network, or the public internet over HTTPS. Botons recommends Tailscale when it is up, otherwise this machine only. The mode refuses requests from any other network before anything else runs; it never opens anything. Every mode beyond this machine lists what *you* do on the host first (sign in to Tailscale, change `BOTONS_HOST` or the published port, the firewall, an HTTPS proxy, DNS). Botons never does those, and it won't let you choose public without an `https://` `BOTONS_PUBLIC_URL` and auth on, or a mode that would lock out the device you are using.
3. **Brains**: whether the `claude` and `codex` CLIs are installed and signed in. Signing in creates a credential, so you do it yourself on the server: `botons login claude` or `botons login codex` (prefix `docker compose exec -it botons` in Docker), then **Check again**. Brains can also install or update a CLI for you ([Brains](brains.md)).
4. **Your first Boton**, with Workspace access (sandboxed) and no connectors, made your primary Boton. This step checks the brains again as it opens; if none is ready, go back to Brains first.
5. **Ready**: the health checks, then its chat.

A server that already had Botons when it was upgraded skips setup. Nothing in setup edits an env file or restarts the server.

If a brain won't get ready, see [Brains](brains.md#codex-and-the-workspace-sandbox) and run `botons doctor`, which says what to fix.
