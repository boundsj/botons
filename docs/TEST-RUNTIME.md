# Test runtime measurements

Node 24 full-suite CI artifact: 1035 tests; test-runner wall 746.97 seconds. File durations include startup and teardown. Individual test durations are inclusive; do not sum suites and children. CI uses a two-core runner; local parallel runs contend differently.

A local Node 24 run with the built web app passed all 1035 tests in 118.04 seconds. A second run took 120.44 seconds with one loopback port collision in public-origin. Timings describe real runs, not a guarantee of deterministic execution.

## Slowest 30 files in CI

| File | Seconds | Cost visible in fixtures |
| --- | ---: | --- |
| browser-handover | 138.89 | Real Chromium profiles, HTTP/HTTPS sign-ins, cookie/secret checks, backups and restarts; intentional background-write windows use real timers. |
| browser-act | 75.44 | Real Chromium, approval delivery and denial, delayed page writes and fake CLI turns. |
| doctor | 53.23 | Repeated diagnostic CLI processes, fake provider login checks, backups and server probes. |
| installer | 41.75 | Release fixtures, installer subprocesses and a 30-attempt health failure with one-second polling. |
| api-brain | 23.55 | Loopback model servers, sandbox tools, fake CLI processes and scheduled routine polling. |
| web-state | 22.81 | Bundled React fixtures and live server state; repeated asynchronous state convergence. |
| browser | 19.44 | Real Chromium contexts and fake CLI turns against loopback sites. |
| time-limit | 18.68 | Real turn deadlines, fake CLI processes and waiting for cancellation/recovery. |
| restart | 15.09 | Server/CLI processes, draining real in-flight turns and crash recovery. |
| rehearsal | 14.37 | Real archive/restore processes and temporary servers/databases. |
| usage | 12.91 | Fake provider CLI processes and asynchronous session/usage collection. |
| public-origin | 11.25 | Built app in Chromium through a real loopback HTTP proxy. |
| api | 11.01 | Temporary database/server fixtures and asynchronous chat/routine turns. |
| connector-enabled | 10.59 | Temporary servers, fake CLIs and connector permission transitions. |
| switch-summary | 10.40 | Provider switches, fake CLI session summaries and asynchronous turns. |
| approvals | 9.44 | Live server approvals and fake CLI/tool request lifecycles. |
| routine-sessions | 9.18 | Fake CLI turns with session restart/resume and scheduled routines. |
| sessions | 8.21 | Fake CLI resume failures, timeouts and session recovery. |
| callbacks | 8.09 | Loopback callback servers, retries and fake CLI turns. |
| api-guards | 8.08 | Live HTTP server fixtures and request/approval boundary checks. |
| process | 7.92 | Real child processes, termination, crash cleanup and restart recovery. |
| providers | 7.68 | Fake provider CLI processes and protocol fixtures. |
| work-feed | 7.54 | Loopback MCP fixtures, polling/backoff timers and restart persistence. |
| mcp-startup | 7.50 | Fake MCP/CLI subprocess startup and timeout handling. |
| auth | 7.22 | Temporary HTTP servers and databases, pairing and device lifecycle. |
| effort | 7.11 | Fake provider CLI discovery, model caches and live server changes. |
| provider-readiness | 6.75 | Fake CLI readiness checks and diagnostic processes. |
| portable-durability | 6.36 | Database import rollback and fresh/restarted server fixtures. |
| notify | 6.05 | Loopback notification endpoints, retries and turn completion polling. |
| provider-switch | 5.92 | Fake CLI discovery/session transitions and live turns. |

## Slowest 30 individual tests in CI

Costs below describe the fixture implementation; they are source-based explanations, not CPU profiles.

