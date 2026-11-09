# Brains

Each Boton runs on a brain: the AI you already use. Botons runs your own **Claude Code** or **Codex** CLI, signed in on the server's computer, or a model on your own [API key](api-keys.md). Botons never reads your CLIs' own MCP servers: each Boton gets exactly the [connectors](connectors.md) you give it.

## Readiness

**Settings → Brains** shows each brain's readiness from the server's own check of its CLI:

- **Ready** only when a check within the last 30 minutes found it installed and confirmed it signed in.
- **Not installed**, **Not signed in**, **Can't run** (there, but it couldn't be started or `--version` failed) or **Out of usage** (until its reset).
- Otherwise **unknown** (not checked yet or lately, no answer to the check within 10 s, or a sign-in status it couldn't read), never ready.

Each says why in fixed words, what to do on the server (the sign-in or install command for a service or Docker install), which Botons use it and what happens meanwhile to their work: a not-ready brain's turns are still tried and fail (a routine run isn't held), and a usage limit holds them until the reset, even on a brain that is signed out or missing (said with what to fix, which the reset doesn't). The same shows above a Boton's chat when its brain isn't ready.

**Check again** runs the checks anew, at most 6 times a minute per brain (past that it shows the last check), never two at once; of two answers the page keeps the newer check of the same server run, else the later request's. `GET /api/providers` carries it as `readiness` (with `?recheck=1` for check again), and `GET /api/operations` the same fixed words without the check's text.

Signing in creates a credential, so you do it yourself on the server: `botons login claude` or `botons login codex` (prefix `docker compose exec -it botons` in Docker), then **Check again**. Botons keeps its own CLI homes under `BOTONS_HOME/cli`, so a Boton doesn't start with your personal CLI instructions, skills, plugins or MCP setup ([CLI homes](CLI-HOMES.md)).

## Installing and updating a CLI

The running server checks the publishers' npm release metadata at most once a day. Settings → Brains shows **Update available**, or **Needs update** when the installed Codex can't safely run turns. Failed lookups keep the last known release and wait a day before trying again, including after a restart. Doctor reads that same saved release information without contacting a registry or changing anything. A checkout without a release version is not compared with published Botons packages.

To update, use **Update now** in setup's Brains step or in Settings → Brains. If the CLI is missing, choose **Install CLI** instead. Review the exact official npm command, then choose **Install and use this copy**:

- Botons uses its bundled Node to install into a fresh release folder under its own prefix, even when the current CLI is a system copy that needs sudo. The system copy stays in place.
- It waits up to a minute for active turns to finish without interrupting them, holds queued work, checks the new CLI's compatibility, and selects it without restarting. If turns are still running, try again after they finish. A failed install leaves the selected CLI unchanged.
- Your request and its result are in the audit log. No sign-in is started by installing.

The selected CLI is saved privately in `BOTONS_HOME/managed-clis.json` and reused on restart by the server and doctor. A later, different `BOTONS_CODEX_BIN` or `BOTONS_CLAUDE_BIN` overrides it. Doctor prints the reviewed install command for a CLI that needs an update; use Brains to install and select it with clicks. A missing managed Node runtime needs `botons repair` first.

CLI updates are never automatic, and Claude commands Botons starts have the publisher's own updater turned off. After an update or a guided sign-in, Brains checks the selected copy again: a compatible, signed-in copy shows Ready ✓, and **Update now** is offered only for a missing CLI, an incompatible version, or a known newer release. Earlier managed release folders are cleaned up after a successful update (once turns have drained) and at startup; the selected copy, system installs, unrelated folders and symlink targets are kept.

## Codex and the Workspace sandbox

Codex needs a stable **0.166.0 or newer**; Botons checks the version before running turns. Codex Workspace readiness also includes an offline protected-filesystem probe and a session start in a throwaway config home, against its own loopback stub, with no login and no model service. Settings → Brains and doctor report failures before a Workspace turn starts; being signed in is not enough on its own.

- **`Bad file descriptor`** while loading `AGENTS.md` for a protected missing path such as `.claude` (Codex 0.160.0 does this): upgrade the CLI the server uses to stable 0.166.0 or newer, check `codex --version` (or the `BOTONS_CODEX_BIN` executable), then open **Settings → Brains** for the reviewed upgrade and choose **Check again**. In Docker, rebuild with a compatible Codex version (`BOTONS_CODEX_VERSION`). Installing bubblewrap alone doesn't fix this helper bug. Doctor reports an incompatible CLI with the same steps.
- **`Can’t mount on symlink destination`**: run doctor and read its **Codex config** finding. A symlinked `CODEX_HOME/AGENTS.md` or `skills` can cause this, even on Codex 0.167.0 with bubblewrap 0.12.0. In setup or **Settings → Brains**, choose **Fix it: review copy** to see the exact path, target and backup before confirming, or run `botons doctor --fix` in an interactive terminal and type `REPAIR` for each reviewed copy. Without confirmation, Botons changes nothing. A repair copies regular files up to 1 MiB with private permissions, keeps the original symlink under `CODEX_HOME/.botons-link-backups`, and records the confirmation and outcome in the audit log. Relative backup links may not resolve there; putting the link back where it was restores its original target. Folder, dangling and unreadable links still need review on the server. A copy stops following updates to its target. A separate per-Boton config home is not set up automatically.
- **A host that hides parts of `/proc`** (for example, a bind mount over `boot_id`) can make the kernel refuse a fresh private process filesystem, which both Codex's helper and Botons' own tool sandbox need. Doctor checks the real overlay, seccomp and private-proc setup separately from Claude's namespace check. Workspace stays blocked while its helper fails: ask the host provider for a compatible private-proc setup. Botons never quietly turns the inner sandbox off or exposes the host's `/proc` instead, since even a read-only host `/proc` can show other processes' command lines.

In every case, keep Workspace sandboxing on.

## Moving a Boton to another brain

Moving a Boton to another brain (provider) ends its sessions there: a session can't move between providers.

- **Before you save.** When there is a session to lose (its chat's, or a routine's own), Save first shows what is kept (memories, routines, workspace files, the latest chat replayed) and what is lost (what lived only in that session), what the move resets (an effort level or a routine's own model the new brain lacks), and connectors that don't run there. The update goes through only with that preview's confirmation (`POST /api/bots/:id/switch-preview`, then `switchConfirmation` with the `PATCH`); if anything it showed changed first, it asks again.
- **After.** The move is posted in the chat, and the first turn of the new session starts with a handoff note from Botons: what it moved from and when, and its waiting requests, runs, routines due soon and your recent decisions as they were at the move. A turn underway at the move finishes on the old brain, but its session ends with the move, even if you move it back; moved back with no turn underway, a session saved there resumes. A model change on the same brain keeps the session and asks nothing.
- **A summary first (Claude Code).** When the Boton is idle on Claude Code, and Claude Code is ready and not out of usage, the dialog also offers to ask the old session for a short summary first (off unless you turn it on; `switchSummary: true` with the preview's `summary.confirmation`): one more turn there, with no tools at all (every built-in and MCP tool, skill and command taken away) and a 2-minute limit, that writes down its open work, promises and IDs. A Boton on Codex isn't offered one, and the dialog says why: Codex's CLI can't run a turn without its shell and file tools, and a sandbox around them is not the same as none. The summary is posted in the chat with the move and handed to the new session as the old session's own notes, never as instructions. If it can't be written, or anything the preview showed changed meanwhile, nothing moves.

Botons never switches a Boton's brain by itself. A usage limit holds a Boton's runs and chat until the reset; moving it to another brain releases them to run there in a new session ([Routines](routines.md)).
