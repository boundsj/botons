# State machines and transition ownership

Botons has several cooperating state machines. Some have named states and transition tables; others encode their state in database flags, promises, timers, optional fields, or React hooks. This inventory groups those mechanisms by independently owned lifecycle. Repeated loading/error forms are grouped rather than counted as separate machines. It is a source review, not a proof that every possible interleaving is safe.

The server owns durable decisions. Clients render them and own only interaction state. A status label alone often does not describe the whole state: a queued run may be held for a provider, a working item may be held for its owner, and an open event stream may still be catching up.

## Design decision

Keep transitions with their existing owners and strengthen the boundaries where work suspends or commits. Use the existing transaction API for durable changes, the existing cancellation reason for interrupted work, and the identity of the submitted draft for chat completion. These protect the owner's work (UX), give contributors one place to understand each transition (DX), and keep Botons' instructions, wake-ups and cancellation consistent with what actually happened (AX).

A shared state-machine framework would add migration and integration risk without solving these boundaries by itself. Turning every group of flags into an enum would also conflate independent states, such as queue eligibility and provider readiness. Neither is necessary for these fixes. The chat submission, shutdown and browser handback fixes do not change the database, API, provider prompt or session keys. Database and session changes for feature upgrades are listed in the changelog.

Transition rules to preserve:

1. Commit a durable transition and the work it promises together; publish events and wake workers after commit.
2. A stop applies during preparation as well as provider execution. The first ending reason wins; untouched queued work keeps its restart semantics.
3. Async completion belongs to the operation and resource that started it. It must not erase a newer draft, settle a different connection, or replace a newer event.
4. Retry needs an explicit meaning: resume existing work, create a new attempt, or refuse a duplicate. Terminal states must not silently reopen.
5. Recovery reads durable facts. In-memory activity and client snapshots are projections, not authority.

## Execution and collaboration

State names joined by arrows describe paths, not permission to take every transition. Follow the linked owner for guards and alternate paths. Test names below refer to files under `server/test/`.

