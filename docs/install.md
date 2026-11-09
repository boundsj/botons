# Installing Botons

Botons runs on your own computer: Linux, or macOS on Apple Silicon or Intel, x64 or arm64. Other ways to run it: [Docker](DOCKER.md), or a [systemd service from a checkout](operations.md#run-it-as-a-service).

## What you need

- **Node 20 or newer**, to launch the installer. It downloads its own Node 24 for the server.
- **Claude Code or Codex**, signed in on that computer (or let the installer [add one for you](#choosing-a-brain-at-install)). Codex needs a stable 0.166.0 or newer. You can also run Botons on an [API key](api-keys.md) instead.
- **On Linux, bubblewrap 0.11 or newer** for the Workspace sandbox. The installer offers to install it with apt or dnf.

## Install

```sh
npx getbotons install
```

1. Open the URL the installer prints.
2. Approve the pairing code it shows, on the same computer: `botons pair --approve <code>` (use `~/.local/bin/botons` until `botons` is on your PATH).
3. Follow setup to make your first Boton. [First run](first-run.md) walks through each step.

The installer asks before changing the host, starting services, or installing missing packages with apt or dnf. It runs as your ordinary user and:

- installs under `~/.local/share/botons`, with Node under `node/<version>` and the app under `releases/<version>`;
- keeps your data under `~/.botons`;
- links `~/.local/bin/botons`. When that folder is missing from PATH, it checks the login profile and offers a marked shell configuration block only when needed. Reload the login shell (`exec $SHELL -l`) or open a new terminal; until then use `~/.local/bin/botons`. Uninstall removes only the block the installer added;
- starts the server as a user service (systemd on Linux, a launchd LaunchAgent on macOS), with a daily backup.

`botons doctor`, `botons backup`, `botons restore` and `botons pair` use the service's environment. `botons start`, `botons stop`, `botons restart` and `botons status` manage the service. Sign in to your agent CLI yourself, open the app, and approve its code with `botons pair --approve <code>`.

### Options

| Option | What it does |
| --- | --- |
| `--yes` | Consents to installation and package and service changes, linger included. Without it, linger asks separately. |
| `--dry-run` | Prints destinations without changing anything. |
| `--home <data>` | Chooses the data folder. |
| `--host <address>` | Chooses the bind address. |
| `--public-url <https-url>` | Saves both `BOTONS_PUBLIC_URL` and `BOTONS_OAUTH_PUBLIC_URL` as that HTTPS origin, for the app and for remote OAuth connector callbacks (also on repair, after consent). |
| `--no-sudo` | Refuses missing system dependencies and prints any privileged linger fix instead of running sudo. |
| `--brain claude` or `--brain codex` | Installs that CLI if it is missing (see below). |
| `--no-service` | For disposable test environments: installs files without creating or starting services or timers, or running doctor. Start it with `botons serve`. |

Linger (Linux, so the service starts at boot) is checked first; an access-denied failure offers the exact sudo command after consent. If linger fails, the service stays enabled and running, with a warning and the recovery command.

### Choosing a brain at install

On a fresh install with no CLI, choose one missing CLI when prompted, or pass `install --brain codex` (or `--brain claude`). Botons shows the exact official npm install command and asks before running it. For an unattended fresh install, `install --brain codex --yes` selects Codex and consents; `--yes` alone never selects a CLI.

The bundled Node runs npm into Botons' own per-CLI prefix, without sudo. Existing binaries and `BOTONS_CLAUDE_BIN` / `BOTONS_CODEX_BIN` overrides are kept. Installing creates no login: you sign in during setup's Brains step. The managed Claude copy has its own updater turned off, so updates stay under your control. This option is for fresh installs; it refuses an existing managed server rather than change a CLI under running turns. Later updates happen in **Settings → Brains** ([Brains](brains.md#installing-and-updating-a-cli)).

## Upgrade, repair, uninstall

`install`, `repair` and `upgrade` can be run again. Each backs up an existing database first.

- **Upgrade.** Run `npx getbotons@latest install` again to install the newest published release over your install. To choose another source, run `botons upgrade --source /path/to/getbotons-<version>.tgz` (a source folder, an HTTPS tarball or a Git URL also work; Git takes `--ref`). The chosen source is saved for later `botons upgrade` runs, and `botons upgrade` never assumes a registry release on its own. Failed health checks switch the code back. A schema upgrade means the old code can only serve again after restoring the backup; the installer never restores data by itself. The server shows when a newer Botons release is available; nothing upgrades automatically.
- **Repair** reinstalls the current release and its service.
- **Uninstall** (`botons uninstall`) stops the service and removes the managed program files, keeping data and configuration. `--purge` also deletes the data, only after a separate interactive confirmation, even with `--yes`.

## Installing from a tarball or Git

A release tarball (Node 20+ can launch the installer):

```sh
npx -y file:/path/to/getbotons-<version>.tgz install
```

As a fallback, straight from source in the public Git repository:

```sh
npx -y git+https://github.com/boundsj/botons.git install
```

npm clones the Git dependency to launch the plain JavaScript bin. There is no `prepare` step, so npm installs no development dependencies first. The entry runs on Node 20 or 22, downloads the official Node 24, checks its SHA-256 against the official HTTPS checksum list, and uses it to install dependencies and build the web app. No GitHub token is needed.

- **A branch, tag or commit:** keep the npx URL plain and pass `install --source <git-url> --ref <ref>`; the installer fetches that ref itself. Avoid `#sha` fragments in the npx URL: Node 22's npm has failed to pack Git dependencies in that form. Git sources are versioned as the package version plus the checked-out commit, so updating a branch makes a distinct release. For example, `botons upgrade --source git+https://github.com/boundsj/botons.git --ref main` saves that source for the next `botons upgrade`.
- **A stale installer:** npx can reuse a cached installer after the branch changes. The startup line prints the running installer's commit when available and always its code fingerprint (a selected `--ref` is separate from that). To skip stale npx state without deleting any cache or install, use a fresh cache folder, which you can remove afterwards:

  ```sh
  npm_config_cache="$(mktemp -d)" npx -y git+https://github.com/boundsj/botons.git install
  ```

  If npm fails before the startup line, the installer has not run.

## macOS

The installer uses a per-user launchd LaunchAgent for the server and the daily backup. It runs after you log in; it does not start before login or while the Mac sleeps. LaunchAgents live in `~/Library/LaunchAgents`; logs are beside the environment file, under `~/.config/botons/logs`. Checkout installs use `npm run service:install` and `npm run backup:install`, which print their `launchctl` commands.

Choose **Full computer access** for your Botons on macOS. Full computer access runs as your user, so give it only to Botons you trust. Some things need Linux and are refused on macOS, with no weaker sandbox in their place:

- **Workspace access** and connectors that run a local command (both need bubblewrap). Remote MCP connectors work.
- Workspace file browsing, downloads and previews, uploads, saving browser screenshots, the trash, Restore from trash, Clear inbox, installing skill packages, CLI file arguments (`--file` and `--payload @file`) and instruction-file rollback. These need Linux folder handles: Node can't safely address entries in an open folder on macOS while another process swaps its path.

Backing up and restoring the server work. A macOS backup with unreadable files fails, keeping its database snapshot and older backups; fix the file permissions and try again.

The managed browser finds Google Chrome or Chromium in `/Applications` or your own Applications folder, as well as Playwright's browser. `BOTONS_BROWSER_PATH` can choose another copy.

## Upgrading an install made under an earlier name

An install made before Botons had its current name upgrades in place, keeping every paired device, token, grant, webhook URL, OAuth sign-in, browser profile, API key, spending record and file:

- **The data folder and database.** On its first start the server backs the data folder up (into its `backups/`, as `botons backup` does), then moves it to `~/.botons` and gives the database its current name, leaving a link at each earlier path so anything that names it keeps working. A data folder named by `BOTONS_HOME` somewhere else stays where it is; only the database is renamed. If the backup fails, nothing moves and the server keeps using the folder where it is.
- **The service.** `npm run deploy` stops the earlier unit, moves the release folder to `~/.local/share/botons`, writes `~/.config/botons/env` from the earlier env file with every setting under its `BOTONS_*` name, starts `botons.service` (and `botons-backup.timer`) and disables the earlier units. If the new service doesn't come up healthy, it starts the earlier unit again. The installer does the same for an install it made (run `botons repair`; uninstall refuses until then). `npm run migrate:names` does it by hand, and `npm run migrate:names -- --rollback` undoes it.
- **Settings and the command.** Settings, and the command a Boton runs, still work under their earlier names for this release; `botons doctor` names each one still in use, as deprecated.
- **Docker.** Before the first `docker compose up` of this version, run `sh docker/legacy-names.sh` once: it stops the earlier Compose project, copies its volumes into the `botons` project's (the earlier ones stay as they were), writes `botons.env`, rewrites `.env` with current setting names, and keeps a Tailscale sidecar's name. `sh docker/legacy-names.sh --rollback` starts the earlier project again.

Botons start a new session after the upgrade, as after any change to their instructions; their memories, routines, workspace and chat history carry over.
