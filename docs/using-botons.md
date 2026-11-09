# Working with your Botons

Each Boton has a role, its own chat, routines, memory and workspace, and a brain you give it. This page covers what a Boton may do, starter templates, skills, the sidebar and reactions. Related: [routines](routines.md), [files](files.md), [connectors](connectors.md), [the managed browser](browser.md), [API keys](api-keys.md).

## What each Boton may do, and the audit log

A Boton's settings show **What it can do now**: its computer access, connectors and the ones it may ask for, skills, Ask first and Always allow rules, and routines that webhooks can start (with Full computer access or not) or that send results to a callback.

- **Workspace access** runs a Boton in a sandbox that keeps it to its own workspace (Linux, with bubblewrap).
- **Full computer access** runs it as the server's user: it can read and change everything that user can. Give it only to Botons you trust.

**Settings → Audit log** lists the consequential actions, newest first, with who did them (a device, a Boton, the server's computer or Botons itself): pairing, pairing approvals and revoking, access mode and setup, notifications and test pushes, Botons created, deleted, given Full computer access or other connectors, skills or rules, connectors a Boton got at once by asking (the connector's policy granted it), routines' webhook access and callbacks, failed runs retried, approvals decided, skills approved, installed from a package, put back, turned on or off, connector policies, MCP servers and OAuth connectors, and API keys saved, removed or tested. It keeps the newest 10,000 events and never holds a token, code, secret or message text. `GET /api/audit` returns it to paired devices.

## Starter templates

**New Boton** offers starters: Daily brief, Repository monitor, Research on request (started by a webhook), Inbox triage, Weekly report from files, Web watcher, Researcher and Chief of staff. Each says what it needs: the brain (a brain that takes connectors, when its work reads a connected service), the access it asks for (Workspace access, for all of them), the connectors it uses, when it runs, where its output goes and what happens when a run fails.

A starter's text grants nothing. Its connectors are slots you fill with your own connectors (or leave empty, if optional); with none that fits, the review says so and opens **Connect a service**. The review lists exactly what installing grants (brain, access, each connector, skills, each routine with its time and timezone), and the install is refused if any of that, or a chosen connector's state, changed since you looked.

**Routines start paused.** After installing, the **Setup check** reads what the server saved at the install (the starter and your slot choices), the Boton's settings, the brain's and connectors' last known state (it starts no check of its own, so a brain not checked lately is said to be unknown), the routines' schedules and their latest test run. It runs nothing, reaches no connector or service, and says what it can't verify.

**Run a test** is a real turn on the Boton's brain, told to act as a dry run (read and check, do nothing hard to undo, say what it would have done). Nothing enforces that, so it can use every tool it has. It pushes nothing and sends no callback, and a webhook routine's test is held to Workspace access without connectors. A test that finishes without an error shows the brain ran it, not that its reply is right: read it.

Only you turn a starter's routine on, from its setup (reopened later with **Set up to turn on** in the Routines panel): after a test run that finished on exactly the settings it has now (the Boton's, the routine's, its connectors' and skills'; an edit since, or a test still running, means test again), or with **Turn it on without a test run that passed**, which the audit log records as an override. Until then nothing else turns it on: not Resume, not the Boton itself (`botons routine update --resume`), not a copy of the Boton. Once on, it is an ordinary routine. The webhook's URL and key are made at install and shown only in the routine's settings.

## Skills and skill packages

Skills are procedures in the library (the sidebar's **Skills**). Besides writing one there, you can install one from a package: put each package in its own folder in `~/.botons/skill-packages` (`$BOTONS_HOME/skill-packages`), holding a `SKILL.md` with `name:` (the folder's name), `description:` and an optional `version:` in its frontmatter, then the procedure.

**Skills → Install from a package** lists the folders with where each stands (not installed, up to date, update available, changed here since installing, name taken, or why it can't be installed). **Review** shows exactly what installing changes: the description and procedure line by line against the installed skill; its package details (the `version:`, every other field and the other files in the folder) against those it was installed with; what it asks for or points at (fields such as `allowed-tools`, the sites it links to, the `botons` commands it runs, with what's new in this version marked); and which Botons get it. A package is up to date only while all of that is as you installed it: a new label, field or file alone is an update. Nothing installs until you confirm that review, and an install is refused if the package, the skill, what it asks for or who has it changed since you looked.

