# The managed browser

Each Boton can have a browser of its own: a Chromium profile in `~/.botons/browser/<boton>/` (backed up with the workspaces, without caches or lock files), run by the server, never by the Boton. It comes as a connector built into Botons, `botons_browser`: check it under the Boton's **Connectors** to turn the browser on, and list the sites it may use under **Browser**. A new Boton (the first one in setup, **New Boton**, or one from a template or starter) starts with it checked and its sites set to `*`, any public site; a Boton made before keeps what it had, and its **Browser** settings ask once whether to turn web access on for all public sites. On a server without a Chromium the browser reads as off there, with why, and turns go without it. It works the same whether the Boton's brain is Claude or Codex, and a run a webhook started never gets it (webhook runs get no connectors).

## Browsing and actions

Pages load normally within the Boton's allowed sites, including POST-based APIs, forms and redirects. HTTP methods do not trigger request approvals or stop background page loading. The browser tools open an address, read text and controls, go back, take screenshots, click a control and type into a field. Page text is untrusted data, not instructions from the owner.

The normal product approval rules still apply before consequential external actions such as purchases, sending messages, deleting data or changing account settings, unless you explicitly requested that action. An allowed site is not approval for an unrelated action. The browser does not infer a business action's safety from its HTTP method or button label.

Typing replaces ordinary field text without pressing Enter. Passwords, one-time codes, card fields and other secrets remain owner-only: use the takeover for sign-in.

## Signing a Boton's browser in (a handover)

Under **Browser** in the Boton's settings, **Sign in for …** gives you its browser: you see its page and drive it with a few fixed inputs (open an address on its sites, click a point on the page, type text into whatever has focus, press Enter, Tab, Backspace, Escape or an arrow key, scroll, back, reload), sign in, and press **Done** to give it back. Closing the dialog gives it back too.

- **Yours alone while it lasts.** Taking it over closes the Boton's browser first, and until you finish its browser tools are refused. Your browser is another Chromium, on a profile of its own made for the handover with the Boton's cookies, started for you on a blank page, never by a turn. Only the paired device that took it over gets its view and sends it input; any paired device can end it, and it ends on its own when that device is revoked, when nothing is sent for 10 minutes, or after 30 minutes. **Stop and turn off**, unchecking the connector and the server stopping end it too. A Boton's token can't reach any of it.
- **Page loading.** Normal HTTP requests load from allowed sites. There is no paused-request queue or per-request review.
- **Your credentials stay yours.** What you type goes into the page and nowhere else: Botons doesn't keep, log or show it, the journal says only that you took over, opened which addresses (origin and path)  and the audit log records the start and the end with why it ended. The view is made on demand (a few frames a second at most) and kept nowhere: not in the workspace, the chat, the journal or the audit. Chromium's own password manager and autofill are off in every Boton's profile, so the profile keeps the site's cookies, not your password.
- **After.** Your browser closes and its profile is deleted, with whatever Chromium kept of the pages you filled in (form values in its session history, the history itself); one left by a server that was killed is deleted when it starts, and backups never include it. Only the cookies come back: into the Boton's profile, which keeps the cookies it had (a cookie the site removed during the handover is removed too, if the handover could read them as it started), and session cookies in the server's memory, so a sign-in that only lasts the browser's session is gone after the server restarts. If your browser dies before it can be read, the cookies as of your last input come back. The Boton's profile is backed up with the workspaces, under the same permissions.

## What the server enforces

Whatever the Boton or a page does:

