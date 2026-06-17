#!/usr/bin/env bash
#
# Install the Open Poll Plus app. This runs INSIDE the App container (CT 5000) —
# you normally do NOT run it by hand. On the Proxmox node run
# app/deploy-app-to-ct.sh , which pushes this in and runs it, then pushes your
# config and installs Caddy. (To run it manually: pct enter 5000, then bash this.)
#
# It installs Node.js, enables Corepack/Yarn 4, clones the repo, installs
# dependencies, creates a dedicated service user, and prepares config/logs.
# It does NOT start the app — you must fill in config/default.json first
# (see app/default.json.example) and install the systemd unit.
set -euo pipefail

# ── Safety: run INSIDE the App container (CT 5000), NOT on a Proxmox node. ────
# This installs Node.js and clones the repo; on a node that would pollute the
# hypervisor. A Proxmox host has /etc/pve + pct/pveversion; a container does
# not — so bail out if we detect a host.
if [ -d /etc/pve ] || command -v pct >/dev/null 2>&1 || command -v pveversion >/dev/null 2>&1; then
  echo "ERROR: this looks like a Proxmox HOST, not the App container (CT 5000)." >&2
  echo "       Run it inside the CT:  pct enter 5000   then  bash setup-app.in-ct.sh" >&2
  exit 1
fi

# ─────────────────────────── settings to review ────────────────────────────
NODE_MAJOR=24                                  # 24 = current Active LTS (engines: >= 20.19; tested on 24.x)
APP_USER="openpoll"
APP_DIR="/opt/openpollslack-i18n"
REPO_URL="https://github.com/polppol/openpollslack-i18n.git"
# ────────────────────────────────────────────────────────────────────────────

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y curl ca-certificates gnupg git

# --- Node.js LTS via NodeSource + Corepack (Yarn 4) -------------------------
curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
apt-get install -y nodejs
# Yarn 4 is pinned via package.json "packageManager"; Corepack provides it.
# Node <=24 bundles Corepack; Node 25+ unbundled it — install from npm if missing.
command -v corepack >/dev/null 2>&1 || npm install -g corepack
corepack enable

# --- Dedicated, unprivileged service account --------------------------------
id -u "${APP_USER}" >/dev/null 2>&1 || \
  useradd --system --create-home --shell /usr/sbin/nologin "${APP_USER}"

# --- Code -------------------------------------------------------------------
# Deploys the latest commit of the repo's DEFAULT branch (master) — which
# release to run is up to you. To deploy a specific release tag or a different
# branch instead, check it out (after the clone, or any time later) and
# re-install deps:
#   git -C "${APP_DIR}" fetch --tags --prune origin
#   git -C "${APP_DIR}" checkout 4.1.1.1        # a release tag (list them: git tag)
#   git -C "${APP_DIR}" checkout some-branch    # or a different branch
#   corepack yarn install --immutable           # re-sync deps to that ref, then restart
if [ -d "${APP_DIR}/.git" ]; then
  git -C "${APP_DIR}" pull --ff-only
else
  git clone "${REPO_URL}" "${APP_DIR}"
fi
cd "${APP_DIR}"

# Uses the Yarn version pinned in package.json (packageManager field).
# --immutable: install exactly what yarn.lock says, fail if it would change.
corepack yarn install --immutable

# --- Config + logs ----------------------------------------------------------
if [ ! -f config/default.json ]; then
  cp config/default.json.dist config/default.json
  echo ">>> Created config/default.json from the template — YOU MUST EDIT IT."
  echo ">>> Use docs/example/proxmox/app/default.json.example as a guide:"
  echo ">>>   - mongo_url (point at the DB container, with the openpoll password)"
  echo ">>>   - client_id / client_secret / signing_secret (from your Slack app)"
  echo ">>>   - state_secret (any random string)"
  echo ">>>   - oauth_success / oauth_failure (pages on your domain)"
fi
mkdir -p "${APP_DIR}/logs"
chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}"

cat <<EOF

Node + the app are installed at ${APP_DIR}.
The deploy wrapper (app/deploy-app-to-ct.sh, run on the Proxmox node) takes it
from here: it pushes your config/default.json, starts the openpoll service, and
installs + starts Caddy. Nothing else to run inside this container.
EOF
