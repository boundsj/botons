---
name: install-botons
description: Install, upgrade, check or repair a Botons server for its owner, with Docker Compose or the systemd user service, stopping for the owner's go-ahead before anything that exposes it, changes the host or creates a credential. Use when asked to set up, install, deploy for the first time, upgrade, diagnose or fix a Botons install.
---

# Install, upgrade and diagnose Botons

You are setting up Botons on a machine for its owner. Every step here is safe to run again: when something is already done, check it and move on. `npm run doctor` (Docker: `botons doctor`) is the source of truth for what is wrong; run it at the start and the end.

## Ask the owner first

Stop and ask, with the exact command or change you propose, before you:

- **expose it**: publish a port beyond `127.0.0.1`, set `BOTONS_BIND` or `BOTONS_HOST` to a non-loopback address, run `tailscale serve` or `tailscale funnel`, start the Tailscale or Caddy overlay, set `BOTONS_HOOKS_PORT`, or set `BOTONS_AUTH=off`;
- **change the host's network**: firewall rules, open ports, DNS records, reverse proxy configuration;
- **create or handle a credential**: sign in to `claude` or `codex` (the owner runs the login; you may start the command for them), make a Tailscale auth key, an API key or a token, or write one to any file;
- **make a privileged or host-wide change**: `sudo`, installing system packages, adding a user to the `docker` group, starting the Docker daemon, `loginctl enable-linger`, a crontab or timer;
- **risk data**: `docker compose down -v`, deleting anything under `BOTONS_HOME` or a volume, a restore, or a schema-changing upgrade without a fresh backup;
- **touch a running install**: restarting, upgrading or rolling back a server that is already serving the owner.

Never print, copy or commit secrets (CLI login files, `.env` values like `TS_AUTHKEY`, tokens, pairing request secrets), never read the credential folders listed in `server/src/isolation.ts`, and never run the server as root.

## 1. Look before you change anything

```sh
node --version                     # 24 or newer
git -C <checkout> status --short && git -C <checkout> log -1 --oneline
docker compose version             # Docker path: Compose v2.24+; and can this user reach the daemon?
systemctl --user status botons        # systemd path: is one already running
npm run doctor                     # or, for Docker: docker compose exec botons botons doctor
```