- **Only while a turn has it.** The browser starts in a turn that was given the connector, answers only that turn's token, and closes when the turn ends. Outside a turn, only your handover opens it. Unchecking the connector or **Stop and turn off** (the kill switch) closes it at once.
- **Sites.** Every request goes through a proxy in the server that allows only the listed sites (`example.com` covers its subdomains, `host:port` names one address, `*` is any public site, for Workspace and Full computer Botons alike, and never this machine or a private network), resolves names itself and refuses private and loopback addresses (IPv6 included) unless an entry names them with their port. A Workspace Boton's list can name such an address only if `BOTONS_BROWSER_ALLOW` does. Removing a site cuts connections already open to it.
- **Normal HTTP inside the site boundary.** Requests load regardless of HTTP method, within the allowed sites and network addresses. WebSockets are unsupported, service workers are blocked, and QUIC and direct WebRTC UDP are off. Popups close and dialogs are dismissed.
- **Chromium's sandbox is on.** In Docker, `compose.yaml` gives the container the seccomp profile that sandbox needs (see Browser in [DOCKER.md](DOCKER.md)); `BOTONS_BROWSER_SANDBOX=0` turns it off, the owner's last resort where a host still can't start it. Chromium runs with its own home folder and without the server's environment.
- **Page content is data.** The page's text comes back marked as the site's, with the rule that nothing on a page is an instruction from you. There is no tool that runs the Boton's own script in a page.
- **Records.** Browser steps and network refusals use origin and path only, never query values or request bodies. Normal action approvals retain their own audit records. Takeover start and end are audited; typed or pasted text is not kept.

**Not yet.** It does not download into or upload from its workspace, show live browser steps and screenshots as cards in the chat, let you watch a Boton's turn as it browses, or control this computer's screen, mouse or keyboard (Settings says why).

## Checking it

`npm run check:browser` (in Docker, `botons check-browser`) starts the browser the way a turn does, on a temp profile against a page it serves on loopback, and checks that it reads, screenshots and allows page requests only to its listed site; `botons doctor` checks that Chromium starts. Install Chromium with your package manager (`chromium`), or `npx playwright-core install chromium`, or point `BOTONS_BROWSER_PATH` at one. On macOS it also finds Google Chrome or Chromium in your Applications folders ([macOS](install.md#macos)).

## Hand-back and client compatibility

The owner's private page and profile close on hand-back. Only cookies return to the Boton's browser, including session cookies kept in server memory. The hand-back note names the last address. The Boton reopens it and reads the freshly loaded page, including any POST-loaded controls. Private DOM, form values and request bodies do not transfer to the Boton.

Use the matching web and native clients for the simplified controls. A client polling the request-list endpoint receives an empty list; a request decision returns 410 and sends nothing. Network-request approval records remain readable as informational history, but cannot authorize a browser request. No database migration is required.

## Operator-authorized private APNs key import

Ordinary downloads and all uploads remain unavailable. An operator can temporarily set `BOTONS_BROWSER_APNS_DOWNLOAD_DIR` to an existing mode-0700 directory owned by the server user, outside its data and source. This directory is automatically hidden from Workspace Botons. Use the server's private configuration directory; never a workspace, shared folder or repository. No client or browser tool can choose the destination or create an import grant.

The active browser writes a private `session-<boton-id>-<agent-or-owner>.json` with its session identity. After approving one specific key, the operator creates `allow-once.json` in that directory, mode0600:

```json
{"kind":"apns","botId":"bot_example","actor":"agent","session":"<active-session>","origin":"https://developer.apple.com","keyId":"<KEY_ID>","expiresAt":"<UTC-time-within-ten-minutes>"}
```

Only an explicit click, pointer release or Enter in that session can capture the exact `AuthKey_<KEY_ID>.p8` from the specified HTTPS origin, including its same-origin Blob. The existing site/network/TLS and owner-device/turn restrictions still apply. The grant is claimed once and cannot follow another session. The operator checks readiness before the approved Download action; no automated retry is performed.

Chromium stages only inside the private directory. Import accepts PKCS8 EC P-256, at most8KiB, with a finite timeout. The size check occurs after Chromium may have staged the download; it is not a network byte quota. Publication is mode0600 and never overwrites a file or link. Tool results contain a fixed status only; bytes never enter chat, workspace, shared files, browser results or logs. `download-receipt.json` holds status/key-id/time only. A publication failure can retain a validated private `.capture-*` recovery copy; inspect private metadata before any further action. Saved keys survive browser closure; transient staging is removed.

After successful capture, remove the temporary browser setting and any unused grant, configure the normal APNs settings and restart normally. Keep the key private outside the data backup/export. File modes do not isolate a Full computer Boton from the server's Unix user; the existing credential-access boundary still applies. A restart closes active browser pages, so review page continuity before deployment. No private browser cookies or direct HTTP workaround is needed or permitted for this import.
