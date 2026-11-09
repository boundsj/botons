# Contributing

Thanks for helping. Botons is small on purpose: one Node server, one React app, SQLite, and the agent CLIs doing the work. Changes that keep it that way are the easiest to take.

## Set up

Node 24 or newer, and a Chromium for the managed browser's tests (the `chromium` package, or `npx playwright-core install chromium`; they fail without one, and `npm run check:browser` says whether yours works). No agent CLI is needed to develop: `npm run dev` and the tests use a mock provider and fake CLIs.

```sh
npm ci
npm run dev            # web on 127.0.0.1:5173, API on :7778, data in ./.botons-dev; prints how to pair
npm run typecheck
npm test               # the fast tests, a few seconds; one file: node --test server/test/<name>.test.ts
npm run test:full      # every test (needs Chromium and bubblewrap), a few minutes
npm run build
npm run check:public
```

`AGENTS.md` is the map of the code and its rules, for people and coding agents alike. Read it before a change to the server.

## Rules a change must keep

- **Tests** for every behavior change, and never against a real install: tests get a temp `BOTONS_HOME`, a free port in 17000–19999, the mock provider and fake CLIs (`server/test/helpers.ts`).
- **Security code** (auth, isolation, SSRF, webhook signatures, file serving, approvals) is never loosened, and every change to it comes with tests. Report vulnerabilities privately (`SECURITY.md`).
- **The system prompt** keys every provider session: changing its text starts a new session for every Boton. Do it only on purpose and say so in the pull request.
- **The schema**: a change bumps `SCHEMA_VERSION` and upgrades the previous version in place, with a test.
- **Publishable**: no personal or environment details anywhere (files, commit messages, pull requests). Use the placeholders in `AGENTS.md`; `npm run check:public` catches the common shapes.
- **Dependencies**: as few as possible. Runtime dependencies must be permissively licensed (`server/test/licenses.test.ts` checks the lockfile).

## Pull requests

Keep one change per pull request, describe what it does and why, and make sure CI is green: the required `Node 24` and `check:public` checks (see below). Run `npm run test:full` locally when your change touches what only the full tier covers, or label the pull request `full-ci`. Commits are merged by rebase or fast-forward.

By contributing you agree that your contribution is licensed under the MIT License, like the rest of the project (`LICENSE`).

## Measuring tests

`npm test` and `npm run test:full` run Node's test reporter too, and write
`test-timings.json` (override with `TEST_TIMINGS`). They keep the ordinary spec
output and exit status. `node scripts/test-timing-report.mjs test-timings.json`
prints the 30 slowest files and individual tests. File and suite durations are
inclusive; adding them would double count. The overall summary measures test-runner
wall time, excluding dependency installation and browser checks outside the suite.
The full tier in CI uploads a timing artifact for each Node version even when tests fail.

## Fast and full CI

`npm test` runs the fast files only: in-process, each under about a second, with
no browser, Botons server, outside network, agent CLI or real deadline, and none
reading the docs. `scripts/test-tier.mjs` lists them explicitly; `npm test -- --list` and
`npm run test:integration -- --list` show the partition. Every other file runs in
`npm run test:full`, and new files default there; move a test into the fast list
only when it meets those rules. Never delete a test for taking time.

Pull requests run two required checks, nothing else by default:

- **Node 24**: cached `npm ci`, typecheck and `npm test`, one job, about a runner
  minute. When every changed file is documentation or an image (Markdown and
  `docs/` outside the code folders, `LICENSE`, images outside `server/`;
  `scripts/ci-scope.mjs`), the job still runs and passes without installing
  anything, so the required check never waits on a job that path filters
  skipped. Any doubt about the changed files runs the whole job.
- **check:public**: every file plus the pull request's commits, title and
  description, rerun when the description is edited.

The full tier runs weekly (Mondays 08:23 UTC), by hand (workflow dispatch), and on
pull requests labelled **full-ci**: every test on Node 24 and 26 with Chromium and
bubblewrap, run before the web build exists and then the build-dependent test,
recovery, viewport and themes, the preview sandbox, API brains, first run, chat
performance budgets, the Docker image, the Debian installer, the Codex helper with
masked proc, and the Node 26 handover quarantine. A newer push to a pull request
cancels its running CI.

A pull request may merge when both required checks are green. `npm run deploy`
runs `npm run test:full` before it builds the web app, so nothing reaches a
running install without the full suite. Label security, installer, browser or
Docker changes **full-ci** and wait for its jobs before merging; the weekly run
catches what slips through.

**Quarantine:** only Node 26's `browser-handover.test.ts` runs in a separate,
visible, nonblocking job with its own timing artifact. Node 24 still runs that
entire file as blocking coverage. No retry hides failures. Remove the quarantine
only after the startup/cleanup race is fixed and 20 repeated Node 26 CI runs pass.

[Runtime measurements](docs/TEST-RUNTIME.md) list the slowest files and tests and
the costs visible in their fixtures. Prefer injected clocks for deadline logic;
keep real browsers and processes for behavior that depends on those boundaries.
