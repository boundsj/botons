#!/usr/bin/env bash
# Build the image and exercise it end to end in a throwaway Compose project ("botons-smoke": its own containers and
# volumes, never a real install's): start, health, doctor, the managed browser, pair, backup, stop, restore, start
# again, and a restore onto new, empty volumes as a fresh machine has them. Before any of that, the first run in a
# browser (scripts/check-firstrun.ts, needs Node 24+ and Chrome here). The mock provider
# stands in for the agent CLIs, which are not installed. CI runs this; so can you (needs Docker).
#   scripts/docker-smoke.sh            build and test, then remove the smoke project
#   KEEP=1 scripts/docker-smoke.sh     leave it running to look at
set -euo pipefail
cd "$(dirname "$0")/.."

export COMPOSE_PROJECT_NAME=botons-smoke
export BOTONS_PUBLISH_PORT="${BOTONS_PUBLISH_PORT:-17777}"
export BOTONS_INSTALL_CLAUDE=0 BOTONS_INSTALL_CODEX=0
export BOTONS_BUILD_SHA="${BOTONS_BUILD_SHA:-$(git rev-parse HEAD 2>/dev/null || true)}"
override="$(mktemp)"
offhost="$(mktemp -d)"
trap 'if [ -z "${KEEP:-}" ]; then docker compose -f compose.yaml -f "$override" down -v --remove-orphans >/dev/null 2>&1 || true; fi; rm -rf "$override" "$offhost"' EXIT
cat >"$override" <<YAML
services:
  botons:
    image: botons:smoke
    env_file: !reset []
    environment:
      BOTONS_ENABLE_MOCK: "1"
      BOTONS_SCHEDULER_MS: "1s"
YAML
compose() { docker compose -f compose.yaml -f "$override" "$@"; }
step() { printf '\n== %s\n' "$*"; }

wait_healthy() {
  for _ in $(seq 1 60); do
    if [ "$(docker inspect -f '{{.State.Health.Status}}' "$(compose ps -q botons)" 2>/dev/null)" = healthy ]; then return 0; fi
    sleep 2
  done
  compose logs botons | tail -50
  echo "botons did not become healthy" >&2
  return 1
}

step build
compose build
step up
compose up -d
wait_healthy
step "health from this machine (127.0.0.1:$BOTONS_PUBLISH_PORT only)"
curl -fsS "http://127.0.0.1:$BOTONS_PUBLISH_PORT/api/health"; echo
step "a request for another host name is refused"
code="$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: attacker.example.com' "http://127.0.0.1:$BOTONS_PUBLISH_PORT/api/health")"
[ "$code" = 403 ] || { echo "expected 403, got $code" >&2; exit 1; }
step "the API needs a paired device"
code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$BOTONS_PUBLISH_PORT/api/bots")"
[ "$code" = 401 ] || { echo "expected 401, got $code" >&2; exit 1; }
step "first run in a browser, on the fresh container: claim, setup, the first Boton and its reply, all saying Botons"
# Headless Chrome on this machine, against the published port; the code is approved inside the container, as the
# owner does. SKIP_BROWSER=1 skips it where there is no Chrome (CI always runs it).
if [ -n "${SKIP_BROWSER:-}" ]; then
  echo "skipped (SKIP_BROWSER)"
else
  node scripts/check-firstrun.ts --url "http://127.0.0.1:$BOTONS_PUBLISH_PORT" \
    --approve "docker compose -f compose.yaml -f '$override' exec -T botons botons pair --approve {code}"
fi
step doctor
compose exec -T botons botons doctor --skip-clis
step "the managed browser: the image's Chromium, found and started the way a turn starts it"
doctor_json="$(compose exec -T botons botons doctor --skip-clis --json || true)"
printf '%s' "$doctor_json" | grep -q '"check": *"browser"' || { echo "doctor has no browser check" >&2; exit 1; }
printf '%s' "$doctor_json" | grep -q '/usr/bin/chromium' || { echo "doctor did not find the image's Chromium" >&2; exit 1; }
# With Chromium's sandbox on, as every install runs it: compose.yaml's seccomp profile lets it start, and this fails
# if it doesn't. Nothing here turns the sandbox off.
browser_check="$(compose exec -T botons botons check-browser 2>&1)" || { printf '%s\n' "$browser_check" >&2; echo "the managed browser did not start with its sandbox" >&2; exit 1; }
printf '%s\n' "$browser_check"
case "$browser_check" in *"works here (with its sandbox)"*) ;; *) echo "check-browser did not run with Chromium's sandbox" >&2; exit 1 ;; esac
# And the profile allows only the namespaces that sandbox needs: a mount namespace is still refused.
if compose exec -T botons unshare -U -m true 2>/dev/null; then echo "the container may make mount namespaces" >&2; exit 1; fi
compose exec -T botons unshare -U -n -p -f true
step "pair: a device asks, the host approves its code, and only then does the device get a token"
api="http://127.0.0.1:$BOTONS_PUBLISH_PORT/api"
asked="$(curl -fsS -X POST -H 'content-type: application/json' -d '{"label":"smoke"}' "$api/auth/pair-requests")"
pair_code="$(printf '%s' "$asked" | sed -n 's/.*"code":"\([^"]*\)".*/\1/p')"
pair_secret="$(printf '%s' "$asked" | sed -n 's/.*"secret":"\([^"]*\)".*/\1/p')"
code="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d "{\"code\":\"$pair_code\"}" "$api/auth/pair")"
[ "$code" = 400 ] || { echo "a code alone paired: $code" >&2; exit 1; }
compose exec -T botons botons pair --approve "$pair_code" | grep 'Approved' >/dev/null
paired="$(curl -fsS -X POST -H 'content-type: application/json' -d "{\"secret\":\"$pair_secret\"}" "$api/auth/pair")"
token="$(printf '%s' "$paired" | sed -n 's/.*"token":"\(mdt_[^"]*\)".*/\1/p')"
[ -n "$token" ] || { echo "pairing gave no device token" >&2; exit 1; }
step backup
compose exec -T botons sh -c 'echo kept > /data/shared/smoke.txt'
compose exec -T botons botons backup
compose exec -T botons rm /data/shared/smoke.txt
step "restore needs the server stopped"
if compose run --rm --no-deps -T botons restore latest --yes; then echo "restore ran beside a running server" >&2; exit 1; fi
compose stop botons
compose run --rm --no-deps -T botons restore latest --yes
step "up again after the restore"
compose start botons
wait_healthy
[ "$(compose exec -T botons cat /data/shared/smoke.txt)" = kept ]
step "the data survives recreating the container"
compose up -d --force-recreate botons
wait_healthy
[ "$(compose exec -T botons cat /data/shared/smoke.txt)" = kept ]
step "a fresh machine: the backup copied off, new empty volumes, the backup copied in as the server's user, restored"
name="$(compose exec -T botons sh -c 'cd /data/backups && ls -d 2*Z | sort | tail -1')"
compose exec -T botons tar -C /data/backups -c "$name" | tar -C "$offhost" -x
compose down -v
tar -C "$offhost" -c "$name" | compose run --rm --no-deps -T --entrypoint sh botons -c 'mkdir -p -m 700 /data/backups && tar -C /data/backups -x'
compose run --rm --no-deps -T botons restore "$name" --yes
compose up -d
wait_healthy
[ "$(compose exec -T botons cat /data/shared/smoke.txt)" = kept ]
code="$(curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer $token" "$api/bots")"
[ "$code" = 200 ] || { echo "the restored server did not take the device paired before the backup: $code" >&2; exit 1; }
printf '\nDocker smoke test passed.\n'
