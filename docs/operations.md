# Running and operating Botons

How the server runs, how to check on it, and how to deploy from a checkout. The installer sets up a service for you ([Install](install.md)); [Docker](DOCKER.md) is the other supported way. Pick one per data folder.

## Everyday commands

| Installer install | Checkout or release folder | |
| --- | --- | --- |
| `botons status`, `botons start`, `botons stop`, `botons restart` | `systemctl --user status botons` (and `start`, `stop`, `restart`) | The service |
| `botons doctor` | `npm run doctor` | What is wrong and what to do about it |
| `botons backup`, `botons restore` | `npm run backup`, `npm run restore --` | [Backups](backups.md) |
| `botons pair` | `npm run pair --` | [Pairing devices](access.md#pairing-devices) |
| `botons login claude`, `botons login codex` | | Sign a CLI in for Botons |

In Docker, prefix `docker compose exec botons` (`-it` for login), as in [DOCKER.md](DOCKER.md).

A bad setting, or a database at another schema version, stops the server with exit status 78. Only one server can use a data folder at a time.

## Doctor

`botons doctor` (`npm run doctor` from a checkout) checks an install and says what to fix: Node and the build, every setting, who can reach the server, the data folder and database, routine runs to check, backups, the running server, the agent CLIs and their logins (naming the Botons a missing or signed-out one leaves without answers), usage limits in force, the sandbox and the service. It only reads, and exits 1 if something must be fixed. Coding agents setting Botons up for you follow `.claude/skills/install-botons/SKILL.md`, which stops for your go-ahead before anything that exposes the server, changes the host or creates a credential.

## Health and logs

`GET /api/health` answers 200 when the database, the scheduler and at least one CLI work, else 503 with what failed. On stop, running turns get up to `BOTONS_DRAIN_MS` to finish; queued and cut-off work runs after the next start.

Logs are one JSON object per line. On Linux: `journalctl --user -u botons -t botons -o cat | jq .`. On macOS they are under `~/.config/botons/logs`. In Docker: `docker compose logs -f botons`.

### Server events

**Settings → Server events** shows known events from the server's recent info, warning and error lines, newest first, filtered by severity, Boton or text, with a next step for the failures it knows (sign a connector in again, test push, retry a run) and Copy for a bug report. It is a selection, not the log: each line's message is looked up in a fixed catalog of the messages the server writes and shown as that event's name (any other message reads as an unclassified event), and only a fixed set of details is kept when it passes its check: the server's own ids (Boton, routine, run, approval, connector), kinds and statuses, booleans, counts and durations, and an error kind (connection refused, timeout, DNS, permission, disk full and so on) in place of the error. Error text, paths, URLs, payloads and anything else a line holds are left out, never masked and shown. Events are kept in memory only (the newest 1,000, at most 512 KB), so a restart starts the view again and nothing reaches the disk or a backup. The full log, with the detail left out here, stays in the journal or the container's log. `GET /api/logs` returns the same to paired devices, 200 events at most per answer (`level`, `q`, `botons`, and `before` for older events); Boton tokens are refused.

**Settings → Health and backups** shows the health checks, push notifications, disk space and backups ([Backups](backups.md#health-and-backups-in-settings)).

## Run it as a service

On Linux, the systemd user service runs a release folder built by `npm run deploy`, not your checkout:

```sh
npm run deploy -- --no-restart                    # build the first release; ~/.local/share/botons/current points at it
npm run service:install -- --app ~/.local/share/botons/current
npm run backup:install -- --app ~/.local/share/botons/current
systemctl --user daemon-reload
systemctl --user enable --now botons botons-backup.timer
loginctl enable-linger $USER                      # once: start at boot, before you log in
```

`service:install` writes `~/.config/systemd/user/botons.service` (`--name`, `--dir` and `--env-path` change that) and, if there is none, the env file `~/.config/botons/env`: a `PATH` with node and the CLIs, and `BOTONS_CLAUDE_BIN` and `BOTONS_CODEX_BIN`. systemd does not read your shell profile, so settings go in that file ([Configuration](configuration.md)); then `systemctl --user restart botons`. Run `service:install` again after changing the Node version, the app folder or `BOTONS_DRAIN_MS` (the unit's stop timeout follows it). The unit restarts the server after a failure, but not after exit 78.

On macOS, `service:install` and `backup:install` write per-user LaunchAgents and print their `launchctl` commands ([macOS](install.md#macos)).

### Deploy and roll back

```sh
git fetch && npm run deploy -- origin/main        # any commit-ish (default HEAD)
npm run deploy -- --rollback                      # back to the previous release
npm run deploy -- --rollback 1a2b3c4              # or to any release still on disk
npm run deploy -- --list                          # releases, newest first; * current, - previous
```

A deploy copies the commit (`git archive`) to `~/.local/share/botons/releases/<sha>`, runs `npm ci`, typecheck, `npm run test:full` (`--skip-tests` skips it) and the build there, points `current` at it, restarts the unit and waits for `/api/health` to report the new commit. If the server does not come up, it goes back to the previous release and exits non-zero. It keeps the newest 5 releases (`--keep <n>`) plus current and previous. Other flags: `--root <dir>`, `--unit <name>`, `--port <n>`, `--env-path <file>`, `--repo <checkout>`, `--no-restart`.

## Docker

```sh
cp .env.example .env && docker compose up -d --build   # on 127.0.0.1:7777, data in volumes
docker compose exec -it botons botons login claude      # or: botons login codex
docker compose exec botons botons pair --approve <code>   # the code the web app shows
```

[DOCKER.md](DOCKER.md) covers health checks, backup and restore, upgrades, the sandbox, and reaching it from other devices over HTTPS (Tailscale on the host or as a sidecar, or a public domain with Caddy).
