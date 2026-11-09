#!/bin/sh
set -eu
# Run inside the disposable Debian container as an ordinary user.
export HOME=/tmp/botons-tar-home npm_config_cache=/tmp/botons-tar-cache
mkdir -p "$HOME"
npx -y file:/tmp/getbotons-0.0.0.tgz install --yes --no-service --host 0.0.0.0 --home /tmp/botons-tar-data
npx -y file:/tmp/getbotons-0.0.0.tgz repair --yes --no-service --no-sudo
# Prove the tarball install serves before testing Git in another clean home/cache.
export BOTONS_HOME=/tmp/botons-tar-data BOTONS_PORT=18788 BOTONS_HOST=0.0.0.0 BOTONS_NO_TAILSCALE=1 BOTONS_ENABLE_MOCK=1 BOTONS_CLAUDE_BIN=/nonexistent/claude BOTONS_CODEX_BIN=/nonexistent/codex
"$HOME/.local/bin/botons" serve >/tmp/botons-tar-server.log 2>&1 &
tar_server=$!
trap 'kill "$tar_server" 2>/dev/null || true' EXIT
for attempt in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:18788/api/health; then break; fi
  sleep 1
done
curl -fsS http://127.0.0.1:18788/api/health
"$HOME/.local/bin/botons" backup
"$HOME/.local/bin/botons" doctor --skip-clis
kill "$tar_server"
wait "$tar_server" || true
trap - EXIT
unset BOTONS_HOME BOTONS_PORT
export HOME=/tmp/botons-git-home npm_config_cache=/tmp/botons-git-cache
mkdir -p "$HOME"
cd /work
# A local Git URL exercises npm cloning and the bin without credentials.
mkdir /tmp/botons-git
tar --exclude=node_modules --exclude=release-package --exclude=web/dist -cf - . | tar -xf - -C /tmp/botons-git
cd /tmp/botons-git
git init -q
git config user.name Sam
git config user.email sam@example.com
git add .
git diff --cached --quiet || git commit -m 'Test installer package'
node /work/installer/probe-git-spec.mjs /tmp/botons-git
npx -y git+file:///tmp/botons-git install --dry-run
npx -y git+file:///tmp/botons-git install --yes --no-service --host 0.0.0.0 --home /tmp/botons-data
npx -y file:/tmp/getbotons-0.0.0.tgz repair --yes --no-service --no-sudo --home /tmp/botons-data
export BOTONS_HOME=/tmp/botons-data BOTONS_PORT=18789 BOTONS_HOST=0.0.0.0 BOTONS_NO_TAILSCALE=1 BOTONS_ENABLE_MOCK=1 BOTONS_CLAUDE_BIN=/nonexistent/claude BOTONS_CODEX_BIN=/nonexistent/codex
"$HOME/.local/bin/botons" serve >/tmp/botons-server.log 2>&1 &
server=$!
trap 'kill "$server" 2>/dev/null || true' EXIT
for attempt in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:18789/api/health; then break; fi
  sleep 1
done
curl -fsS http://127.0.0.1:18789/api/health
"$HOME/.local/bin/botons" backup
"$HOME/.local/bin/botons" doctor --skip-clis
runtime=$(find "$HOME/.local/share/botons/node" -path '*/bin/node' | head -1)
"$runtime" --input-type=module <<'JS'
import { sandboxProblem, runProcess } from '/tmp/botons-git-home/.local/share/botons/current/server/src/sandbox.ts';
import { mkdtempSync, rmSync } from 'node:fs';
const problem = sandboxProblem();
if (problem) throw new Error(problem);
const cwd = mkdtempSync('/tmp/botons-sandbox-');
try {
  const env = { PATH: process.env.PATH, HOME: cwd };
  const result = await runProcess({ argv: ['/bin/sh', '-c', 'echo sandbox-ok > result; cat result'], sandbox: { cwd, writable: [cwd], hidden: [], readOnly: [], env }, cwd, env, timeoutMs: 10000, maxBytes: 4096, signal: new AbortController().signal });
  if (result.code !== 0 || !result.stdout.toString().includes('sandbox-ok')) throw new Error(JSON.stringify(result));
} finally { rmSync(cwd, { recursive: true, force: true }); }
JS
