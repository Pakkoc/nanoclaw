#!/bin/bash
# Self-heal hook: ensure the better-sqlite3 native binary matches the service's
# Node (v22) BEFORE NanoClaw starts.
#
# Why this exists: this mini PC has three Node versions — system v18 (other PM2
# bots depend on it), the shell default v20 (nvm), and v22 (nvm) which NanoClaw
# runs on. better-sqlite3 is a native addon compiled for ONE Node version. If
# anything rebuilds it with the wrong Node (e.g. a stray `npm install` run from
# a normal shell on v20), the v22 service crash-loops with
# "compiled against a different Node.js version". Run as systemd ExecStartPre,
# this detects the mismatch and rebuilds better-sqlite3 with Node 22, so a
# restart self-heals in seconds instead of looping for minutes.
#
# Always exits 0: never blocks startup. If the binary is fine it is a ~0.3s
# no-op; if broken it rebuilds; if the rebuild itself fails it logs and lets the
# main process surface the error (systemd will retry, and so will this hook).
set -u
NODE22_BIN=/home/s980903/.nvm/versions/node/v22.22.2/bin
NODE="$NODE22_BIN/node"
PROJECT=/home/s980903/nanoclaw
cd "$PROJECT" || exit 0

if "$NODE" -e "require('better-sqlite3')" >/dev/null 2>&1; then
  echo "[ensure-better-sqlite3] OK — better-sqlite3 matches node22, no action"
  exit 0
fi

echo "[ensure-better-sqlite3] MISMATCH — rebuilding better-sqlite3 for node22..."
PATH="$NODE22_BIN:$PATH" npm rebuild better-sqlite3 >/dev/null 2>&1 || true

if "$NODE" -e "require('better-sqlite3')" >/dev/null 2>&1; then
  echo "[ensure-better-sqlite3] rebuild OK — better-sqlite3 now matches node22"
else
  echo "[ensure-better-sqlite3] rebuild FAILED — run 'npm rebuild better-sqlite3' with node22 manually" >&2
fi
exit 0
