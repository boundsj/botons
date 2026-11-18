# CLI homes

Each agent CLI keeps its sign-in, settings and conversations in a home folder. Botons picks one in a single module (`server/src/cli-homes.ts`) and uses it for turns, probes, login, installs and updates, and doctor.

## Codex: one shared home

Botons uses one Codex home, the server account's own: `CODEX_HOME` if set, else `~/.codex` of the user the server runs as. Turns, `codex login status` probes, the model list cache (`models_cache.json`), `botons login codex`, the guided sign-in in Settings → Brains, CLI install and update, and doctor all use it.

The home is shared with every other Codex client that user runs (the `codex` CLI itself, editors). Signing in, out, or to another account there changes it for all of them, and the other way round.

Why one home: Codex rotates its refresh token every time it refreshes. A second copy of `auth.json` goes stale as soon as either copy refreshes, and then fails with "refresh token was already used". Codex's own refresh reloads `auth.json` under a guard and refuses to commit a refresh when the file changed meanwhile (as the installed 0.169.0 shows), so several Codex processes on one home coordinate; copies in separate homes cannot. Botons therefore never copies or symlinks Codex credentials. That coordination claim comes from inspecting the installed CLI, not from Botons tests.

### Isolation that remains

Codex turns run with `--ignore-user-config` and `--ignore-rules`; plugins, remote plugins, apps, tool suggestions and hooks are disabled; skill instructions and bundled skills are off. The Workspace sandbox hides the home's entries (sign-in, sessions, config) from the Boton's commands.

One limit: Codex always adds the home's global `AGENTS.md` (or `AGENTS.override.md`) to every turn and has no switch to stop it. With a shared home, Codex Botons get the account's global Codex instructions. Settings → Brains says so on the Codex row when the file exists, and doctor reports it (info, "Codex config"). Keep instructions there that suit your Botons, or move them into the projects that need them.

### A sign-in kept in `BOTONS_HOME/cli/codex`

Botons does not create this folder. If an install has one, it is left exactly as it is: never deleted, never overwritten.

- When no explicit `CODEX_HOME` is set and the account home has never been selected, while it has no `auth.json`, the kept one is used in place (not copied). The API reports `codexSignIn: 'botons-only'`, and Settings → Brains and doctor show a warning.
- Login always signs in the account home. As soon as that has an `auth.json`, every turn and probe uses it and the kept one is unused. Doctor says it has probably stopped working; delete its `auth.json` when you no longer want it.
- When both exist, the account's is preferred and nothing is overwritten. Once selected, a credential-free marker under `BOTONS_HOME/cli` keeps the account home selected even after logout; the unused sign-in is never revived. An explicit `CODEX_HOME` always wins, including when it uses keyring storage.

Risk: if the account's `auth.json` exists but is signed out or stale while the kept one worked, Codex Botons show signed out until you sign in again once (Settings → Brains → Sign in again, or `botons login codex`). Botons cannot tell a valid file from a stale one without calling OpenAI.

### Conversations

Codex finds a thread by its rollout file, `sessions/YYYY/MM/DD/rollout-…-<thread id>.jsonl`. Before resuming a Boton's thread that is not in the home in use, Botons copies its rollout from the other home (`BOTONS_HOME/cli/codex` or the account home) to the same place under `sessions/` (exclusive create, mode 0600; the original stays). These copied conversations then also appear in that account's own Codex history. If a rollout is not found anywhere, the engine's lost-session path starts a new session.

## Claude

Claude uses `BOTONS_HOME/cli/claude` (`CLAUDE_CONFIG_DIR`), created private (0700), so a Boton does not start with the owner's Claude instructions, skills, plugins or MCP setup. A personal file sign-in (`.credentials.json` in `CLAUDE_CONFIG_DIR` or `~/.claude`) stays in use until the owner signs in for Botons (`pending`); login always targets Botons' own home. Keychain-only credentials need a separate login; Botons never exports them. Settings → Brains offers to sign in for Botons while pending.

## Older clients

- `GET /api/brain-homes` returns `codex: false` (no copy is offered), `claude` as before, `codexSignIn` (`'account'` or `'botons-only'`) and `codexInstructions` (boolean).
- `POST /api/brain-homes/codex/import` still needs a paired owner and consent (401, 400), then always answers 409 saying there is nothing to copy. It never writes credentials.

## Verification

With fake CLIs, which do not prove anything about OpenAI's real refresh: `server/test/cli-homes.test.ts` covers home selection (custom `CODEX_HOME`, `~/.codex`, missing sign-in, the kept-only state and the switch after login), config isolation and the sandbox, concurrent turns and probes and a restart on one home against a fake token service that rotates the refresh token on every turn (and a stale copy failing against it), and conversations carried across homes; `server/test/brain-login.test.ts` the endpoints; `server/test/doctor.test.ts` doctor's Codex findings. By hand with the installed Codex 0.169.0: a copied rollout resumes in a home whose state database never saw it, an unknown thread fails with "no rollout found", `CODEX_HOME/AGENTS.md` reaches a turn despite the isolation flags while the home's config and skills do not, and the binary carries the guarded-reload refresh messages.

Official references: the Codex auth docs (`CODEX_HOME/auth.json`; the keychain is also possible) and Claude Code settings (`CLAUDE_CONFIG_DIR`).
