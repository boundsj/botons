#!/usr/bin/env bash
# Export fetched origin/main (fetch it first). Never contacts a remote or pushes.
set -euo pipefail
root=$(git rev-parse --show-toplevel)
out=${1:?Usage: public-snapshot.sh EMPTY_DESTINATION}
mkdir -p "$out"
out=$(cd "$out" && pwd -P)
if [ -n "$(ls -A "$out")" ]; then echo 'Destination must be empty' >&2; exit 1; fi
source_sha=$(git -C "$root" rev-parse refs/remotes/origin/main)
# ios/ holds the native app, which stays private: it never enters an export, whatever origin/main holds.
git -C "$root" archive "$source_sha" -- . ':(exclude)ios' | tar -x -C "$out"
# Exclude local agent settings; contributor instructions and generated brand assets are public.
rm -f "$out/.claude/settings.local.json" "$out/.mcp.json"
# Native sources anywhere else (another casing, a nested folder) stop the export instead of shipping.
native=$(cd "$out" && find . \( -iname ios -o -iname '*.swift' -o -iname '*.xcodeproj' -o -iname '*.xcworkspace' \
  -o -iname '*.pbxproj' -o -iname '*.xcconfig' -o -iname '*.entitlements' -o -iname Podfile \) -print)
if [ -n "$native" ]; then printf 'Native app sources must stay private; found in the export:\n%s\n' "$native" >&2; exit 1; fi
# A disposable external index lets check:public enumerate the export before its new repo exists.
metadata=$(mktemp -d)
trap 'rm -rf "$metadata"' EXIT
git init -q --bare "$metadata"
(cd "$out" && GIT_DIR="$metadata" GIT_WORK_TREE="$out" npm run check:public -- --strict)
git -C "$out" init -q -b main
git -C "$out" add .
# A users.noreply.github.com address links commits to whichever GitHub account owns that username.
GIT_AUTHOR_NAME=Botons GIT_AUTHOR_EMAIL=hello@getbotons.com \
GIT_COMMITTER_NAME=Botons GIT_COMMITTER_EMAIL=hello@getbotons.com \
  git -C "$out" -c core.hooksPath=/dev/null -c commit.gpgsign=false commit -q -m 'Initial public release'
printf 'Snapshot: %s\nSource main: %s\n' "$out" "$source_sha"
git -C "$out" log -1 --format='Commit: %H%nAuthor: %an <%ae>%nCommitter: %cn <%ce>'
printf 'Files: '; git -C "$out" ls-files | wc -l
du -sh "$out"
