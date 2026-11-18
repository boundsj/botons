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


## Rules a change must keep

- **Tests** for every behavior change, and never against a real install: tests get a temp `BOTONS_HOME`, a free port in 17000–19999, the mock provider and fake CLIs (`server/test/helpers.ts`).
- **Security code** (auth, isolation, SSRF, webhook signatures, file serving, approvals) is never loosened, and every change to it comes with tests. Report vulnerabilities privately (`SECURITY.md`).
- **The system prompt** keys every provider session: changing its text starts a new session for every Boton. Do it only on purpose and say so in the pull request.
- **The schema**: a change bumps `SCHEMA_VERSION` and upgrades the previous version in place, with a test.
- **Publishable**: no personal or environment details anywhere (files, commit messages, pull requests). Use placeholders such as Sam, `sam@example.com`, `myhost`, `example-tailnet.ts.net` and `/home/you`; `npm run check:public` catches the common shapes.
- **Dependencies**: as few as possible. Runtime dependencies must be permissively licensed (`server/test/licenses.test.ts` checks the lockfile).

## Pull requests

Keep one change per pull request, describe what it does and why, and make sure CI is green: the required `Node 24` and `check:public` checks. Run `npm run test:full` locally when your change touches what only the full tier covers, or label the pull request `full-ci`. Commits are merged by rebase or fast-forward.

By contributing you agree that your contribution is licensed under the MIT License, like the rest of the project (`LICENSE`).

