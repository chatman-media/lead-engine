#!/usr/bin/env bash
#
# Deploy the latest code on the VPS (systemd setup, NOT Docker).
#
# Run as root on the server:
#     bash /home/chatman/app/deploy.sh
#
# What it does, in order:
#   1. git pull            — fetch the latest committed code
#   2. bun install         — sync dependencies (frozen lockfile)
#   3. bun run build:ui    — rebuild the admin UI bundle
#   4. systemctl restart   — restart the bot service
#   5. health check        — confirm the service came back up
#
# The repo is owned by the `chatman` user, so the build steps run as that
# user (otherwise git/bun would leave root-owned files and break perms).
# Only the systemctl restart needs root.
#
# Override defaults via env if your paths differ:
#     APP_DIR=/srv/app SERVICE=mybot.service bash deploy.sh
#
set -euo pipefail

APP_DIR="${APP_DIR:-/home/chatman/app}"
SERVICE="${SERVICE:-chatman.service}"
APP_USER="${APP_USER:-chatman}"

# bun is installed per-user (~/.bun/bin/bun). A non-interactive login shell
# does not always put it on PATH — `bun: command not found` — so resolve the
# absolute path explicitly. Override with BUN=/path/to/bun if it differs.
BUN="${BUN:-/home/$APP_USER/.bun/bin/bun}"
if [ ! -x "$BUN" ]; then
  BUN="$(sudo -u "$APP_USER" bash -lc 'command -v bun' 2>/dev/null || true)"
fi
if [ -z "$BUN" ] || [ ! -x "$BUN" ]; then
  echo "✗ bun not found — set it explicitly:  BUN=/path/to/bun bash deploy.sh" >&2
  exit 1
fi

echo "=== Deploy: $APP_DIR → $SERVICE ==="
echo "    bun: $BUN"

if [ ! -d "$APP_DIR/.git" ]; then
  echo "✗ $APP_DIR is not a git repository — check APP_DIR" >&2
  exit 1
fi

echo "→ [1/4] git pull"
sudo -u "$APP_USER" git -C "$APP_DIR" pull --ff-only

echo "→ [2/4] bun install (dependencies)"
sudo -u "$APP_USER" bash -lc "cd '$APP_DIR' && '$BUN' install --frozen-lockfile"

echo "→ [3/4] bun run build:ui (admin panel)"
sudo -u "$APP_USER" bash -lc "cd '$APP_DIR' && '$BUN' run build:ui"

echo "→ [4/4] restart $SERVICE"
systemctl restart "$SERVICE"

# Give the process a moment to boot, run migrations and bind the port.
sleep 4

if systemctl is-active --quiet "$SERVICE"; then
  echo "✓ Deploy done — $SERVICE is running."
  echo "  Live log:  journalctl -u $SERVICE -f"
else
  echo "✗ $SERVICE is NOT active after restart. Recent log:" >&2
  journalctl -u "$SERVICE" -n 40 --no-pager >&2
  exit 1
fi