| Test location and name | Seconds | Fixture cost |
| --- | ---: | --- |
| server/test/browser-handover.test.ts:622 HTTP: what the owner types (ordinary text, a one-time code, a password) is in no file once the handover ends, however it ends, nor in a backup or after a restart; the cookies stay | 32.23 | Real Chromium profiles, HTTP/HTTPS sign-ins, cookie/secret checks, backups and restarts; intentional background-write windows use real timers. |
| server/test/browser-handover.test.ts:622 HTTPS: what the owner types (ordinary text, a one-time code, a password) is in no file once the handover ends, however it ends, nor in a backup or after a restart; the cookies stay | 31.81 | Real Chromium profiles, HTTP/HTTPS sign-ins, cookie/secret checks, backups and restarts; intentional background-write windows use real timers. |
| server/test/installer.test.ts:159 health failure restores config, units and link and probes the saved port | 31.01 | Release fixtures, installer subprocesses and a 30-attempt health failure with one-second polling. |
| server/test/browser-act.test.ts:748 a page acted on sends nothing more on its own: not a timer's GET, an image, a beacon or keepalive as it unloads; a link opens its address; a fresh page loads as before | 13.43 | Real Chromium, approval delivery and denial, delayed page writes and fake CLI turns. |
| server/test/browser-handover.test.ts:572 HTTPS: a page's writes go only within the owner's moment, whatever sends them (an unloading page, a page leaving by itself, a closed tab, a worker), and each that goes is journaled | 12.65 | Real Chromium profiles, HTTP/HTTPS sign-ins, cookie/secret checks, backups and restarts; intentional background-write windows use real timers. |
| server/test/browser-handover.test.ts:572 HTTP: a page's writes go only within the owner's moment, whatever sends them (an unloading page, a page leaving by itself, a closed tab, a worker), and each that goes is journaled | 12.57 | Real Chromium profiles, HTTP/HTTPS sign-ins, cookie/secret checks, backups and restarts; intentional background-write windows use real timers. |
| server/test/browser-act.test.ts:803 over http: allowed, the request goes with exactly the cookies the jar held throughout, in their order, or none; a jar changed before the headers, between them and the jar's read, or after the card means no send | 10.97 | Real Chromium, approval delivery and denial, delayed page writes and fake CLI turns. |
| server/test/browser-act.test.ts:803 over https: allowed, the request goes with exactly the cookies the jar held throughout, in their order, or none; a jar changed before the headers, between them and the jar's read, or after the card means no send | 10.89 | Real Chromium, approval delivery and denial, delayed page writes and fake CLI turns. |
| server/test/doctor.test.ts:200 doctor names the Botons a missing or signed-out brain leaves without answers, and a usage limit they wait on | 10.87 | Repeated diagnostic CLI processes, fake provider login checks, backups and server probes. |
| server/test/browser-handover.test.ts:480 the kill switch, the connector taken away, a site removed, a revoked device, idle time and the server stopping each end or limit a handover | 10.83 | Real Chromium profiles, HTTP/HTTPS sign-ins, cookie/secret checks, backups and restarts; intentional background-write windows use real timers. |
| server/test/public-origin.test.ts:24 fresh app renders pairing through a Host-rewriting proxy in Chromium | 10.63 | Built app in Chromium through a real loopback HTTP proxy. |
| server/test/browser-act.test.ts:532 allowing sends what was held: not the form the page rewrote after, not its other writes, not a 307 resend; two decisions at once send it once | 10.60 | Real Chromium, approval delivery and denial, delayed page writes and fake CLI turns. |
| server/test/api-brain.test.ts:123 openai-api: asked in chat, it creates a routine with the Boton CLI; the schedule and the webhook run it | 10.43 | Loopback model servers, sandbox tools, fake CLI processes and scheduled routine polling. |
| server/test/api-brain.test.ts:123 anthropic-api: asked in chat, it creates a routine with the Boton CLI; the schedule and the webhook run it | 10.31 | Loopback model servers, sandbox tools, fake CLI processes and scheduled routine polling. |
| server/test/doctor.test.ts:83 exposure: auth off fails; every interface warns on a machine and is required in a container; plain HTTP off the tailnet warns | 10.22 | Repeated diagnostic CLI processes, fake provider login checks, backups and server probes. |
| server/test/browser-handover.test.ts:450 a page's own background writes are refused but right after the owner's input; nothing goes once it ends | 9.30 | Real Chromium profiles, HTTP/HTTPS sign-ins, cookie/secret checks, backups and restarts; intentional background-write windows use real timers. |
| server/test/doctor.test.ts:45 a running, paired install with signed-in CLIs; then a backup, a stale backup, and a signed-out CLI | 9.21 | Repeated diagnostic CLI processes, fake provider login checks, backups and server probes. |
| server/test/browser-act.test.ts:479 denied, not decided while the step waits, the turn ending, Stop: nothing is sent, and a late decision is refused | 8.14 | Real Chromium, approval delivery and denial, delayed page writes and fake CLI turns. |
| server/test/doctor.test.ts:153 doctor counts routine runs to check: failed and not retried in the last week, interrupted ones, and held ones | 7.37 | Repeated diagnostic CLI processes, fake provider login checks, backups and server probes. |
| server/test/browser-handover.test.ts:534 a Claude turn is refused its browser during a handover, and reads the site signed in after it | 6.64 | Real Chromium profiles, HTTP/HTTPS sign-ins, cookie/secret checks, backups and restarts; intentional background-write windows use real timers. |
| server/test/browser-handover.test.ts:534 a Codex turn is refused its browser during a handover, and reads the site signed in after it | 6.08 | Real Chromium profiles, HTTP/HTTPS sign-ins, cookie/secret checks, backups and restarts; intentional background-write windows use real timers. |
| server/test/browser-handover.test.ts:396 while the owner has it the Boton is refused, whatever it asks; after, it reads the site signed in | 5.33 | Real Chromium profiles, HTTP/HTTPS sign-ins, cookie/secret checks, backups and restarts; intentional background-write windows use real timers. |
| server/test/browser.test.ts:596 taking the connector away, Stop, and deleting the Boton close its browser at once, and a screenshot never follows the Boton's link | 4.94 | Real Chromium contexts and fake CLI turns against loopback sites. |
| server/test/restart.test.ts:109 a restart lets running turns finish, refuses new work meanwhile, and runs what was queued afterwards with its trigger and payload | 4.86 | Server/CLI processes, draining real in-flight turns and crash recovery. |
| server/test/rehearsal.test.ts:418 pax values and header fields: refused as the restore refuses them, valid ones pass with it | 4.80 | Real archive/restore processes and temporary servers/databases. |
| server/test/sessions.test.ts:40 model not found, command not found and a timed-out resume are not retried, and keep the session | 4.33 | Fake CLI resume failures, timeouts and session recovery. |
| server/test/browser-handover.test.ts:337 the owner signs in with fixed inputs and a live view; the credentials go only to the site; frames are kept nowhere | 4.27 | Real Chromium profiles, HTTP/HTTPS sign-ins, cookie/secret checks, backups and restarts; intentional background-write windows use real timers. |
| server/test/browser-act.test.ts:702 a GET a click or typing makes waits on a card like a form: a GET form, a script GET, typing; none reaches the site before the owner decides | 4.24 | Real Chromium, approval delivery and denial, delayed page writes and fake CLI turns. |
| server/test/connector-enabled.test.ts:213 turning it off says which turn running now keeps it; one started since the owner looked is a new review; a turn not yet started when it goes off goes without | 4.22 | Temporary servers, fake CLIs and connector permission transitions. |
| server/test/browser-act.test.ts:644 a Claude turn types and clicks through the browser connector; the form goes only once the owner allows its card | 4.20 | Real Chromium, approval delivery and denial, delayed page writes and fake CLI turns. |

