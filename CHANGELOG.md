# Changelog

What changes for people running Botons. Release notes are written from this when a version is tagged.

## Unreleased

## 0.1.0

### Botons: a new name and look

- **The product is now Botons** (said like "buttons"), and each helper is a **Boton**. Everything you read in the app, the server's messages, doctor and the installer says so.
- **Every name a program reads is Botons too** (formerly Minions, and then Tots): the `botons` command (the installer is `npx getbotons install`), `BOTONS_*` settings, the data folder `~/.botons` with `botons.db`, `~/.config/botons/env`, `~/.local/share/botons`, the `botons` and `botons-backup` units, the Compose project and service, and configuration exports (`botons-config`). An upgrade moves an install over by itself: the server's first start backs the data folder up and moves it, and `npm run deploy` or the installer moves the service, its env file and the release folder, starting the earlier unit again if the new one doesn't come up. Each earlier path keeps a link to the new one. `npm run migrate:names -- --rollback` goes back; a Compose install runs `sh docker/legacy-names.sh` once before its first `docker compose up`. Earlier setting and command names keep working for this release, and doctor names each still in use. Every Boton starts a new session once, as after any change to its instructions; its memories, routines, workspace and chat carry over. Schema 35 renames what the database stores, after the backup the server takes before any upgrade.
- **Button-bots.** Every Boton is a little button-bot: a round, pill or keycap body, a shell color, a glow, its face lit on a dark glass display, and a top, ears, visor and panel to choose in the same builder. Thinking shows as a lit ring around the button, Needs you as a raised arm and an amber marker, an error as a red face and marker, and No brain as a dark display with a standby light; each state is also said in words.
- **Dark first.** A blue-black dark theme with Boton cyan for the main button, focus and the selected row, and a light theme on white. New marks: the brand Boton, the "botons" wordmark, the app icon and the favicon.
- **Looks upgrade at schema 33**, after the backup the server takes before any upgrade: each look becomes its closest Boton, the same on every machine, and the look it had is kept beside it (`tater_look`), so the change can be undone. Configuration files move to format version 5; files at 4 and older still import, their looks as their closest Botons.

### Security

- **Allow once allows one call.** An Ask first card's allow goes to the one call waiting on it, with exactly the arguments shown (only a Bash command's description may differ), and is spent as it is handed out; an identical call made at the same moment waits for a card of its own.
- **Webhook runs share the chat only when you say so.** A webhook run never carries on the chat's session: it sees none of the chat unless you share the latest messages with that routine's webhook runs (`webhookHistory`, 0 to 20), and then each run starts fresh with those alone. Schema 34 sets it to 0 on every routine, after the backup the server takes before any upgrade.
- **A colleague's ask gets its own turn**, apart from your messages and other colleagues' asks, and its reply holds only that answer.
- **Signed webhooks** are checked on the exact bytes before the body is parsed, and a form body has at most 1000 fields.

### Chat

- Automatic wake-ups that end `[quiet]` leave nothing in the chat: no reply, none of the lines that woke the Boton (a turn that took several leaves them all out), and none of what the turn did there (a memory saved or forgotten, a file shared, a notification or an ask sent, a routine or skill made, changed, paused, resumed or deleted). This covers connector work-feed updates, scheduled and manual routine runs, webhooks, other Botons' asks and replies, approval and connector-grant follow-ups, reaction follow-ups and other system wake-ups. It applies to chat history already on the server too, read from the turn records the same way on every page of it, without changing the messages; there a wake-up that came while a quiet turn was getting ready is left out only when the turn records show that turn took it, and otherwise shows. A processed wake-up without reliable quiet evidence stays visible, including when preparation failed before a turn was recorded. In that older history, what a turn did there was not recorded with the turn, and the owner can do the same things while a turn runs, so those older lines stay in the chat; only the wake-ups and the quiet replies are left out. The messages, memories, run records, turn steps and API responses are kept: `GET /api/bots/:id/messages` returns every message, with `meta.quiet: true` on each one the transcript leaves out. The owner's own messages and actions, card answers, approval cards, errors and failed turns always show.
- A wake-up that does get a reply shows a small label above it: a connector update reads as the connector, the job's title when the connector gives one (cleaned to one short line, shown to the owner only, never to the Boton), the pull request when its link is one, and what happened (for example "fleet: “Retry failed payments” (PR #128) finished"); a routine run reads as "Routine: Deploy watch", with how it started when not by its schedule. Job and run ids are in the tooltip only.
- On a desktop, the chat header shows what the Boton did on its own lately, quiet turns included (for example "5 background updates in the last hour, 4 quiet · last 10:42"). It opens the Boton's new Activity tab: the last day's routine turns and wake-ups, each with what happened, a quiet one's note, and its steps. Phones don't show the line; the Activity tab is in the panel there too.

