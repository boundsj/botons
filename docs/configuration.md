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
| `BOTONS_APNS_KEY_FILE`, `BOTONS_APNS_KEY_ID`, `BOTONS_APNS_TEAM_ID`, `BOTONS_APNS_TOPIC` | | Push to the Botons app through Apple (see "Push to the native app"): the key's `.p8` file, its key id, your team id and the app's bundle identifier. All four, or none |
| `BOTONS_BROWSER_APNS_DOWNLOAD_DIR` | | Temporary operator-only APNs key capture directory, mode 0700, outside data/source. Off when unset. Requires a one-use session grant; see [Private APNs key import](browser.md#operator-authorized-private-apns-key-import). This does not configure APNs delivery |
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
| `BOTONS_TEAM_SUPERVISOR_MS` | `30s` | How often the team supervisor looks at teams' work ([Teams](using-botons.md#teams)) |
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

## Push to the native app

Besides ntfy, the server can push to the Botons app on an iPhone or iPad through Apple's push service. It is off until the server has all four settings in its environment: `BOTONS_APNS_KEY_FILE` (the `.p8` key Apple gives you), `BOTONS_APNS_KEY_ID`, `BOTONS_APNS_TEAM_ID` and `BOTONS_APNS_TOPIC` (the app's bundle identifier). A partial set, a key file that cannot be read or one that is not an EC P-256 key stops the server at start (exit 78) and names the setting. The settings come only from the environment: they are never saved in the database, a backup or an export, and no API answer holds them; `npm run doctor` names them and never prints the key. Keep the key file outside the data folder, readable only by the server's user (the doctor warns when other users can read it). In Docker, mount it into the container and point `BOTONS_APNS_KEY_FILE` at the mounted path.

The app registers its own device (`PUT /api/devices/current/push` with the token Apple gave it and its environment, `development` or `production`; `GET` reads it and `DELETE` removes it). That is for a paired device and its own registration only: a Boton's token is refused. Revoking a device or signing it out removes its registration, and so does an answer from Apple that the token is no longer valid (a 410 counts only with Apple's time, and only when the device did not save that token after it). The answer says whether the server is set up (`configured`) so the app can explain why nothing arrives.

A push goes out for each new completed Boton reply, including visible routine results, one request to Apple per registered device. Streaming text, tool steps, quiet replies, replies to a reset conversation and history or reconnect replays send nothing. Routine test runs send no pushes. A routine's notification policy still governs ntfy and explicit notifications; it does not turn off native alerts for its visible replies. A routine result sends one native alert even when its policy also sends an ntfy result. These are best-effort attempts after the reply is saved; missed or failed attempts are not replayed after restart.

The existing alerts also reach the app: a run's failure, `botons notify`, an approval request, a browser handoff and a connector that needs signing in. All native alerts follow **Show text in pushes**: with it off the alert says only that there is something new, or that an approval is needed. The payload carries the Boton's id as the thread and the ids the app opens (`botId`, and `messageId` and `approvalId` when there is one). A payload is kept within Apple's 4096 bytes by cutting the text on whole characters. Requests go only to Apple's own hosts (the sandbox host for a `development` registration) and follow no redirects. **Settings → Health and backups** shows how they have gone beside ntfy's, once the server is set up for them.

In the app, open **Settings → Notifications → Notify this device** and allow notifications. Permission is requested there, not at launch. Registering a device turns its native pushes on; ntfy's **Send push notifications** switch governs ntfy only. The app shows a banner in the foreground unless that chat is visible and being read. Tapping a message notification opens its chat and message, including after a cold launch. The signed app needs the Push Notifications capability and an `aps-environment` entitlement that matches its provisioning profile. Debug builds use Apple's development service; distribution builds use production. The server's topic must match the signed app's bundle identifier, and the push key must authorize that app's team and environment. Configuring these settings and deploying server changes are separate operator actions; rebuilding the app alone does not update the server.
