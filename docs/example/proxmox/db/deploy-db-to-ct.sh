#!/usr/bin/env bash
#
# Deploy the DB container FROM A PROXMOX NODE — one command sets up the whole CT.
# It pushes the in-CT setup + backup files into the DB CT and runs them there via
# `pct push` + `pct exec`. You run THIS on the node; it installs nothing on the
# node itself (the actual install happens inside the container).
#
#   1. bash proxmox/create-containers.sh        # create the CTs (run first)
#   2. bash db/deploy-db-to-ct.sh               # <- this script
#
# Prompts for the settings below (Enter keeps the default). The two MongoDB
# passwords are prompted HIDDEN and handed to the in-CT scripts via the
# environment / a root-only env file — no secret is written into this kit's
# tracked files. For non-interactive use, pass them as env, e.g.:
#   NONINTERACTIVE=1 ADMIN_DB_PASS=... APP_DB_PASS=... bash db/deploy-db-to-ct.sh
#
# Cleaning up a failed/wrong-version install? Add --reset to PURGE MongoDB + its
# repo/keyring + ALL data in the CT first, then reinstall fresh (DESTRUCTIVE —
# confirmed interactively). Needed to switch an already-installed 8.0 to 7.0:
#   MONGO_MAJOR=7.0 bash db/deploy-db-to-ct.sh --reset
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"   # the db/ folder of this kit
_p="${HERE}/../lib/ask.sh"
[ -r "${_p}" ] || { echo "ERROR: missing ${_p}" >&2; exit 1; }
. "${_p}"

# ─────────────────────────── settings to review ────────────────────────────
DB_ID=5010                                   # the DB CT's id
DB_BIND_IP=10.100.51.42                       # the DB CT's internal IP (mongod binds loopback + this)
APP_DB_USER=openpoll                          # the application DB user to create
APP_DB_NAME=open_poll                         # the application database name
MONGO_MAJOR="${MONGO_MAJOR:-7.0}"             # MongoDB version. Default 7.0 = the safe choice: runs on
                                              # ALL current kernels (incl. >= 6.19). 8.0 is the longer-lived
                                              # current series but CRASHES on host kernel >= 6.19
                                              # (SERVER-121912; an LXC shares the host kernel, setup-db fails
                                              # fast on that combo). Use MONGO_MAJOR=8.0 only on kernels <= 6.18.
ADMIN_DB_PASS="${ADMIN_DB_PASS:-}"            # prompted (hidden) — MongoDB root/admin password
APP_DB_PASS="${APP_DB_PASS:-}"                # prompted (hidden) — application user password
# ────────────────────────────────────────────────────────────────────────────

RESET=false
for _arg in "$@"; do
  case "$(printf '%s' "${_arg}" | tr '[:upper:]' '[:lower:]')" in
    -y|--yes) NONINTERACTIVE=1 ;;
    --reset)  RESET=true ;;
    *) echo "ERROR: unknown argument '${_arg}' (supported: --reset, --yes)" >&2; exit 1 ;;
  esac
done
export NONINTERACTIVE

ask_active || echo ">>> non-interactive: keeping defaults (DB CT ${DB_ID}, IP ${DB_BIND_IP}, db ${APP_DB_NAME})." >&2
ask        DB_ID         "DB CT id"
ask        DB_BIND_IP    "DB CT internal IP (mongod bindIp)"
ask        APP_DB_USER   "Application DB user"
ask        APP_DB_NAME   "Application database name"
ask        MONGO_MAJOR   "MongoDB version (7.0 = safe on all kernels; 8.0 only if host kernel <= 6.18)"
ask_secret ADMIN_DB_PASS "MongoDB admin password"
ask_secret APP_DB_PASS   "MongoDB ${APP_DB_USER} password"

# The passwords are required (from a prompt or from env). They must be URI-safe
# (they go into a mongodb:// connection string here and in the app config) —
# URL-encode any reserved characters if your password has them.
if [ -z "${ADMIN_DB_PASS}" ] || [ -z "${APP_DB_PASS}" ]; then
  echo "ERROR: both the admin and the ${APP_DB_USER} password are required." >&2
  echo "       Answer the prompts, or pass ADMIN_DB_PASS=... APP_DB_PASS=... as env." >&2
  exit 1
fi

command -v pct >/dev/null 2>&1 || {
  echo "ERROR: 'pct' not found — run this ON a Proxmox node, not inside a CT." >&2; exit 1; }
pct status "${DB_ID}" >/dev/null 2>&1 || {
  echo "ERROR: CT ${DB_ID} not found — run proxmox/create-containers.sh first." >&2; exit 1; }