| Lifecycle | States and transitions | Owner and invariant | Existing verification |
| --- | --- | --- | --- |
| Server and engine | accepting → maintenance/draining → closing; maintenance can resume | [app.ts](../server/src/app.ts), [engine.ts](../server/src/engine.ts): stop intake before draining; interrupt only work that has begun | `shutdown`, `restart`, `cli-install` |
| Per-Boton job | queued → slot wait → read/setup → provider → ending → released | [engine.ts](../server/src/engine.ts): `Job.wait`, `read`, `turn`, `aborted`, `spawned` encode phases; cancellation reaches setup before a controller exists | `shutdown`, `pause`, `run-cancel`, `time-limit` |
| Chat delivery | pending `1` → in-flight `2` → consumed `0`; interrupted work can return to `1` | [store.ts](../server/src/store.ts), [engine.ts](../server/src/engine.ts): recovery bounds repeated cutoffs; messages survive process loss | `restart`, `turns`, `sessions` |
| Routine run | queued → running → succeeded/failed; skipped; queued retry/hold | [store.ts](../server/src/store.ts), [engine.ts](../server/src/engine.ts): attempts, retry time, holds, cancellation and timeout are additional state; manual retry creates another run | `routines`, `run-retry`, `run-cancel`, `runs-attention` |
| Routine scheduling | enabled/paused; due → queued/skipped; one-off → retired | [scheduler.ts](../server/src/scheduler.ts), [schedule.ts](../server/src/schedule.ts), [store.ts](../server/src/store.ts): advance schedule once, respect capacity and starter gates | `schedule`, `routines`, `quiet-triggers` |
| Turn accounting | running → ok/error/stopped/timeout/interrupted | [store.ts](../server/src/store.ts), [engine.ts](../server/src/engine.ts): finish metrics and run outcome consistently | `turns`, `time-limit`, `usage` |
| Provider readiness | unknown/ready/unavailable/signed-out/usage-limited; hold → reset/recheck | [readiness.ts](../server/src/providers/readiness.ts), [engine.ts](../server/src/engine.ts): persisted cooldown and wake timers differ from current job status | `provider-readiness`, `usage`, `workspace-status` |
| Provider sessions and switching | fresh/resume; lost → fresh; switch preview → drain → handoff → target session | [engine.ts](../server/src/engine.ts), [store.ts](../server/src/store.ts), [replay.ts](../server/src/replay.ts): scope and generation fence late session writes | `sessions`, `routine-sessions`, `provider-switch-turns`, `switch-summary` |
| CLI process | spawning → streaming → result/stop/timeout → exit/reap | [process.ts](../server/src/providers/process.ts), [cli-turn.ts](../server/src/providers/cli-turn.ts): first ending wins; descendants are cleaned up | `process`, `providers`, `mcp-startup` |
| API provider loop | request → tool calls → request or finish/fail/abort | [api-brain.ts](../server/src/providers/api-brain.ts), [api-wire.ts](../server/src/providers/api-wire.ts), [api-history.ts](../server/src/providers/api-history.ts): effect-aware retries, bounded loop, key/session fencing | `api-brain`, `api-wire`, `api-spending` |
| Spending | reserved → settled/held/released; interrupted reservation → held | [spend.ts](../server/src/spend.ts): one settlement; uncertain billed work is not released as free | `api-spending`, `api-keys` |
| Approval and execution receipt | pending → allowed/denied/expired/cancelled; allowed receipt → used | [approvals.ts](../server/src/approvals.ts): guarded decision, exact action and one-use receipt; deferred and in-turn waiters differ | `approvals`, `connector-access` |
| Transcript card | shown, or pending → answered/declined/expired/refused | [cards.ts](../server/src/cards.ts), [shared/cards.ts](../shared/cards.ts): server validates the answer, transaction includes follow-up | `cards` |
| Starter activation | installed paused → test → pass/fail/stale → enabled or owner override | [starter-gate.ts](../server/src/starter-gate.ts), [starters.ts](../server/src/starters.ts): evidence belongs to the reviewed settings | `starter-gate`, `starter-readiness`, `starters` |
| Team | active/paused/done/archived | [teams.ts](../server/src/teams.ts): budgets, reviewed completion, pause reason and owner actions constrain transitions | `teams-store`, `team` |
| Team item (explicit table) | open/working/blocked/done/cancelled | [shared/teams.ts](../shared/teams.ts): `ITEM_TRANSITIONS` and `transitionRefusal`; assignment generations reject stale actors | `teams-rules`, `teams-store` |
| Team delivery | queued → dispatched → handled; cancel/expire; unstarted delivery may requeue | [teams.ts](../server/src/teams.ts): transactional outbox and pending chat insertion; restart recovery | `teams-store`, `team` |
| Team supervision and escalation | wait/check-in/escalate/hold; kickoff/wrap-up; escalation open → answered/closed | [team-supervisor.ts](../server/src/team-supervisor.ts), [shared/teams.ts](../shared/teams.ts): pure assessments, watermarks, bounded nudges and lifetime counters | `teams-rules`, `teams-store` |
| Reaction follow-up | reaction present/removed; follow-up queued → run/withdrawn | [reactions.ts](../server/src/reactions.ts): remove only pending work; turning follow-ups off does not undo completed work | `reactions`, `web-reactions` |
| Inter-Boton ask | queued → delivered/answered, with chain/hop limits | [engine.ts](../server/src/engine.ts), [ask-rules.ts](../server/src/ask-rules.ts): chain state bounds recursion and coordinates waiting work | `ask-rules`, `team` |

## Access, integrations and operations

