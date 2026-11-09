# Developing Botons

For people and coding agents working on Botons itself. Start with [CONTRIBUTING.md](../CONTRIBUTING.md) (setup and the rules a change must keep) and [AGENTS.md](../AGENTS.md) (the map of the code, every check command, and the rules that protect running installs).

## Run it from a checkout

Requires Node 24+. To talk to a real brain, at least one of the `claude` or `codex` CLIs, signed in (Codex stable 0.166.0 or newer); the dev server and the tests need neither.

```sh
npm install
npm start          # build the web app and serve on :7777 (localhost and this machine's Tailscale address)
npm run dev        # web on 127.0.0.1:5173, API on 127.0.0.1:7778, data in ./.botons-dev, mock provider; prints how to pair
npm test           # the fast tests; npm run test:full runs all of them (mock provider and fake CLIs, never the real ones)
npm run typecheck && npm run build
npm run check:public   # nothing private or secret in the repo (see AGENTS.md)
```

`npm start`, `serve`, `pair`, `backup`, `restore`, `doctor`, `deploy`, `service:install` and `backup:install` act on a real install. AGENTS.md says how to run them safely against a temp folder.

Coding agents setting Botons up for its owner follow `.claude/skills/install-botons/SKILL.md`, which stops for the owner's go-ahead before anything that exposes the server, changes the host or creates a credential.

## Tests and CI

- `npm test` is the fast tier (seconds); `npm run test:full` is every test (needs Chromium and bubblewrap), and `npm run deploy` runs it before each release build.
- Pull requests run two required checks: `Node 24` (typecheck and the fast tests) and `check:public`. The full tier runs weekly, by hand, and on pull requests labelled `full-ci`. Details: "CI runtime policy" in [AGENTS.md](../AGENTS.md), and [TEST-RUNTIME.md](TEST-RUNTIME.md) for measurements.
- The installer's CI probe compares plain and commit-qualified local Git URLs with Node 22.23.3's bundled npm; it does not exercise GitHub transport.

## Releases and packages

Maintainers build the publishable package with `npm run release:package`, then `npm pack ./release-package`. The version comes from the root `package.json`. `BOTONS_PACKAGE_NAME` overrides the default `getbotons` name. The package holds the prebuilt web app, the server source and a production dependency lockfile. Publishing is a separate owner action. The release steps are in [RELEASING.md](RELEASING.md) and [release-checklist.md](release-checklist.md).

## The site and brand assets

- The marketing site lives in `site/` ([site/README.md](../site/README.md)); all of its copy is in `site/content.ts`.
- The brand board is in [brand/](brand/README.md).
- The README's animated header, `docs/assets/botons-team.gif`, is drawn from the real Boton renderer by `node scripts/make-readme-gif.ts` (needs the development dependencies' Chromium and ffmpeg). Run it by hand after the Botons' look changes; add `--frames <folder>` to keep the frames and look at them before committing. CI never runs it.
