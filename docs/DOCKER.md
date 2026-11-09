# Running Botons with Docker Compose

`compose.yaml` runs Botons in one container on a laptop, a home server or a VPS. It keeps the data in volumes, checks its own health, and listens on `127.0.0.1` only unless you choose otherwise. The systemd service in the README is the other supported way to run Botons; pick one per data folder.

You need Docker Engine with Compose v2.24 or newer. The image installs the `claude` and `codex` CLIs from their publishers' npm packages (their own terms apply); you sign in to them once, inside the container.

## Start it (this machine only)

```sh
cp .env.example .env                     # compose's settings; the defaults keep it on 127.0.0.1:7777
cp botons.env.example botons.env       # optional: the server's BOTONS_* settings
BOTONS_BUILD_SHA=$(git rev-parse HEAD) docker compose up -d --build
docker compose exec -it botons botons login claude      # and/or: botons login codex
docker compose exec botons botons pair --approve <code>   # the code http://localhost:7777 shows
```

Open `http://localhost:7777` first: it shows a code, and approving it with the command above signs the page in. The first device to pair claims the server, and the web app then walks you through your name, who can connect (the access mode; "This machine only" fits this setup), the CLI sign-ins, a first Boton and a health check (README, "First run"). On a VPS, reach it through an SSH tunnel (`ssh -L 7777:127.0.0.1:7777 you@myhost`) until you set up one of the HTTPS modes below.

In the container every request arrives from Docker's network, so the `local` and `tailscale` access modes also accept private addresses: there, the published port (`127.0.0.1` by default) or the sidecar is what keeps other networks out, and a proxy or tunnel in front of the published port lets through whoever can reach it. The setup screen and Settings → Access say so. If a mode locks you out, `docker compose exec botons botons pair --access-mode none` clears it.

Signing in to a CLI creates a credential: it is the owner's step, and it is kept in the `home` volume. Never put API keys or other credentials in `botons.env` or `.env` for the server: Botons with Host access run as the same user as the server and can read its environment and everything in the container.

## Check it

```sh
docker compose ps                                  # "healthy" once the database, scheduler and a signed-in CLI work
docker compose exec botons botons doctor         # what is wrong and what to do about it (read-only)
docker compose run --rm botons doctor             # the same while it is stopped (it then finds no server running)
docker compose logs -f botons                     # one JSON object per line
```

The container reports **unhealthy** until a CLI is signed in: that is what `/api/health` means, not a fault in the container. A bad setting stops the server with exit status 78 and Docker keeps restarting it: `docker compose logs botons` names the setting, `botons doctor` lists every one.

## Where the data lives

| Volume | Mounted at | Holds |
| --- | --- | --- |
| `botons_data` | `/data` (`BOTONS_HOME`) | the database, workspaces, shared folder, templates and backups |
| `botons_home` | `/home/node` | the CLI logins and settings (`~/.claude`, `~/.claude.json`, `~/.codex`), git config |

Both survive `docker compose down`, rebuilds and upgrades. `docker compose down -v` deletes them, and with them every Boton, chat and login: don't, unless you mean it.

## Backups and restore

```sh
docker compose exec botons botons backup                        # /data/backups/<UTC time>/, newest 14 kept
docker compose cp botons:/data/backups ./botons-backups         # copy them off the machine's Docker storage
```

Schedule the backup with the host's scheduler, for example a crontab line (the owner's change to the host):

```cron
30 3 * * * cd /path/to/botons && docker compose exec -T botons botons backup >> backup.log 2>&1
```

To restore, stop the server and run the restore in a one-off container on the same volumes. Without `--yes` it only shows what it would do. It never deletes: the current database and folders move to `/data/before-restore-<time>/`, and a restore that fails part-way attempts to put them back. If recovery fails, preserve the reported recovery paths and do not start the server. Archives containing links or special files are rejected: inspect and copy those separately, without crossing workspace boundaries. Only the current schema and its supported immediate predecessor can be restored.

```sh
docker compose stop botons
docker compose run --rm --no-deps botons restore --list
docker compose run --rm --no-deps botons restore latest --yes      # or a name from --list
docker compose start botons
```