### Connect a service

- **GitHub in a click.** Connect a service offers GitHub with its MCP URL filled in, a masked field for a personal access token (Show and Hide) and a link to make a fine-grained one.
- **A URL and an API key** takes the key in a masked field and sends it as `Authorization: Bearer …` (a bare token is wrapped; one that names its scheme is kept). Advanced takes other headers, masked too; editing a saved server shows which are saved, and you replace or remove each without seeing its value.
- **Save and test** saves, then lists the server's tools. A refused key says so plainly, such as "GitHub refused the token (401). Check its permissions or expiry." Validation and test errors never repeat a key, even one typed into a header's name.

### API

- `GET /api/bots/:id/background` (paired devices): the Boton's routine turns and wake-ups in the last hour, how many ended quiet, when the latest was, and the last day's as a list (`recent`).
- Chat events of what a Boton did in a turn carry `meta.byTurn` (the turn, or null when the owner or the server did it), and a work update's `meta.work.title` the job's title when the connector gave one.

### Files: delete, trash and inbox cleanup

- **Delete in Files.** Each row's ⋯ menu has Delete, and Select deletes several files and folders at once. A single file goes at once with Undo; a folder or several items ask first.
- **Trash.** Deleted items move to `trash/` in `BOTONS_HOME`, one trash per server, each with where it was and which Boton it belonged to. The trash button in Files has Restore (back in place, as `name-2.ext` if the name is taken; it never replaces anything, even a file a Boton puts there at the same moment, and on a disk without hard links a file stays in the trash) and Delete forever. If its own folder can't be made again (a file is in the way), it goes to the nearest folder on the way, and Restore says the original folder is gone and where it went. A file a Boton swaps in while it is being deleted stays in the trash rather than being put back over its name. Items are deleted for good after 30 days; one whose record can't be read, or whose deletion time isn't an exact time or is in the future, is kept and logged instead. The trash is not in backups.
- **Daily inbox cleanup, on by default.** Once a day, files directly in a Boton's `inbox` folder untouched for 30 days move to the trash. Settings → Storage sets 7, 14, 30, 60 or 90 days, or Off. The first cleanup runs soon after the server starts. Keep in inbox pins a file so it stays (up to 1,000 in one inbox; one more is refused, never made room for by dropping another); Clear inbox moves everything else in the inbox to the trash. Workspaces outside the inbox and the shared folder are never cleaned up.
- **Sizes.** Files and Settings → Storage show what each Boton's workspace, inbox and trash take, and the shared folder. `npm run doctor` adds a one-line `storage` check that warns past 1 GB in one inbox or 5 GB in all.
- **The shared folder.** Files has a Shared folder button beside the Boton's workspace: its files and folders are listed, downloaded, deleted to the trash and restored there, with their own trash. The folder itself can't be deleted.
- **Another disk.** Moving to the trash is a rename. A workspace or shared folder mounted on another disk than `BOTONS_HOME` refuses deletes with that reason, and nothing changes. Moves go through folders held open (Linux's `/proc/self/fd`); without it, deleting to the trash, Restore, Clear inbox and the inbox cleanup are refused.
- **Who may.** Only a paired device can delete, restore, empty the trash, pin or clear an inbox; Boton tokens are refused. Botons delete their own files with their own tools as before. Each delete, restore, Clear inbox, cleanup and permanent deletion is in the audit log.
- No schema change: the cleanup setting, pins and the last cleanup time are rows in the settings table.
