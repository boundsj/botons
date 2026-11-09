# Configuration

Botons reads its settings from environment variables. For the service they live in `~/.config/botons/env` (the service doesn't read your shell profile); restart Botons after changing them (`botons restart`). In Docker, the server's settings go in `botons.env` ([DOCKER.md](DOCKER.md)). Empty counts as unset; durations take `ms`, `s`, `m`, `h` or `d`.

Most of what you set up day to day (access, brains, API keys, connectors, push notifications) lives in **Settings** in the app, not here.

| Variable | Default | |
| --- | --- | --- |
| `BOTONS_HOME` | `~/.botons` | Data folder: database, workspaces, shared folder, backups |
| `BOTONS_PORT` / `PORT` | `7777` | `BOTONS_PORT` wins |
| `BOTONS_HOST` | `127.0.0.1` + Tailscale IP | Comma-separated bind addresses; must include `127.0.0.1`, `0.0.0.0` or `::` |
| `BOTONS_NO_TAILSCALE` | | `1`: no `tailscale` calls (and no one-click pairing) |
| `BOTONS_TAILSCALE_POLL_MS` | `20s` | How often to look for the Tailscale address |
| `BOTONS_OWNER_LOGIN` | this machine's Tailscale login | Whose devices pair with one click |
| `BOTONS_AUTH` | `on` | `off` lets every request in without a token |
| `BOTONS_PUBLIC_URL` | MagicDNS URL | Base of the links in pushes and of webhook URLs |
| `BOTONS_ALLOWED_HOSTS` | | Extra names accepted in the `Host` header (by Vite too) |
| `BOTONS_HOOKS_PORT` | | A second port serving only webhooks (for Tailscale Funnel) |
| `BOTONS_HOOKS_HOST` | `127.0.0.1` | Where that port listens |
| `BOTONS_HOOKS_PUBLIC_URL` | | Public base of webhook links, e.g. that port's Funnel URL |
| `BOTONS_CALLBACK_ALLOW` | | Private hosts, addresses and CIDRs routine callbacks may reach |
| `BOTONS_OAUTH_PUBLIC_URL` | | HTTPS origin that reaches `/oauth/callback`, for OAuth connectors ([Connectors](connectors.md#the-https-callback)) |
| `BOTONS_OAUTH_ALLOW` | | Private hosts, addresses and CIDRs OAuth connectors may reach (a tailnet server, say) |
| `BOTONS_BROWSER_PATH` | a Chromium Playwright installed, else the system's | The Chromium the managed browser runs |
| `BOTONS_BROWSER_HEADED` | | `1`: show its window, on a host with a display |
| `BOTONS_BROWSER_SANDBOX` | `1` | `0`: run Chromium without its own sandbox, where a host can't start it even with the image's seccomp profile (the container is then its only boundary) |
| `BOTONS_BROWSER_ALLOW` | | `host:port` addresses on this machine or a private network a Workspace Boton's browser may be given |
| `BOTONS_TZ` | system timezone | Default timezone for new Botons |
| `BOTONS_MAX_CONCURRENT` | `3` | Agent processes at once (1–64) |
| `BOTONS_TURN_TIMEOUT_MS` | `20m` | Turn time limit, for chat turns and routine runs; a routine may have a shorter one of its own |
| `BOTONS_APPROVAL_WAIT` | `5m` | How long an Ask first call waits for you |
| `BOTONS_SCHEDULER_MS` | `10s` | How often due routines are checked |
| `BOTONS_ROUTINE_RUNS_PER_HOUR` | `30` | Webhook and manual runs per routine per hour |
| `BOTONS_RUNS_PER_HOUR` | `100` | Webhook and manual runs per hour, all routines |
| `BOTONS_RUN_RETRIES` | `3` | Retries of a run that failed on a network error |
| `BOTONS_RUN_RETRY_DELAY` | `1m` | Wait before the first retry (then 5 and 15 times that) |
| `BOTONS_ASKS_PER_PAIR_PER_HOUR` | `20` | `botons ask`s between two Botons per hour |
| `BOTONS_ASKS_PER_HOUR` | `100` | Asks between all Botons per hour |
| `BOTONS_LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` |
| `BOTONS_SSE_PING_MS` | `25s` | `/api/events` heartbeat |
| `BOTONS_DRAIN_MS` | `2m` | On stop, how long running turns get to finish |
| `BOTONS_CLAUDE_BIN` / `BOTONS_CODEX_BIN` | `claude` / `codex` | CLI paths |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | | API keys used when none is saved in **Settings → API keys** ([API keys](api-keys.md)). Never passed to agent CLIs; Full computer Botons can read the server's environment, so prefer saving them in Settings |
| `BOTONS_PRIVATE_PATHS` | | More paths Workspace Botons can't read, `:`-separated |
| `BOTONS_ENABLE_MOCK` | | `1` adds the `mock` provider |
| `BOTONS_CONTAINER` | | `1` (the Docker image sets it): `npm run doctor` checks for a container |
| `BOTONS_DEPLOY_ROOT` | `~/.local/share/botons` | Where `npm run deploy` keeps releases |
| `BOTONS_BACKUP_RSYNC_TO` | | Where `npm run backup` also copies each backup |
| `BOTONS_WEB_HOST` / `BOTONS_WEB_PORT` | `127.0.0.1` / `5173` | `npm run dev`'s Vite server |
| `BOTONS_API` | the dev API | Where Vite proxies `/api` and `/hooks` |
| `BOTONS_DEV_HOOKS_PORT`, `_HOST`, `_PUBLIC_URL` | | `npm run dev` drops the shell's `BOTONS_HOOKS_*`; these take their place |