A backup from elsewhere, or onto a new machine's empty volumes: copy it in as the server's user, so the restore can read it (`docker compose cp` would leave it root's), then restore it by name. The server need not have run yet:

```sh
tar -C ./botons-backups -c 2026-11-05T03-30-00-000Z | docker compose run --rm --no-deps -T --entrypoint sh botons -c 'mkdir -p -m 700 /data/backups && tar -C /data/backups -x'
docker compose run --rm --no-deps botons restore 2026-11-05T03-30-00-000Z --yes
docker compose up -d
```

The devices paired before the backup stay paired; the CLI sign-ins in the `home` volume do not come with it.

**Settings → Health and backups** in the app shows the newest backup's age, flags it when it is over 2 days old, and lists these commands; it never backs up or restores by itself.

## Upgrade

```sh
docker compose exec botons botons backup
git pull
BOTONS_BUILD_SHA=$(git rev-parse HEAD) docker compose build --pull
docker compose up -d
docker compose exec botons botons doctor
```

Running work gets `BOTONS_DRAIN_MS` (default 2m) to finish when the old container stops; `stop_grace_period` in `compose.yaml` is set above it, so raise both together. If the new release upgrades the database schema, the old release can no longer open it: to go back, build the old commit and restore the backup you made first.

## Reaching it from other devices

The default publishes the port on `127.0.0.1` only. Each of these is a change to who can reach Botons, and the owner decides on it; the Tailscale and Caddy modes also need something only the owner can create (an auth key, a DNS record, open ports).

**Tailscale, on the host.** If the machine already runs Tailscale, keep the default port binding and let Tailscale Serve put HTTPS in front of it, for your tailnet only:

```sh
tailscale serve --bg --https=443 http://127.0.0.1:7777
# then in .env: BOTONS_PUBLIC_URL=https://myhost.example-tailnet.ts.net, and: docker compose up -d
```

**Tailscale, as a sidecar.** Without Tailscale on the host, `docker/compose.tailscale.yaml` adds a Tailscale container that joins your tailnet and serves the app over HTTPS; nothing is published on the host's interfaces. Put an auth key the owner made in the Tailscale admin console in `.env` as `TS_AUTHKEY` (it reaches only the sidecar), set `TS_HOSTNAME`, and `BOTONS_PUBLIC_URL=https://<TS_HOSTNAME>.<your tailnet>.ts.net`:

```sh
docker compose -f compose.yaml -f docker/compose.tailscale.yaml up -d
```

**A public domain with Caddy.** `docker/compose.caddy.yaml` adds Caddy, which gets a Let's Encrypt certificate for `BOTONS_DOMAIN` and proxies to the app; the app's own port is no longer published. It needs the domain's DNS pointing at the machine and ports 80 and 443 open to the internet. Anyone can then reach the sign-in page; every device still has to pair with a code. Set `BOTONS_DOMAIN=botons.example.com` and `BOTONS_PUBLIC_URL=https://botons.example.com` in `.env`:

```sh
docker compose -f compose.yaml -f docker/compose.caddy.yaml up -d
```

**Your own reverse proxy.** Proxy to the published port and: keep the `Host` header (the app checks it, and `Origin` against it), don't buffer `/api/events` (a server-sent event stream), allow request bodies of at least 1 MB, and set `BOTONS_PUBLIC_URL` to the proxy's `https://` address (or add its name to `BOTONS_ALLOWED_HOSTS`).

**The LAN, without HTTPS.** `BOTONS_BIND=0.0.0.0` publishes plain HTTP on every interface of the host. Device tokens then cross the network unencrypted, and on a VPS Docker's published ports bypass most host firewalls. Prefer one of the modes above.

## Differences from the systemd service

- Tailscale is not used inside the container (`BOTONS_NO_TAILSCALE=1`), so there is no one-click pairing: devices pair with a code.
- `npm run deploy`, `service:install` and `backup:install` are for the systemd service; Compose replaces them.
- An install made under an earlier name: run `sh docker/legacy-names.sh` once before the first `docker compose up -d --build` of this version (README, "Upgrading an install made under an earlier name").
- Admin commands run inside the container: `docker compose exec botons botons <doctor | pair | backup | restore>`.
- OAuth connectors need `BOTONS_OAUTH_PUBLIC_URL` (an `https://` origin that reaches `/oauth/callback`): with the Tailscale or Caddy modes, that is the same origin as `BOTONS_PUBLIC_URL`. Put it in `botons.env`.

## Sandbox

Claude Botons with **Workspace** access run their commands in a bubblewrap sandbox, which needs user and mount namespaces and the `mount` call. The container's seccomp profile (see Browser below) and Docker's AppArmor profile block those, so in a default container such commands fail; `botons doctor` reports it under `sandbox`. Either:

- give those Botons **Host** access: the container is then their boundary, and they can read everything in it (the database, every workspace, the CLI logins); or
- let the owner relax the container's confinement for the `botons` service (`security_opt: [seccomp=unconfined, apparmor=unconfined]` in an override file). That weakens the container's own isolation from the host, so it is a deliberate choice, not a default.

## Browser

The profile’s [source and modification notice](../docker/seccomp-browser.NOTICE.md) and [upstream license](../docker/LICENSE.seccomp-browser) accompany it.

The image installs Debian's Chromium for the managed browser (`BOTONS_BROWSER_PATH=/usr/bin/chromium`), and the server always starts it with Chromium's own sandbox. That sandbox puts each page's process in new user, PID and network namespaces, under its own seccomp filter. Docker's default seccomp profile refuses to make those namespaces, so `compose.yaml` runs the `botons` service with `docker/seccomp-browser.json` instead: Docker's default profile with three syscall rules added, which lets `clone` and `unshare` make user, PID and network namespaces. Nothing else changes: mount, UTS, IPC, cgroup and time namespaces stay refused, and so do `mount`, `setns`, `pivot_root`, `keyctl` and the rest of what Docker's profile refuses, and no capability is added. The same service sets `no-new-privileges`, so no setuid or file-capability binary in the container gains privileges. Chromium's sandbox doesn't need one: it uses user namespaces, never a setuid helper.

What that costs: any process in the container (the server, the agent CLIs, a Boton's commands) can make those three namespaces too, which opens more of the host kernel to it (network namespaces in particular reach the kernel's networking code). That is the price of Chromium's sandbox in a container; turning that sandbox off would be worse, since a page that exploited Chromium would then hold everything in the container (the database, every workspace, the CLI logins). The profile changes nothing for bubblewrap, which still can't start (see Sandbox above).

`scripts/docker-smoke.sh` checks this on every push: `botons check-browser` must start Chromium with its sandbox, a mount namespace must still be refused, and a user, PID and network namespace must be allowed. On a host, `botons doctor` reports the browser under `browser`, and `docker compose exec botons botons check-browser` shows whether it works.

Where it still can't start, the host is refusing user namespaces beyond what the profile allows (for example a kernel or AppArmor setting that restricts unprivileged user namespaces), and what to do is the owner's call:

- change that host setting: it is a change to the host, made by the owner; or
- set `BOTONS_BROWSER_SANDBOX=0` in `botons.env` (the server's settings; `.env` doesn't reach the server): Chromium then runs without its sandbox, and the container is its only boundary. The browser still reaches only the sites you list, and nothing a page sends once the Boton acts on it goes without your card; or
- leave the browser connector off.

Never use `seccomp=unconfined` or `privileged` for the browser: they open far more than Chromium needs.

## Test the image

`scripts/docker-smoke.sh` builds the image without the agent CLIs and runs it in a throwaway Compose project (`botons-smoke`, its own volumes) with the mock provider: health, host checks, doctor, the managed browser (`check-browser`, which must pass with Chromium's sandbox on, and the seccomp profile's namespaces), pairing, backup, restore and a recreate. CI runs it on every push.

### Proxies that rewrite Host

Set `BOTONS_PUBLIC_URL` to the external HTTPS origin when a reverse proxy rewrites
`Host` to the upstream address. Botons accepts that configured origin (and
`BOTONS_OAUTH_PUBLIC_URL`, when set) while keeping its Host and mutation checks.
A different upstream Host is expected in this setup; forwarded Host headers do
not grant access. Generated links use the configured public URL.