# Make sure the CT is up before we push/exec.
if ! pct exec "${DB_ID}" -- true 2>/dev/null; then
  echo ">>> Starting CT ${DB_ID} ..."
  pct start "${DB_ID}"
  for _i in $(seq 1 30); do pct exec "${DB_ID}" -- true 2>/dev/null && break; sleep 1; done
fi

# --reset: wipe a previous/failed/wrong-version MongoDB install for a clean
# reinstall. DESTRUCTIVE — it deletes ALL MongoDB data in this CT. Needed e.g.
# to switch an already-installed 8.0 to 7.0 (apt won't downgrade in place), or to
# clear a half-finished install. Confirmed interactively; with --yes it proceeds.
if [ "${RESET}" = true ]; then
  if ask_active; then
    RESET_OK=false
    confirm RESET_OK "RESET will DELETE MongoDB and ALL its data in CT ${DB_ID}. Continue?"
    [ "${RESET_OK}" = true ] || { echo "Reset cancelled." >&2; exit 1; }
  fi
  echo ">>> Resetting MongoDB inside CT ${DB_ID} (purge packages + repo + keyring + data) ..."
  pct exec "${DB_ID}" -- bash -c '
    systemctl stop mongod 2>/dev/null || true
    export DEBIAN_FRONTEND=noninteractive
    apt-get -y purge "mongodb-org*" >/dev/null 2>&1 || true
    apt-get -y autoremove >/dev/null 2>&1 || true
    rm -f /etc/apt/sources.list.d/mongodb-org-*.list /usr/share/keyrings/mongodb-server-*.gpg
    rm -rf /var/lib/mongodb/* /var/log/mongodb/* /etc/mongod.conf
  '
fi

echo ">>> Pushing DB files into CT ${DB_ID} ..."
pct push "${DB_ID}" "${HERE}/setup-db.in-ct.sh"    /root/setup-db.in-ct.sh
pct push "${DB_ID}" "${HERE}/backup-mongo.sh"      /usr/local/bin/backup-mongo.sh
pct push "${DB_ID}" "${HERE}/mongo-backup.service" /etc/systemd/system/mongo-backup.service
pct push "${DB_ID}" "${HERE}/mongo-backup.timer"   /etc/systemd/system/mongo-backup.timer

echo ">>> Installing + hardening MongoDB inside CT ${DB_ID} ..."
# Secrets + the bind IP / db name go via env — never written into the kit's files.
pct exec "${DB_ID}" -- env \
  DB_BIND_IP="${DB_BIND_IP}" \
  APP_DB_USER="${APP_DB_USER}" \
  APP_DB_NAME="${APP_DB_NAME}" \
  MONGO_MAJOR="${MONGO_MAJOR}" \
  APP_DB_PASS="${APP_DB_PASS}" \
  ADMIN_DB_PASS="${ADMIN_DB_PASS}" \
  bash /root/setup-db.in-ct.sh

echo ">>> Writing the backup credentials (root-only env file the timer reads) ..."
# backup-mongo.sh runs LATER via the timer, so it can't take env at deploy time.
# Put its credentials in /etc/openpoll/mongo-backup.env (root 600); the service's
# EnvironmentFile loads them. The kit's backup-mongo.sh stays secret-free.
pct exec "${DB_ID}" -- mkdir -p /etc/openpoll
pct exec "${DB_ID}" -- chmod 700 /etc/openpoll
# Build the env file on the node (xtrace off so the password can't leak), push it,
# then lock it down. printf via a heredoc-free here-string keeps it one write.
_ENVTMP="$(mktemp)"; trap 'rm -f "${_ENVTMP}"' EXIT
( set +x
  {
    printf 'APP_DB_USER=%s\n' "${APP_DB_USER}"
    printf 'APP_DB_NAME=%s\n' "${APP_DB_NAME}"
    printf 'APP_DB_PASS=%s\n' "${APP_DB_PASS}"
  } > "${_ENVTMP}" )
pct push "${DB_ID}" "${_ENVTMP}" /etc/openpoll/mongo-backup.env
pct exec "${DB_ID}" -- chmod 600 /etc/openpoll/mongo-backup.env

echo ">>> Enabling the daily backup timer ..."
pct exec "${DB_ID}" -- chmod +x /usr/local/bin/backup-mongo.sh
pct exec "${DB_ID}" -- systemctl daemon-reload
pct exec "${DB_ID}" -- systemctl enable --now mongo-backup.timer

echo
echo "DB container ${DB_ID} is set up. Quick check:"
echo "  pct exec ${DB_ID} -- systemctl is-active mongod"
echo
echo "For a SECOND independent instance (e.g. a 'dev' app) sharing this DB CT,"
echo "create another database + user without reinstalling MongoDB — see db/create-app-user.js."
