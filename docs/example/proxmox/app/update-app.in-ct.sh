#!/usr/bin/env bash
#
# Update the Open Poll Plus app to a new version, INSIDE the App container.
# You normally do NOT run this by hand — on the Proxmox node run
# app/update-app-to-ct.sh , which snapshots the CT first (rollback safety), then
# pushes this in and runs it. (To run it manually: pct enter <App CT ID>, then
#  APP_REF=4.1.1.1 bash update-app.in-ct.sh .)
#
# It fetches + checks out the ref (a branch at exactly origin's tip, or a tag), re-syncs dependencies to
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
UPGRADE_NODE="${UPGRADE_NODE:-false}" # true = also upgrade Node.js within its installed major (npm comes with it)
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

# Bring the checkout to the ref being deployed — exactly what origin has.
#   BRANCH (APP_REF, or the current branch when APP_REF is blank): reset the local
#     branch to origin/<branch>. A plain `git pull --ff-only` wedges with "Not
#     possible to fast-forward" when the branch was force-pushed / re-cut upstream
#     (e.g. a feature branch reset after a squash-merge); a deploy checkout carries
#     no local commits, so following the remote tip is the right behavior.
#   TAG / commit: checked out as a detached HEAD.
# Uncommitted local edits that the new ref would overwrite make git refuse, so the
# script stops here — BEFORE the restart — and the running app is untouched.
sync_to_ref() {
  git fetch --tags --prune origin
  local target="${APP_REF:-$(git symbolic-ref -q --short HEAD || true)}"
  if [ -z "${target}" ]; then
    echo "ERROR: the checkout is on a detached tag/commit ($(_ver)), so there is no branch to pull." >&2
    echo "       Name the version to deploy, e.g.  APP_REF=master  or  APP_REF=<tag>" >&2
    return 1
  fi
  if git show-ref --verify --quiet "refs/remotes/origin/${target}"; then
    echo ">>> Checking out branch '${target}' at origin/${target} ..."
    git checkout -B "${target}" "origin/${target}"
  elif [ -n "${APP_REF}" ]; then
    echo ">>> Checking out '${APP_REF}' ..."
    git checkout "${APP_REF}"
  else
    echo "ERROR: branch '${target}' has no origin/${target} to update from." >&2
    return 1
  fi
}
sync_to_ref
echo ">>> New version:     $(_ver)"

# --- Optional: upgrade Node.js within its installed major (UPGRADE_NODE=true) -----
# apt only offers what the NodeSource repo set up at install provides (setup_<major>.x),
# so this never jumps a major. npm and Corepack ship inside the nodejs package and
# update with it. Runs after the node-side snapshot and BEFORE the restart, so a
# failure stops the update here with the old Node still serving.
if [ "${UPGRADE_NODE}" = true ]; then
  echo ">>> Upgrading Node.js within its major (now $(node -v), npm $(npm -v)) ..."
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --only-upgrade nodejs
  hash -r
  echo ">>> Node.js is now $(node -v), npm $(npm -v)"
fi

# --- Sync dependencies to this ref's yarn.lock ------------------------------
# Node <=24 bundles Corepack; Node 25+ unbundled it — install from npm if missing.
command -v corepack >/dev/null 2>&1 || npm install -g corepack
corepack enable
# When the repo pins a NEW Yarn version, Corepack downloads it here; run from a
# terminal it would stop to ask "Do you want to continue? [Y/n]". Don't ask.
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
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
