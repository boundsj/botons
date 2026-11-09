# Connectors

A connector gives a Boton the tools of an MCP server: GitHub, Linear, Slack, a fleet gateway, or a command on this computer. You add them in **Settings** and give each one to exactly the Botons that should have it.

## Every connector is Botons' own

A connector is a server in **Settings → MCP servers** (a command, or a URL with its headers) or a sign-in connector. Botons never reads the MCP servers in your own Claude Code or Codex settings, and each turn's CLI is started without them (Claude Code with `--strict-mcp-config`, Codex with `--ignore-user-config`), so a Boton has exactly the connectors you gave it, whichever brain it runs on.

A connector a turn goes without (it needs signing in again, its token could not be refreshed, it was removed, or the brain can't take it) is listed with the reason under **Needs your attention** in the Boton's settings (`GET /api/bots/:id/connector-notices`), and the Boton's own turn is told too. So is one the turn's CLI was given but showed it didn't start: Claude Code reports each server's status and tools when a turn starts (failed, refused the sign-in, still starting, listed no tools), and the next turn is told it went without. Codex reports nothing about starting its servers, so on Codex a connector is only known to have started once a turn called one of its tools; until then the log calls it unconfirmed, never working.

## Connect a service

**Connect a service** (Settings) adds one step by step: a known service (GitHub: its MCP URL and a fine-grained personal access token) or how it connects (a sign-in, a URL with an API key, or a command on this computer), its details, then a test where Botons can run one, and the Botons that get it.

- A key is typed into a masked field (Show reveals only what you typed; saved values never come back) and sent as `Authorization: Bearer …`, a bare token wrapped for you; **Advanced** takes other headers, such as `X-Api-Key`, masked the same way.
- **Save and test** lists the server's tools, or says in plain words why it couldn't ("GitHub refused the token (401). Check its permissions or expiry."), never with the key in it.
- **Which Botons can use it**, on each MCP server and sign-in connector, lists every Boton: the ones that have it (their turns get it), the ones that may ask for it, and the ones whose brain can't use connectors, with why a Boton's last turn went without it. Check and uncheck Botons there and save to give it to exactly those Botons, from their next turn on, or uncheck all to take it off every one (`GET` and `PUT /api/connectors/:id/access`, paired devices only). Saving sends who had it as you saw it, so if a Boton's connectors changed meanwhile nothing is saved and you review it again. Each Boton changed is its own entry in the audit log, and the connector's **History** shows those entries with the connector's setup, tests and request policy.
- The built-in browser is listed read-only: give it in each Boton's settings, where its sites are ([The managed browser](browser.md)).

**Connectors Botons can ask for** (Settings): a connector you turn on there can be asked for with `botons connector request`; you approve each request on a card, or let it be granted at once (a run started by a webhook always needs the card).

## Test

**Test** (Settings, on a sign-in connector or a library server with a URL; `POST /api/connectors/:id/test`, paired devices only, recorded in the audit log) has Botons connect to the server itself, start an MCP session and list its tools, calling none. It goes through the same guard as sign-ins: HTTPS, or a private or loopback address in `BOTONS_OAUTH_ALLOW`; a server outside that is reported as not tested rather than failed.

A tool list proves the server answers from this computer with the saved credentials, not that a Boton's turn loads it: Claude Code or Codex starts its own connection in the turn, and the Boton's settings say which connectors its last turn left out. Library servers that start a command are not tested this way (Botons doesn't run their commands outside a turn); each connector says what its status rests on. The last result is kept until the server restarts or the connector changes.

## OAuth (sign-in) connectors

**Settings → Sign-in connectors** adds a remote MCP server that signs in with OAuth (a fleet gateway, say): give it a name and the server's URL, then Connect. Botons finds the server's authorization server (protected resource and authorization server metadata), registers itself there as a public client named Botons, and opens the server's sign-in page with PKCE (S256) and the server's URL as the resource. Some servers ask for a one-time code there (a gateway's operator mints one, for example); that is expected. After you approve, the browser comes back to Botons, which keeps the tokens in its database.

Give the connector to Botons in their settings like any other: each turn gets an access token in its Authorization header (fresh enough to last the turn) and never the refresh token. A token can't be replaced mid-turn, so a turn longer than the token's life loses the connector part-way; tool calls are never replayed.

### The HTTPS callback

The authorization server sends the browser back to an HTTPS address, while the app itself may stay on plain HTTP. Publish just the callback path over HTTPS, for example with Tailscale Serve, and tell Botons its origin:

```sh
tailscale serve --bg --set-path /oauth http://127.0.0.1:7777/oauth
# then, in ~/.config/botons/env:
BOTONS_OAUTH_PUBLIC_URL=https://myhost.example-tailnet.ts.net
```

(If the whole app is already served over HTTPS, see [HTTPS for the whole app](access.md#https-for-the-whole-app); the installer's `--public-url` sets both.)

The redirect URI is exactly `<BOTONS_OAUTH_PUBLIC_URL>/oauth/callback`; only that path is served there, and everything else still needs a paired device. Each sign-in is started from a paired device and works once, for 10 minutes. Servers on the tailnet or this computer are private addresses: allow them with `BOTONS_OAUTH_ALLOW` (plain HTTP only for loopback). Botons only connects over HTTPS, checks every address it connects to, and follows no redirects.

### Staying signed in

**Keep connected** (on by default) refreshes the sign-in weekly so an unused one doesn't lapse. Refreshes are one at a time per connector. If a refresh's answer is lost after the request went out, the refresh token is never sent again (the server may have rotated it, and servers that detect reuse revoke the whole sign-in): the connector asks to be signed in again instead. An error answer from the server is retried a little later. When the server refuses the grant, the connector shows **Reconnect** and the Botons that have it get one note in their chats.

### The work feed

If the server has a `work_feed` tool, Botons polls it every 30 seconds with the connector's token. When a Boton starts work with the server's `work_start`, Botons records which Boton started it, and wakes that Boton when the work finishes a turn, needs input, fails, is cancelled or its delegated work ends. Updates on work no Boton is known to have started are ignored, or go to the primary Boton if you choose. Other servers are used as plain connectors.

## A command on this computer

A stdio MCP server starts in the Workspace sandbox's view of this computer, whichever Boton has it and whatever its access. Claude Code, Codex, or Botons itself for a Boton on an API key, starts it in bubblewrap with an empty read-only root, this computer's programs and libraries (`/usr`, `/etc`, `/opt` and the like, the folders on the server's `PATH`, Node's own install), each read-only, and the folder of its command and of each argument that is an absolute path to a file or folder.

- It sees no workspace, no shared folder, no data folder (`BOTONS_HOME`) and no home folder beyond those, by any path: a folder that is a second mount of one of them (a bind mount) is left out too.
- Its `HOME` and working folder are an empty `/tmp` of its own, so `npx` and the like download into it on every start.
- It keeps this computer's network, but no Unix sockets (no local program's socket), and nothing it writes changes a file on this computer.
- Its environment is a few of the server's variables (`PATH`, `USER`, `LANG`, ...), none of its keys or settings, plus the connector's own, and goes to bubblewrap in a private file, never on a command line.
- A connector whose command or arguments name something in a workspace, the shared folder, the data folder, a temporary folder or a private folder is left out of every turn, with why under **Needs your attention**; so is every local connector where bubblewrap can't run (where Workspace access can't either: macOS, or a container that forbids user namespaces).
- Botons' own connectors (the managed browser) start as they are.

Which Botons have a connector and the environment you give it are what it is handed, not what confines it: inside, it still runs as the server's user, with the network.

## Upgrade note: connectors from the CLIs' own settings

Upgrading to schema 23 took connectors from the CLIs' own settings (ids `claude:<name>` and `codex:<name>`) off every Boton that had them, after the backup the server makes before any schema upgrade. Each one became a notice in that Boton's settings, with where it pointed; when a Botons connector has the same name or address, the notice offers it (**Use …**, then save). Nothing is given to a Boton until you choose it. `botons doctor` lists the Botons with such notices, and those whose connectors can't be used.
