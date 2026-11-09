#!/usr/bin/env bash
# Export fetched origin/main (fetch it first). Never contacts a remote or pushes.
set -euo pipefail
root=$(git rev-parse --show-toplevel)
out=${1:?Usage: public-snapshot.sh EMPTY_DESTINATION}
mkdir -p "$out"
out=$(cd "$out" && pwd -P)
if [ -n "$(ls -A "$out")" ]; then echo 'Destination must be empty' >&2; exit 1; fi
source_sha=$(git -C "$root" rev-parse refs/remotes/origin/main)
git -C "$root" archive "$source_sha" | tar -x -C "$out"
# Exclude local agent settings; contributor instructions and generated brand assets are public.
rm -f "$out/.claude/settings.local.json" "$out/.mcp.json"
# A disposable external index lets check:public enumerate the export before its new repo exists.
metadata=$(mktemp -d)
trap 'rm -rf "$metadata"' EXIT
git init -q --bare "$metadata"
(cd "$out" && GIT_DIR="$metadata" GIT_WORK_TREE="$out" npm run check:public -- --strict)
git -C "$out" init -q -b main
git -C "$out" add .
GIT_AUTHOR_NAME=Botons GIT_AUTHOR_EMAIL=botons@users.noreply.github.com \
GIT_COMMITTER_NAME=Botons GIT_COMMITTER_EMAIL=botons@users.noreply.github.com \
  git -C "$out" -c core.hooksPath=/dev/null -c commit.gpgsign=false commit -q -m 'Initial public release'
printf 'Snapshot: %s\nSource main: %s\n' "$out" "$source_sha"
git -C "$out" log -1 --format='Commit: %H%nAuthor: %an <%ae>%nCommitter: %cn <%ce>'
printf 'Files: '; git -C "$out" ls-files | wc -l
du -sh "$out"