| Lifecycle | States and transitions | Owner and invariant | Existing verification |
| --- | --- | --- | --- |
| Owner claim and pairing | unclaimed → claimed; pairing pending → approved → consumed/expired | [auth.ts](../server/src/auth.ts): claim is sticky, pairing is one-use and time-bounded | `auth`, `setup` |
| Device/turn credentials | active → revoked; turn end/restart → revoked; preview key → expired | [auth.ts](../server/src/auth.ts), [api.ts](../server/src/api.ts): revocation terminates access, including live streams | `auth`, `security-binding` |
| Setup and access mode | incomplete → completed; access mode changes under reachability guards | [setup.ts](../server/src/setup.ts): an access change cannot bypass caller checks | `setup`, `public-origin` |
| OAuth sign-in | pending → consumed → connected/refused; pending → expired | [oauth-connections.ts](../server/src/oauth-connections.ts), [oauth.ts](../server/src/oauth.ts): one-time state and connection ownership | `oauth`, `oauth-app-signin` |
| OAuth token | usable → refreshing → updated/backoff/reconnect | [oauth-connections.ts](../server/src/oauth-connections.ts): generation guards and refresh-marker recovery | `oauth`, `work-feed` |
| Connector configuration/test | configured → testing → current result or superseded result | [connectors.ts](../server/src/connectors.ts): fingerprint binds evidence to configuration | `connector-test`, `connector-enabled`, `managed-connectors` |
| MCP session | initialize → initialized/list tools → requests → close/fail | [mcp-client.ts](../server/src/mcp-client.ts), [mcp-stdio.ts](../server/src/providers/mcp-stdio.ts): request correlation, session cleanup and bounded startup | `mcp-startup`, `connector-test`, `oauth` |
| API key | absent/environment/saved; test pending → current/superseded | [api-keys.ts](../server/src/api-keys.ts): generation and source distinguish current credentials from stale evidence | `api-keys` |
| Browser process | absent → starting → running → closing | [browser.ts](../server/src/browser.ts): process ownership, policy checks and cleanup | `browser`, `browser-act`, `browser-proxy` |
| Owner browser takeover | available → starting → owned → ending → available | [browser.ts](../server/src/browser.ts), [browser-handover.ts](../server/src/browser-handover.ts): one device, input serialization, idle/max deadlines, tool exclusion | `browser-handover`, `browser-request` |
| Browser handoff (explicit reducer) | requested → taken → handed-back; requested → closed | [shared/handoff.ts](../shared/handoff.ts), [browser-handoff.ts](../server/src/browser-handoff.ts): terminal card and pending wake note commit together; wake after commit | `browser-handoff` |
| Browser key download | intent → claimed → saved/refused/failed | [browser-key-download.ts](../server/src/browser-key-download.ts): one-use claim, bounded credential handling | `browser-key-download` |
| Work-feed polling | scheduled → polling → scheduled/backoff/stopped | [work-feed.ts](../server/src/work-feed.ts): cursor, deduplication and wake transaction; shutdown aborts requests and prevents rescheduling; authority generations reject stale polls | `work-feed` |
| Work-feed delivery | unseen → held/delivered/skipped | [work-feed.ts](../server/src/work-feed.ts): delivery policy is separate from polling success | `work-feed` |
| Webhook ingress | unseen → accepted run; duplicate → existing result/retry decision | [hooks.ts](../server/src/hooks.ts), [webhooks.ts](../server/src/webhooks.ts): signature checks and durable deduplication precede work | `hooks`, `webhook-trust` |
| Callback egress | pending → sending/retrying → delivered/failed; restart resumes pending | [callback.ts](../server/src/callback.ts), [store.ts](../server/src/store.ts): at-least-once delivery; run id identifies duplicates | `callbacks`, `callback-recovery` |
| Push and device registration | configured/on/off; in-flight → latest success/failure; device registered → removed/replaced | [notify.ts](../server/src/notify.ts), [apns.ts](../server/src/apns.ts): configuration fingerprint and attempt order fence stale results | `notify`, `apns`, `apns-routes` |
| Trash and cleanup | live file → trash → restored/purged | [trash.ts](../server/src/trash.ts): claimed names, pins and partial-operation handling protect unrelated files | `trash`, `pins` |
| Backup and restore | partial → committed backup; restore staged → original set aside → activated/rollback | [backup.ts](../server/src/backup.ts): filesystem and SQLite boundaries; no in-place experiment on an install | `backup`, `restore` |
| Restore rehearsal | idle → running → passed/failed; crash → interrupted | [rehearsals.ts](../server/src/rehearsals.ts): one bounded child, durable sanitized result | `rehearsal`, `operations` |
| Portable configuration | exported → previewed → imported/refused | [portable.ts](../server/src/portable.ts): reviewed snapshot, explicit grants, secret-free import and transactional failure | `portable`, `portable-durability`, `portable-boundaries`, `portable-caps` |
| Skill/template installation | discovered → reviewed → installed/refused; changed package invalidates review | [skills.ts](../server/src/skills.ts), [skill-packages.ts](../server/src/skill-packages.ts), [templates.ts](../server/src/templates.ts): content and grants belong to the review | `skill-packages`, `skills`, `copies` |
| Brain device login | idle → waiting → finished/cancelled/timed-out/fallback | [brain-login.ts](../server/src/brain-login.ts): child identity rejects stale output; termination kills the process group | `brain-login` |
| Managed CLI installation | reviewed → drain → install → verify → activate/fail | [cli-install.ts](../server/src/cli-install.ts): one active operation; exact command review; immutable release folders | `cli-install` |
| Release checks | fresh cache → due → pending → success/failure cache; closed | [cli-updates.ts](../server/src/cli-updates.ts): one in-flight refresh, completion-based timer, abort on close | `cli-updates` |
| Data ownership and schema | unlocked → locked → released; empty/current/upgradable/refused schema | [lock.ts](../server/src/lock.ts), [schema.ts](../server/src/schema.ts): exclusive install owner and transactional schema upgrades | `lock`, `schema` |
| Listener recovery | unavailable → binding → listening/retry/stopped | [app.ts](../server/src/app.ts): tailnet/listener retry lifetime belongs to the app | `ports`, `public-origin` |
| Install/deploy/service | staged → verified → activated → healthy/rollback; service start/stop/restart | [installer](../installer/botons.mjs), [deploy.ts](../scripts/deploy.ts), [service-manager](../shared/service-manager.mjs): release pointers, health checks and owner authorization | `installer`, `deploy`, `service`, `service-manager` |

