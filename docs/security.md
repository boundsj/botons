# Security

Botons runs AI agents on your computer, with your logins. This page is the map: what protects you, and where each part is explained. The trust model and how to report a vulnerability are in [SECURITY.md](../SECURITY.md).

## The short version

- **A paired device is the owner.** Devices pair once by a code you approve on the server or from a paired device; a code alone gets nobody in, and a code that reached you in a chat should never be approved. [Pairing devices](access.md#pairing-devices)
- **Keep it private.** The server listens on `127.0.0.1` (and the machine's Tailscale address) unless you choose otherwise; the access mode refuses other networks. Use Tailscale or HTTPS behind a proxy to reach it from other devices, never plain HTTP across a network you don't control. [Access, HTTPS and pairing](access.md)
- **Give each Boton only the access it needs.** Workspace access keeps a Boton in a sandbox with its own workspace (Linux, bubblewrap). Full computer access runs it as your user: it can read and change everything you can. [What each Boton may do](using-botons.md#what-each-boton-may-do-and-the-audit-log)
- **Risky steps can wait for you.** Ask first rules pause covered tool calls for your OK, and Allow once allows exactly that one call. Browser pages make normal HTTP requests within allowed sites, without per-request review. Use Take over for passwords, codes and card details. [The managed browser](browser.md)
- **Connectors are yours, and only the ones you give.** Botons never loads your CLIs' own MCP servers; each Boton has exactly the connectors you gave it, and local command connectors start sandboxed. [Connectors](connectors.md)
- **Secrets stay out of sight.** API keys and connector secrets are never shown again after saving, never sent to agent CLIs, and left out of configuration exports. Backups do hold them, unencrypted: keep backups somewhere you trust, and encrypt one before it leaves the machine. [API keys](api-keys.md), [Backups](backups.md#moving-your-configuration-to-another-server)
- **A Boton's colleagues are not you.** What another Boton writes reaches a Boton only marked as a colleague's, never as yours; a team gives its members no access, connector, skill or approval of another's, and a lead's request carries no more weight than any ask. [Teams](using-botons.md#teams)
- **Everything consequential is recorded.** The audit log lists pairing, access changes, grants, approvals and key changes, never a secret. [Audit log](using-botons.md#what-each-boton-may-do-and-the-audit-log)

## Where each protection is described

| Topic | Read |
| --- | --- |
| Access modes, and what no mode can see (forwarders, proxies, tunnels) | [access.md](access.md#access-modes) |
| HTML previews in a sandboxed frame, and what a page can still send | [files.md](files.md#files-a-boton-shares) |
| The trash: deletes that never follow links or leave the workspace | [files.md](files.md#deleting-files-and-the-trash) |
| Starter templates and skill packages: reviewed before anything is granted | [using-botons.md](using-botons.md#starter-templates) |
| The API key brains' tool sandbox, spending caps and key redaction | [api-keys.md](api-keys.md#botons-on-an-api-key) |
| OAuth connectors: PKCE, HTTPS only, no redirects, refresh-token safety | [connectors.md](connectors.md#oauth-sign-in-connectors) |
| The managed browser: allowed sites, normal page requests, owner-only sensitive input and handovers | [browser.md](browser.md) |
| Teams: who may read and change what, and the bounds on messages between Botons | [security.md](#teams-and-messages-between-botons) |
| Limits on macOS (no weaker sandbox substituted) | [install.md](install.md#macos) |
| Docker's safety defaults | [DOCKER.md](DOCKER.md) |

## Teams and messages between Botons

- **Who is who.** The sender of a message and the actor of every team action come from the turn's own token, never from what a message says. A name in a message means nothing.
- **Webhook runs.** A sandboxed run (a webhook's, with Workspace access) can read the roster (`botons team`) and nothing else of teams: it can't send, act on items or read threads, so a webhook's payload can't travel through a team.
- **What a Boton reads.** Its own seats and its teammates' roles, the boards of its teams, threads it takes part in while it holds a seat in their team, and every thread of a team it leads. Seats are checked as they are now: a Boton removed from a team reads none of it. Everything else is refused.
- **What a Boton changes.** Only the item actions its role has, on items of its own teams, and only for the assignment its turn started with: an action about an item that moved on since is refused with a code it is told not to retry. A lead can't stop, pause or change another Boton, approve anything, or change anyone's access; only your Stop work stops a running turn.
- **No privilege by membership.** A seat shares no workspace, connector, skill, access level, Always allow rule or approval. A Boton answering a colleague still works under its own access, Ask first rules and approvals, and a relayed "Sam approved" is not an approval. Your answer to an escalation reaches the lead only as the server's own turn.
- **Words in their place.** Colleague text, item titles, reasons and results appear to a Boton only inside blocks marked as a Boton's, with their brackets defused; what the server knows (states, times, counts) is outside them, and check-ins and escalation cards are composed by the server. The system prompt and the CLI say never to put a password, key, token or code in a message or an item. The shared folder is unchanged by teams: every Boton not in a sandboxed run reads and writes it.
- **Bounds on every loop.** Asks that lead to asks stop after 3 in a row; replies are never answered by themselves; each pair of Botons, each team and the server have hourly limits, and each team daily budgets that pause it; a recipient takes at most 10 waiting messages; check-ins back off and end at you; every count is kept in the database, so a restart resets none of them.
- **On record.** Every message, delivery, refusal and supervisor decision is kept and readable in Teams; there is no edit or delete of a message. The audit log records team changes, seats, state changes, escalations and your answers, and your actions on items, by ids and names only, never what anyone wrote.
