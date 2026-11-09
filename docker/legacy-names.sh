#!/bin/sh
# LEGACY NAMES (see shared/legacy-names.mjs): moves a Docker Compose install made under an earlier project name to
# the botons project. Run it once from the checkout, before the first `docker compose up` of this version:
#   sh docker/legacy-names.sh              stop the earlier project and copy its volumes and settings
#   sh docker/legacy-names.sh --rollback   stop the botons project and start the earlier one again
# The earlier containers are stopped, not removed, and their volumes are copied, never changed, so a rollback finds
# them as they were. botons.env is written from the earlier env files with each setting under its current name,
# .env is rewritten the same way (the earlier one kept as .env.before-botons), and a Tailscale sidecar keeps its
# tailnet name. Part of the legacy-names module: it goes with it.
set -eu
cd "$(dirname "$0")/.."

OLD_PROJECTS="tots minions"        # newest first
OLD_ENV_FILES="minions.env tots.env" # oldest first: a later file's value wins, as Compose read them
OLD_TS_HOSTNAME="minions"          # the sidecar's earlier default name
VOLUMES="data home tailscale caddy-data caddy-config"

has_volume() { docker volume inspect "$1" >/dev/null 2>&1; }
containers() { docker ps -aq --filter "label=com.docker.compose.project=$1"; }
rename_keys() {
  sed -E 's/^([[:space:]]*(export[[:space:]]+)?)(TOTS|MINIONS)_/\1BOTONS_/; s/^([[:space:]]*(export[[:space:]]+)?)(TOT|MINION)_/\1BOTON_/'
}

old=""
for p in $OLD_PROJECTS; do
  if has_volume "${p}_data"; then old="$p"; break; fi
done

if [ "${1:-}" = --rollback ]; then
  [ -n "$old" ] || { echo "There is no Compose project under an earlier name to go back to." >&2; exit 1; }
  ids="$(docker ps -q --filter label=com.docker.compose.project=botons)"
  [ -z "$ids" ] || docker stop -t 150 $ids >/dev/null
  [ ! -f .env.before-botons ] || mv .env.before-botons .env
  ids="$(containers "$old")"
  [ -z "$ids" ] || docker start $ids >/dev/null
  echo "Stopped the botons project and started $old again, on its volumes as they were before the move."
  exit 0
fi

[ -n "$old" ] || { echo "There is no Compose project under an earlier name: nothing to move."; exit 0; }
if has_volume botons_data; then
  echo "The botons project has volumes already, so nothing was changed. If they hold nothing you need, remove them (docker volume rm botons_data botons_home) and run this again." >&2
  exit 1
fi
image="$(docker ps -a --filter "label=com.docker.compose.project=$old" --filter "label=com.docker.compose.service=$old" --format '{{.Image}}' | head -n 1)"
[ -n "$image" ] || { echo "No container of the $old project to copy the volumes with: start it once (docker compose -p $old up -d), then run this again. Nothing was changed." >&2; exit 1; }

ids="$(docker ps -q --filter "label=com.docker.compose.project=$old")"
# Running turns get their drain time, as on any stop.
[ -z "$ids" ] || docker stop -t 150 $ids >/dev/null
echo "Stopped the $old project."
for v in $VOLUMES; do
  has_volume "${old}_$v" || continue
  docker volume create --label com.docker.compose.project=botons --label "com.docker.compose.volume=$v" "botons_$v" >/dev/null
  docker run --rm --user 0 --entrypoint sh -v "${old}_$v:/from:ro" -v "botons_$v:/to" "$image" -c 'cp -a /from/. /to/'
  echo "Copied ${old}_$v to botons_$v."
done

if [ ! -e botons.env ]; then
  found=""
  for f in $OLD_ENV_FILES; do [ -f "$f" ] && found="$found $f"; done
  if [ -n "$found" ]; then
    # shellcheck disable=SC2086
    cat $found | rename_keys > botons.env
    chmod 600 botons.env
    echo "Wrote botons.env from$found, each setting under its current name."
  fi
fi
if [ -f .env ] && [ ! -e .env.before-botons ]; then
  cp -p .env .env.before-botons
  rename_keys < .env.before-botons > .env
  if has_volume "${old}_tailscale" && ! grep -qE '^[[:space:]]*TS_HOSTNAME=' .env; then
    echo "TS_HOSTNAME=$OLD_TS_HOSTNAME" >> .env
    echo "Kept the Tailscale name $OLD_TS_HOSTNAME in .env, so devices, pushes and webhooks reach the same address."
  fi
  echo "Rewrote .env with each setting under its current name (the earlier one is .env.before-botons)."
fi
echo "Done. Start it with the same files as before, for example: docker compose up -d --build"