## Tier budget

`npm test` selects 30 files (135 tests): in-process, each under about a second, with no browser, Botons server, outside network, agent CLI or real deadline, and none reading the docs. Short local child processes (`sh`, `node -e`), a loopback socket and millisecond timers are allowed. `npm run test:full` runs all 138 files; new files default there. Both use four concurrent file processes; each file keeps Node’s normal isolated process. No tests are deleted. Keep timing JSON as CI artifacts instead of committing logs or machine paths.

`web-server-log.test.ts` stays in the full tier: alone it takes about 2.6 s, and alongside the fast files it stretched `npm test` from about 3 s to 12 s.

## Measured tier results

| Workload | Observed wall time | Coverage |
| --- | ---: | --- |
| Local `npm test`, every file (reference) | 181.5 s | 1,138 tests; 1 skipped without the web build |
| Local `npm test`, fast files, Node 24 | 1.8–2.0 s | 135 tests in 30 files pass |
| Local fast job steps, Node 24, clean `node_modules` | 10.8 s | `npm ci` 1.2 s, typecheck 4.6 s, `npm test` 5.0 s (warm npm cache; 25 files then) |
| Local `npm run test:full`, Node 24, before the web build | 157.9 s | 1,157 tests; 1 skipped without the web build |
| Local full-suite reference (earlier) | 118.04 s | 1,035 tests pass |
| CI full-suite reference, Node 24 | 746.97 s | Full test runner, excluding other workflow steps |
| CI full workflow reference | 15 min 24 s | Full matrix, browser, recovery, Docker, installer and performance |