**What Botons reads.** Only `SKILL.md`, as text: it never runs, unpacks or follows anything in a package. It opens the packages folder and each package folder once and reads through those open folders (Linux's `/proc/self/fd`), so a folder renamed or swapped for a link while it is read changes nothing; on a system without `/proc/self/fd` packages are listed but can't be installed. A package folder or `SKILL.md` that is a link, a `SKILL.md` with other hard links, over 64 KB or not UTF-8, and archives are refused; other files are listed but not installed.

**A skill grants nothing.** What a Boton can do comes from its access and connectors, and fields like `allowed-tools` are shown, never applied. Each skill's **Details** set exactly which Botons can use it (taking one from a Boton with every skill gives that Boton a list of every other skill instead), turn it off for every Boton without deleting it, and keep its last 10 texts, any of which you can put back (with the package version it came from). Installs, updates, restores, turning skills on and off and each Boton given or losing a skill are in the audit log.

## The sidebar

How the sidebar is arranged lives on the server, so every paired device shows the same: groups in their order (each collapsed or not), each Boton in at most one group or ungrouped at its place there, the pinned Botons in their own order (a pinned Boton stays in its group too), and whether Pinned and Ungrouped are collapsed. A new Boton goes last among the ungrouped, or last in the group it is made in (a Boton from a template goes to the template's group the same way). Deleting a group moves its Botons, in order, to the end of the ungrouped; it never deletes or unpins one. It is in the database, so every backup has it.

**New group** at the end of the sidebar makes a group; a group's menu (the … next to its name) makes a Boton in it, renames it, moves it up or down, or deletes it. Each Boton's menu (the … on its row, always shown on touch screens) pins or unpins it, moves it up or down, or moves it to another group or a new one; a pinned Boton's menu in Pinned moves it left or right. The menus work with the keyboard (arrow keys, Home, End, Escape). Clicking a section's name collapses or expands it; a collapsed section still shows how many of its Botons have unread messages, wait for an approval or are working, and search (Enter opens the first match) finds Botons in it. A Boton's settings pick its group from the groups there.

Group names are unique in any case (Unicode case and accents composed or not: "Équipe" and "équipe" are one group), up to 40 characters, and there are at most 100 groups. A settings form sends a Boton's group or pin only when you changed it there, so saving it never undoes a move made elsewhere.

**From a script.** `GET /api/sidebar` returns the layout to paired devices (Boton tokens are refused), and every change answers with the whole layout and sends it to every device as a `sidebar.updated` event:

- `POST /api/sidebar/groups` (`name`, `index`); `PATCH` and `DELETE /api/sidebar/groups/:id` (`name`, `collapsed`); `POST /api/sidebar/groups/:id/move` (`index`).
- `POST /api/sidebar/bots/:id/move` (`groupId`, null for ungrouped, and `index`); `POST /api/sidebar/bots/:id/pin` (`pinned`, `index`).
- `PATCH /api/sidebar/sections/pinned` or `/ungrouped` (`collapsed`).
- A new Boton takes `groupId`, or `group` by name, which makes the group if there is none.

An `index` is the place in the list counted once the Boton or group is there (0 is first; missing or past the end is last).

`GET /api/sidebar/export` gives the layout as a file of its own (`format` `botons-sidebar`, `version` 1; groups by name, Botons by id), apart from any backup, and `POST /api/sidebar/import` puts one back: all of it, or nothing if anything in the file is wrong. A group with the same name keeps its id and the others are made; groups the file lacks are deleted (never their Botons). A Boton id with no Boton here is skipped and listed in `skipped`; a Boton the file doesn't mention keeps its pin and goes last among the ungrouped.

Upgrading to schema 27 made each group name in use a group (names that differ only in case, in any script, became one), ordered by name, with each group's Botons and the pinned ones ordered by latest activity, as the sidebar showed them.

## Reactions

You react to a Boton's messages with an emoji, and a Boton reacts to your own messages in its chat. In the web app, hover or focus a Boton's message and choose its smiley button (on a phone it is always there, or long-press the message): six quick reactions, and **More…** for a searchable set or any emoji you type or paste. Choose one you've given again, or its chip under the message, to take it off. **Settings → Reactions** picks which emoji ask for a follow-up, or turns follow-ups off.

Each reaction is stored with its message (who, which emoji, when), sent to every paired device as a `message.updated` event, and is in every backup. A reaction is feedback only: it never allows or denies an approval or answers a card (approval and card events take no reactions at all), and it pushes nothing.

- **Yours:** `POST /api/bots/:id/messages/:messageId/reactions` (`emoji`) on one of the Boton's messages, and `DELETE /api/bots/:id/messages/:messageId/reactions/:emoji` to take it off; up to 10 different emoji on a message. A reaction doesn't start a turn: the Boton is given it as feedback in its next chat turn, once. The emoji in the `reactionFollowUps` setting (default 👎 alone; `[]` for none) also start a short follow-up turn about that message, once per message and emoji: taking it off before that turn starts withdraws it, and adding it again starts none.
- **A Boton's:** `botons react <message-id> <emoji>` and `botons unreact <message-id>`, during a turn, on your own messages in its chat only (not its own, another Boton's or the server's), one emoji per message, and never from a sandboxed webhook run. Its turn's context lists the ids of the messages it answers. A turn that only reacted and replied `[quiet]` posts nothing.
- **The rules.** Every Boton's system prompt has the same rules for when to react (acknowledgements, thanks, finished work), when words are needed instead, and how to read your reactions; a Boton's own instructions can change how often, not that a reaction is never an approval.
- **Export and import.** `GET /api/reactions/export` gives every reaction as a file of its own (`format` `botons-reactions`, `version` 1), apart from any backup, and `POST /api/reactions/import` puts one back: all of it, or nothing if any entry is wrong. Each message the file names gets exactly its reactions; a message that isn't here is listed in `skipped`. Imported reactions start no turn and aren't given to the Boton as new feedback.
- A new session's replay of the chat shows the reactions on the messages it gives.