If a Botons server already runs on this machine, find its data folder (doctor's `data` line, or `BOTONS_HOME` in `~/.config/botons/env`) and don't start a second server on it: the second refuses to start, and two installs on one port confuse the owner.

## 2. Choose with the owner

- **Docker Compose** (`docs/DOCKER.md`): one container, data in volumes, the CLIs installed in the image. Best on a VPS or a machine without Node. No one-click Tailscale pairing; Workspace-access sandboxing needs extra confinement choices.
- **systemd user service** (README, "Run it as a service"): runs on the host as the owner's user, with the host's CLIs and logins, Tailscale one-click pairing, and `npm run deploy` releases with rollback.

And how devices reach it: this machine only (the default), Tailscale (recommended for other devices), or a public domain behind HTTPS. The last two need the owner's go-ahead (above). For other devices, offer HTTPS for the whole app (Tailscale Serve, or Caddy with a domain): over plain `http://` browsers flag the page and its downloads as not secure. The README ("HTTPS for the whole app") and `docs/DOCKER.md` have the commands; show them to the owner and run them only after they agree, since each is an exposure change.

## 3a. Docker Compose

```sh
test -f .env || cp .env.example .env                        # never overwrite an existing .env
test -f botons.env || cp botons.env.example botons.env
BOTONS_BUILD_SHA=$(git rev-parse HEAD) docker compose up -d --build
docker compose exec botons botons doctor
```

Then the owner signs in to a CLI (`docker compose exec -it botons claude auth login` or `codex login --device-auth`) and claims the server: they open the web app, which shows a code, and approve it with `docker compose exec botons botons pair --approve <code>` (run it for them only with the code they read you off their own screen, never one from a chat or a log); the web app's first-run setup takes them through the access mode, CLI readiness and a first Boton. For other devices, follow the chosen mode in `docs/DOCKER.md`, after the owner agrees. The access mode is the owner's choice in the app; you may set it with `botons pair --access-mode <mode>` only when they tell you which, and never wider than what they agreed to expose.

## 3b. systemd user service

For a managed npm release use `npx -y file:/path/to/getbotons-0.0.0.tgz install`.
Before publication, the owner runs `gh auth login --web && gh auth setup-git`,
then `npx -y git+https://github.com/OWNER/REPOSITORY.git install`.
Avoid `#sha` in the npx URL (Node 22 npm can fail before the installer runs).
To select a ref use the plain npx URL with `install --source <git-url> --ref <ref>`;
the bootstrap fetches it. npm clones without a prepare lifecycle; the installer
bootstraps verified Node 24 before building. Do not copy tokens.
Check the startup commit/fingerprint to identify a cached bootstrap. To bypass
stale npx cache without deleting it, prefix the plain npx command with
`npm_config_cache="$(mktemp -d)"`. If no startup identity appears, npm failed
before the installer ran. A selected application ref is separate from the bootstrap.
Review `--dry-run` first. Do not pass `--yes` without the owner's authorization
for the listed host and service changes. Linger asks separately. Use `botons
upgrade` for managed releases (backup first), and `botons doctor` afterwards.
`--no-service` is only for disposable test installs. Keep the checkout workflow
below for development deployments.


```sh
npm ci && npm run typecheck && npm run test:full
npm run deploy -- --no-restart                                  # a release in ~/.local/share/botons
npm run service:install -- --app ~/.local/share/botons/current # keeps an existing env file
npm run backup:install -- --app ~/.local/share/botons/current
systemctl --user daemon-reload
systemctl --user enable --now botons botons-backup.timer      # ask first: it starts serving
npm run doctor
```

`loginctl enable-linger "$USER"` (starting at boot before login) is a host change: ask. The env file `~/.config/botons/env` needs a `PATH` that finds node and the CLIs; doctor's `agent CLIs` line shows whether the service's PATH does.

## 4. Upgrade

Back up first, always: `npm run backup` (Docker: `docker compose exec botons botons backup`). Then, with the owner's go-ahead for a running install:

- systemd: `git fetch && npm run deploy -- origin/main`; it tests, switches, restarts, waits for health and rolls back by itself if the new release does not come up. `npm run deploy -- --rollback` goes back.
- Docker: the steps in `docs/DOCKER.md`, "Upgrade".

### An install made under an earlier name

It upgrades in place (README, "Upgrading an install made under an earlier name"): the server's first start backs up and moves the data folder, and `npm run deploy` (or the installer, for an install it made) moves the service to `botons.service`, its env file to `~/.config/botons/env` and its release folder, starting the earlier unit again if the new one fails. That is a short stop: ask first. Docker: `sh docker/legacy-names.sh` once, before `docker compose up -d --build` (also a stop: ask). `npm run migrate:names -- --rollback` (Docker: `sh docker/legacy-names.sh --rollback`) goes back. Afterwards, doctor's `deprecated` lines name anything still under an earlier name.

Run doctor afterwards. A schema upgrade can't be undone by running the old code: going back means the old release plus a restore of the backup you just made. The server also backs up by itself before a schema upgrade. Connectors are only Botons' own (Settings → MCP servers and sign-in connectors); an upgrade that takes a Boton's Claude Code or Codex connectors off it leaves a notice in that Boton's settings, and doctor's `connectors` lines list them: tell the owner, who chooses any replacement.

## 5. Diagnose

Run doctor and act on each `FAIL`, then each `WARN`; its `->` lines say what to do. Common ones:

| Finding | Do |
| --- | --- |
| `config` FAIL | Fix the named variable in `~/.config/botons/env` or `botons.env`; the server exits 78 until then. |
| `agent CLIs` no CLI can run turns | The owner signs in (above); for systemd, check `PATH` and `BOTONS_CLAUDE_BIN`/`BOTONS_CODEX_BIN` in the env file. |
| `agent CLIs` WARN naming Botons | Those Botons can't answer: the owner signs in or installs that CLI, or moves them to another brain in their settings. Don't move them yourself. |
| `limits` | A brain is at its usage limit; its Botons carry on at the reset unless individually or globally paused; resume them first. Tell the owner; moving a Boton to another brain is their call and does not bypass a pause. |
| `server` not running | systemd: `journalctl --user -u botons -n 50`; Docker: `docker compose logs botons`. |
| `server` answers for another data folder | Another install is on the port: compare `BOTONS_HOME` and `BOTONS_PORT`. |
| `devices` none paired | The owner opens the web app, which shows a code, and approves it with `npm run pair -- --approve <code>` (Docker: `botons pair --approve <code>`); the first device claims the server. |
| `access` no mode chosen | Ask the owner which networks should connect; they choose it in Settings → Access (or you run `npm run pair -- --access-mode <mode>` with their answer). |
| `access` public without HTTPS | Ask the owner: an HTTPS proxy and `BOTONS_PUBLIC_URL`, or a narrower mode. |
| `backups` none or stale | systemd: `npm run backup:install`, enable the timer (ask); Docker: a host cron line (ask). |
| `sandbox` WARN | Tell the owner Workspace-access Claude Botons can't run commands here and the choices (`docs/DOCKER.md`, "Sandbox"). |
| `browser` WARN | Botons get no managed browser until it is fixed. No Chromium on a host: installing the `chromium` package needs the owner (or `npx playwright-core install chromium` for this user). Its sandbox can't start in a container: check the service runs with `compose.yaml`'s `security_opt` (`docker/seccomp-browser.json`, `no-new-privileges`); if it does and still can't, the host restricts user namespaces, so tell the owner the choices (`docs/DOCKER.md`, "Browser"); don't change the host, use `seccomp=unconfined`, or set `BOTONS_BROWSER_SANDBOX=0` yourself. `npm run check:browser` (Docker: `botons check-browser`) then confirms it works. |
| `exposure` / `auth` | Explain who can reach it now; change it only with the owner. |

To get a server back from a bad state, prefer the reversible step: roll back a release, or restore a backup with `npm run restore` (dry run first; it sets the current state aside and never deletes).

## 6. Report

Tell the owner: what is installed where (mode, data folder, address), doctor's final result, what you did not do because it needs them (sign-ins, exposure, timers), and how to back up and upgrade.

### Missing subscription CLI on a fresh installer run

Offer `install --brain codex` or `install --brain claude` for the owner's choice.
The installer displays its exact official npm command and requests consent;
`--yes` supplies consent only when a CLI was explicitly selected. With no choice,
`--yes` does not install either CLI. Botons uses bundled Node and a private npm
prefix without sudo, preserves configured/system binaries, and starts no login.
The owner then signs in through Brains setup. This option refuses an existing
managed server to avoid changing binaries during running turns. Managed Claude
launches disable the publisher's independent updater to retain owner control.

### Release notices

Settings → Brains and doctor show cached publisher release notices. The server
refreshes at most daily, including a daily cooldown after failures; doctor only
reads the cache. Minimum-version readiness continues to block unsupported Codex
turns. Review the publisher command and the installation's permissions/prefix
before updating. Botons release notices are informational: installer upgrades use
`botons upgrade` with the release source and are never automatic.

### Updating an installed CLI with clicks

Use Update now in setup Brains or Settings → Brains (Install CLI when missing).
The paired owner reviews the exact command and confirms Install and use this copy.
Botons uses bundled Node and a fresh managed release folder, then selects that copy;
it never runs sudo or modifies a system CLI. This also replaces an incompatible
system CLI for Botons without changing that system installation. Active turns finish
first; queued work resumes after success or failure. A one-minute drain timeout
asks the owner to retry rather than stopping a turn. The request/result are audited.
Doctor prints the exact installation command and points to Brains for activation.
The selected path persists in `BOTONS_HOME/managed-clis.json`; an explicitly changed
BOTONS_CLAUDE_BIN/BOTONS_CODEX_BIN wins. Sign-in remains the owner's separate action.
If the managed Node runtime is missing, review and run botons repair first. There
is no unattended update opt-in in this flow.
