#!/usr/bin/env bash
set -euo pipefail
SRC="E:/studywork/DSHwork/plugins/dsh-notify-fork"
DST="$HOME/.dsh/profiles/desktop/node_modules/dsh-notify-plugin"
STAMP=$(date +%Y%m%d-%H%M%S)
if [ -d "$DST" ] && [ ! -f "$DST/.fork-deployed" ]; then
  mkdir -p "$HOME/.dsh/backups"
  cp -r "$DST" "$HOME/.dsh/backups/dsh-notify-plugin-$STAMP"
  echo "backup -> $HOME/.dsh/backups/dsh-notify-plugin-$STAMP"
fi
rm -rf "$DST"
mkdir -p "$DST"
cd "$SRC"
# node_modules/ and the lockfile are build-only; the host resolves deps from the profile.
tar -cf - --exclude=./node_modules --exclude=./package-lock.json . | (cd "$DST" && tar -xf -)
touch "$DST/.fork-deployed"
echo "deployed -> $DST"
