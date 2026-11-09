# Releasing

## A release

1. On `main`, with CI green: `npm ci && npm run typecheck && npm run test:full && npm run build`.
2. `npm run check:public -- --commits <previous tag>..HEAD`, and `scripts/docker-smoke.sh` if Docker is at hand (CI runs it too).
3. Bump `VERSION` in `server/src/api.ts` (semantic versioning: a schema change or a removed setting is a major change before 1.0 only if it can't be upgraded in place).
4. Move the Unreleased notes in `CHANGELOG.md` under the version, then commit, tag `vX.Y.Z`, push the tag, and write the release notes from them: what changed for operators (settings, schema version, upgrade steps), not how it was built.
5. Deploy it where it runs (systemd: `npm run deploy -- vX.Y.Z`; Docker: the upgrade steps in `docs/DOCKER.md`), then `npm run doctor`.

## Making the repository public

Whether and when to publish, and under which account, is the owner's decision; nothing in this repository does it. Before the switch:

- **The whole history must pass** `npm run check:public -- --commits HEAD` with the private terms list in place, and every commit's author and committer identity must be one the owner is happy to publish (the check notes each identity that isn't a no-reply address). If either fails, publish a new repository made from one reviewed snapshot commit instead of this history: rewriting history in place leaves the old commits reachable from pull request refs and forks.
- **Pull requests, issues, releases and tags** are published too: read their titles and descriptions, or start the public repository without them.
- **The tree**: `npm run check:public` clean; no binary file without a reason; `LICENSE` names the right copyright holder.
- **Dependencies**: `server/test/licenses.test.ts` passes (permissive runtime licenses), and `npm audit` has nothing open that ships.
- **Repository settings**: private vulnerability reporting on (`SECURITY.md` points at it), secret scanning and push protection on, branch protection for `main` requiring CI and the Public check.
- **Secrets**: none in the repository, its Actions settings or its workflows beyond what CI needs (it needs none today).