## Web client interaction and synchronization

These states are local unless the owner column identifies a server authority. Loading and editing are often independent: a form may be dirty while its earlier save is pending.

| Lifecycle | States and transitions | Owner and invariant | Existing verification |
| --- | --- | --- | --- |
| Bootstrap/auth | loading → pairing/setup/ready/error; revoked → pairing | [state.ts](../web/src/state.ts), [App.tsx](../web/src/App.tsx): authenticated server responses decide access | `web-state`, `check:firstrun` |
| Live connection | disconnected → stream open → catching up → connected; retry/watchdog | [state.ts](../web/src/state.ts): `connected` means catch-up succeeded, not just an open socket | `web-state` |
| Snapshot/event freshness | request in-flight → applied/overtaken/discarded | [state.ts](../web/src/state.ts), [brains.ts](../web/src/brains.ts), [teams.ts](../web/src/teams.ts): sidebar sequence, reaction watchers, provider generations and team versions each fence their own data | `web-state`, `web-brains`, `web-teams` |
| Chat history | latest/older window; loading earlier/later; retained/evicted; retry | [state.ts](../web/src/state.ts), [lists.ts](../web/src/lists.ts): bounded windows, request generations, live/history merge | `web-state`, `perf:chat` |
| Reply projection | no draft → streamed draft → committed message | [state.ts](../web/src/state.ts), [Chat.tsx](../web/src/components/Chat.tsx): ended-turn identities prevent stale snapshots restoring finished drafts | `web-state` |
| Composer | editing → submitting → acknowledged/failed; edits may continue while pending | [Chat.tsx](../web/src/components/Chat.tsx): a completion owns its submitted draft and attachments, not later edits or another Boton's composer | `check:composer` |
| Attachments | selected → preparing/uploading → ready/failed → removed/sent | [Attachments.tsx](../web/src/components/Attachments.tsx): item identity, abort controllers and object-URL cleanup; send consumes only submitted items | `check:composer`, `check:viewport` |
| Read position/scroll | unread → visible → debounced read; following latest/reading history | [Chat.tsx](../web/src/components/Chat.tsx), [state.ts](../web/src/state.ts): user scroll intent is separate from arrivals | `web-state`, `perf:chat`, `check:timestamps` |
| Live settings | shown + pending overlay → serialized save → settle/undo/fail | [live-settings.ts](../web/src/live-settings.ts): sequence-specific settlement cannot clear another edit | `web-live-settings` |
| Forms and reviewed operations | clean/dirty → saving/testing → success/error; review → confirm/stale | [components](../web/src/components): Settings, starter, connector, API-key, skill and import views delegate validity to the server | `check:starters`, `check:connectors`, `check:api-keys`, `check:skills`, `check:config` |
| Browser live view | acquire → connect/frame/input → reconnect/end | [BrowserTakeover.tsx](../web/src/components/BrowserTakeover.tsx), [takeover.ts](../web/src/takeover.ts), [shared/live-view.ts](../shared/live-view.ts): owner session and bounded frame/input protocol | `web-live-view`, `browser-handover` |
| File browsing/preview | closed → loading → shown/unsupported/refused/stale | [Files.tsx](../web/src/components/Files.tsx), [files.ts](../web/src/files.ts): server-scoped preview and navigation failure; no authority from embedded content | `web-files`, `file-preview`, `check:preview` |
| Menus, pickers and dialogs | closed/open; active option; submitting/error; dismissed | [components](../web/src/components): menu/dialog ownership, keyboard focus, reaction/skill search and pending decisions | `check:reactions`, `check:sidebar`, `check:avatars` |
| Pointer interactions | idle → pressed → dragging/long-press/cancelled; drop → save | [drag.ts](../web/src/drag.ts), [Reactions.tsx](../web/src/components/Reactions.tsx): scrolling and selection must not accidentally trigger mutations | `web-sidebar`, `web-reactions`, `check:sidebar`, `check:reactions` |
| Server logs | filter → loading/page → ready/error; follow → paused | [server-log-loader.ts](../web/src/server-log-loader.ts): request generation rejects stale pages | `server-log-loader`, `web-server-log` |

## Remaining risks and next decisions

- Reconnect snapshots in `state.ts` can overwrite newer live changes for resources without an overtaking guard. Sidebar, provider and reaction guards do not protect the whole refresh. A dedicated change should retain events through **all** outstanding refresh requests, including sibling requests after a failure, then reconcile in order with bounded storage and connection identity. Test delayed rename/create/delete, approval decisions, partial refresh failure and disconnect before choosing replay or per-entity reconciliation.
- Routine-run source-state checks are distributed between Engine and Store. Adding blanket terminal-state guards to `updateRun` without accounting for retry, deletion, recovery and callback updates could break valid paths. First specify those paths in a transition matrix and test them through existing APIs.
- Browser handoff request replacement and other multi-write workflows merit the same transaction audit as handback. Do not assume a correct pure reducer guarantees atomic persistence or external side effects.
- A form-level loading boolean is not automatically a defect. Introduce a discriminated state only where it removes reachable invalid combinations or makes cancellation ownership explicit.

For every future transition change, test the observable result plus duplicate invocation, stale completion, and interruption at its side-effect boundary. Use temp homes, fake providers and loopback services as described in [development](development.md). Browser and recovery checks do not substitute for each other.
