#!/usr/bin/env bash
#
# Update the Open Poll Plus app to a new version, INSIDE the App container.
# You normally do NOT run this by hand — on the Proxmox node run
# app/update-app-to-ct.sh , which snapshots the CT first (rollback safety), then
# pushes this in and runs it. (To run it manually: pct enter <App CT ID>, then
#  APP_REF=4.1.1.1 bash update-app.in-ct.sh .)
#
# It git-pulls (or checks out a specific tag/branch), re-syncs dependencies to
# that ref's yarn.lock, fixes ownership, restarts the service, and waits for a
# healthy start. Works for BOTH bundled and app-only CTs — it only touches the
# Node app, never Caddy.
#
# Settings honor an env override (the wrapper sets these). After :- is the default.
set -euo pipefail

# ── Safety: run INSIDE the App container, NOT on a Proxmox node. ─────────────
if [ -d /etc/pve ] || command -v pct >/dev/null 2>&1 || command -v pveversion >/dev/null 2>&1; then
  echo "ERROR: this looks like a Proxmox HOST, not the App container." >&2
  echo "       Run it inside the CT:  pct enter <App CT ID>   then  bash update-app.in-ct.sh" >&2
  exit 1
fi

# ─────────────────────────── settings to review ────────────────────────────
APP_DIR="${APP_DIR:-/opt/openpollslack-i18n}"
APP_USER="${APP_USER:-openpoll}"
APP_PORT="${APP_PORT:-5000}"        # the port the app listens on (for the health check)
APP_REF="${APP_REF:-}"              # tag/branch to deploy; empty = pull the current branch
# ────────────────────────────────────────────────────────────────────────────

[ -d "${APP_DIR}/.git" ] || {
  echo "ERROR: ${APP_DIR} is not a git checkout — was the app installed by setup-app.in-ct.sh?" >&2
  exit 1; }

# The repo is owned by ${APP_USER}, but we run git as root here (via pct exec).
# Let root operate on it without git's "dubious ownership" refusal. Idempotent.
git config --global --get-all safe.directory 2>/dev/null | grep -qxF "${APP_DIR}" \
  || git config --global --add safe.directory "${APP_DIR}"

cd "${APP_DIR}"
_ver() { git describe --tags --always 2>/dev/null || git rev-parse --short HEAD; }
echo ">>> Current version: $(_ver)"

if [ -n "${APP_REF}" ]; then
  echo ">>> Fetching, then checking out '${APP_REF}' ..."
  git fetch --tags --prune origin
  git checkout "${APP_REF}"
  # If APP_REF is a BRANCH (HEAD is a symbolic ref), fast-forward to its tip.
  # If it's a TAG (detached HEAD), there is nothing to pull — skip cleanly.
  if git symbolic-ref -q HEAD >/dev/null 2>&1; then
    git pull --ff-only
  fi
else
  echo ">>> Pulling latest of the current branch ..."
  git pull --ff-only
fi
echo ">>> New version:     $(_ver)"

# --- Sync dependencies to this ref's yarn.lock ------------------------------
# Node <=24 bundles Corepack; Node 25+ unbundled it — install from npm if missing.
command -v corepack >/dev/null 2>&1 || npm install -g corepack
corepack enable
corepack yarn install --immutable

# setup/install ran as root; keep ownership correct for the service user.
chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}"

echo ">>> Restarting openpoll ..."
systemctl restart openpoll

# The app runs any pending DB migrations on startup BEFORE serving traffic, so
# wait for /healthz rather than a fixed sleep (watch for "Bolt app is running!").
echo ">>> Waiting for the app to become healthy on :${APP_PORT} ..."
for _i in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${APP_PORT}/healthz" >/dev/null 2>&1; then
    echo ">>> Healthy: $(curl -fsS "http://127.0.0.1:${APP_PORT}/healthz")"
    echo "Update complete — now at $(_ver)."
    exit 0
  fi
  sleep 1
done

echo "WARN: app not healthy after 60s. Check the logs:" >&2
echo "      journalctl -u openpoll -n 50 --no-pager" >&2
echo "      (if a release bumped the Node major version, re-run the Node install" >&2
echo "       step from setup-app.in-ct.sh, then restart.)" >&2
exit 1
