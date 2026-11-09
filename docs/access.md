# Access, HTTPS and pairing

Who can reach Botons, how to serve it over HTTPS, and how devices sign in. Commands here use `botons pair`; from a checkout or release folder use `npm run pair --`, and in Docker `docker compose exec botons botons pair`.

## Access modes

| Mode | Accepts requests from | Before choosing it, on the host |
| --- | --- | --- |
| `local` | this machine (and, in Docker, the published port) | nothing; from elsewhere use an SSH tunnel |
| `tailscale` | this machine and the tailnet (100.64.0.0/10, fd7a:115c:a1e0::/48) | `tailscale up`; in Docker, the Tailscale overlay and an auth key you create |
| `lan` | also private networks (10/8, 172.16/12, 192.168/16, link-local, fc00::/7) | `BOTONS_HOST=0.0.0.0` (Docker: `BOTONS_BIND`), a firewall rule for your LAN; plain HTTP |
| `public` | anywhere | DNS, an HTTPS proxy (Docker: the Caddy overlay), ports 80/443 open, `BOTONS_PUBLIC_URL=https://…` |

You choose the mode in setup and in **Settings → Access**. With no mode chosen, nothing is refused beyond what the listeners allow. The mode applies to the app's port only, not to the webhooks-only `BOTONS_HOOKS_PORT`.

**What no mode can see.** The mode checks only the address a connection comes from. Anything on this machine that forwards connections to Botons (a reverse proxy, Tailscale Serve or Funnel, an SSH or other tunnel) makes them come from this machine, so `local`, `tailscale` and `lan` let them through from wherever they started. In Docker every connection comes from the container network, so the published port and the overlays decide. Botons can't detect a forwarder it didn't set up, so the setup screen and **Settings → Access** say this for every mode, and warn when `BOTONS_PUBLIC_URL` points somewhere else. With a forwarder in front, the forwarder and the listener are the boundary, and pairing is the one after them.

**Locked out?** `botons pair --access-mode tailscale` (or `lan`, `local`, `public`, `none`) on the server's computer takes effect at once, server running or not.

## HTTPS for the whole app

Over plain `http://` on the tailnet or a LAN, browsers mark the page "Not secure", may block or flag downloads from it, and keep some features (installing it as an app, notifications) from it. Serving the whole app over HTTPS fixes that. Each of these changes how devices reach Botons, so it is the owner's step, done on the host; Botons never sets it up itself. For Docker, [DOCKER.md](DOCKER.md) ("Reaching it from other devices") has the same choices as overlays.

**Tailscale Serve** (tailnet only, nothing public). Tailscale gets a certificate for the machine's MagicDNS name and proxies to the app:

```sh
tailscale serve --bg --https=443 http://127.0.0.1:7777
tailscale serve status                         # what it serves now; `tailscale serve reset` stops all of it
# then, in ~/.config/botons/env, and restart Botons (botons restart):
BOTONS_PUBLIC_URL=https://myhost.example-tailnet.ts.net
```

This serves every path, so it replaces a Serve set up for `/oauth` alone (the OAuth callback still works; `BOTONS_OAUTH_PUBLIC_URL` is the same origin). Through Serve, connections come from this machine, so the access mode no longer tells tailnet devices from others: Serve itself keeps it to your tailnet (see "What no mode can see"). The same goes for one-click pairing, which needs the direct Tailscale address: on `https://myhost.example-tailnet.ts.net`, pair with a code. A browser keeps the device token per origin, so a device paired on the `http://` address pairs again on the `https://` one; revoke the old entry in **Settings → Devices**. The plain address keeps working until you drop it: `BOTONS_HOST=127.0.0.1` stops the server listening on the Tailscale address (and its Tailscale lookups, so one-click pairing too).

**Caddy** (a domain of your own). Caddy gets a Let's Encrypt certificate and proxies to the app:

```
botons.example.com {
	reverse_proxy 127.0.0.1:7777 {
		flush_interval -1    # /api/events is a server-sent event stream
	}
}
```

Then set `BOTONS_PUBLIC_URL=https://botons.example.com`. It needs the domain's DNS pointing at the machine and ports 80 and 443 open; reachable from the internet, it is the `public` access mode, and every device still pairs with a code. On a LAN without a public name, `tls internal` in that block makes Caddy use its own certificate authority, which each device then has to trust. Any other proxy works the same way: keep the `Host` header, don't buffer `/api/events`, allow bodies of at least 1 MB, and set `BOTONS_PUBLIC_URL` (or `BOTONS_ALLOWED_HOSTS`).

## Pairing devices

Every browser or app pairs once. Your own untagged Tailscale devices (signed in as the owner login) pair with one click at the MagicDNS URL. Anything else opens Botons and shows a code; you approve that code from a paired device (**Settings → Devices → Approve a device**) or on the server's computer, and the new device signs in by itself. A code lasts 15 minutes and is approved once.

The server can't tell who is asking: a Boton on this machine can leave out its token and look like any browser. So a code is never a credential. The device that asks keeps a secret only it holds, and only the owner's approval of its code turns that into a device token: a code seen in a chat pairs nothing. Approve only a code you are reading off the screen of the device you are pairing; a Boton can ask to pair too, so never approve a code that reached you in a chat or a message.

```sh
botons pair                          # how to pair, and the requests waiting (codes show only on the devices)
botons pair --approve ABCD-EFGH      # approve the device showing this code (--label "Work iPad" names it)
botons pair --list                   # paired devices
botons pair --revoke dev_abc123      # sign one out
botons pair --revoke-all             # sign every device out
```

`botons pair` works on the database directly, so it also gets you back in if every device is lost: listing, revoking and the access mode work with the server up or down, and approving needs the server up only because the device asks through it. It uses `BOTONS_HOME` if set, else the one in the service's env file (`--env-path <file>`), else `~/.botons`. As a last resort, `BOTONS_AUTH=off` lets every request in: pair, then remove it at once.