These are observed runs on one machine, not guarantees. Local runs share the
machine with other work, so the same suite varies by a minute or more. The fast
tier reduces work on pull requests; the full suite is not faster than its reference.

A pull request runs two short jobs, `Node 24` and `check:public`, an estimated two
rounded Linux runner minutes when each stays under one minute. A docs- or image-only
pull request skips the install, typecheck and tests inside `Node 24`. The full
tier (two full Node jobs, the handover quarantine, Docker, the Debian installer and
the Codex helper) runs only weekly, by hand, or with the `full-ci` label. These are
usage estimates, not invoiced charges.

Required branch checks are `Node 24` and `check:public`; merging needs only those.
Deploy runs the full suite. Keep Node 26 in the full tier. Its handover quarantine
does not establish a root-cause fix: remove it after that fix and 20 repeated
successful Node 26 CI runs.

### Codex helper compatibility probe

`python3 scripts/check-codex-sandbox.py /absolute/codex-160 /absolute/codex-166 /absolute/codex-167`
exercises the real `codex sandbox` helper without credentials or a model endpoint.
Supply Linux binaries from `@openai/codex` versions 0.160.0, 0.166.0 and
0.167.0 respectively; select Debian bubblewrap 0.12.0 on PATH. The probe
asserts the old helper's descriptor failure, workspace/shared writes, denial
of private reads and protected missing-file creation with supported helpers,
and the symlink failure followed by a successful regular-copy workaround.
It creates and removes only its own temporary directory under `/var/tmp`.
Run on a disposable Linux host allowing user and mount namespaces. This is a
manual compatibility probe: full-ci exercises sandbox and Debian installer
coverage, but does not provision this three-version CLI matrix or pin its
bubblewrap to 0.12.0. A normal restricted Docker container cannot run it.

The `Codex helper on Debian 13 with masked proc` full-CI job uses a disposable
privileged Debian container with bubblewrap 0.12.0 and Codex 0.167.0. It checks
the production Workspace tool runner and actual offline session initialization,
then bind-masks `/proc/sys/kernel/random/boot_id` in a private container mount
namespace and checks that both failures are detected before a turn. It also
records a nested-helper diagnostic using the production sandbox arguments.
No credentials, host mounts, exposed ports or model service are used. Run it
with `scripts/codex-proc-smoke.sh` where Docker access is available.
