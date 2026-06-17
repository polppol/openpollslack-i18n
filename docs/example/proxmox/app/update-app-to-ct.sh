#!/usr/bin/env bash
#
# Update an App container to a new version FROM A PROXMOX NODE. Takes a
# pre-update Ceph snapshot (instant rollback), then pushes + runs
# update-app.in-ct.sh, which git-pulls/checks-out the ref, re-syncs deps, fixes
# ownership, restarts the service and waits for a healthy start. You run THIS on
# the node. Works for both bundled and app-only CTs (it only touches the app).
#
#   bash app/update-app-to-ct.sh                 # prompts; pull latest of current branch
#   APP_REF=4.1.1.1 bash app/update-app-to-ct.sh # deploy a specific release tag
#
# Roll back instantly if a release misbehaves:  pct rollback <APP_ID> pre-update
#
# Prompts for the settings below (Enter keeps the default). NONINTERACTIVE=1 /
# --yes accepts all defaults.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"   # the app/ folder of this kit
_p="${HERE}/../lib/ask.sh"
[ -r "${_p}" ] || { echo "ERROR: missing ${_p}" >&2; exit 1; }
. "${_p}"

# ─────────────────────────── settings to review ────────────────────────────
APP_ID=5000                                  # the App CT to update
APP_PORT=5000                                # the port the app listens on (must match default.json)
APP_REF="${APP_REF:-}"                       # tag/branch to deploy; empty = pull current branch
SNAPSHOT=true                                # take a pre-update snapshot first (rollback safety)
SNAPSHOT_NAME=pre-update
# ────────────────────────────────────────────────────────────────────────────

for _arg in "$@"; do
  case "$(printf '%s' "${_arg}" | tr '[:upper:]' '[:lower:]')" in
    -y|--yes)       NONINTERACTIVE=1 ;;
    --no-snapshot)  SNAPSHOT=false ;;
    *) echo "ERROR: unknown argument '${_arg}' (supported: --no-snapshot, --yes)" >&2; exit 1 ;;
  esac
done
export NONINTERACTIVE

ask_active || echo ">>> non-interactive: keeping defaults (App CT ${APP_ID}, ref '${APP_REF:-current branch}', snapshot=${SNAPSHOT})." >&2
ask     APP_ID   "App CT id to update"
ask     APP_PORT "App listen port (matches default.json)"
ask     APP_REF  "Version to deploy — tag/branch (blank = pull current branch)"
confirm SNAPSHOT "Take a pre-update snapshot first (instant rollback)?"

command -v pct >/dev/null 2>&1 || {
  echo "ERROR: 'pct' not found — run this ON a Proxmox node, not inside a CT." >&2; exit 1; }
pct status "${APP_ID}" >/dev/null 2>&1 || {
  echo "ERROR: CT ${APP_ID} not found." >&2; exit 1; }
if ! pct exec "${APP_ID}" -- true 2>/dev/null; then
  echo ">>> Starting CT ${APP_ID} ..."; pct start "${APP_ID}"
  for _i in $(seq 1 30); do pct exec "${APP_ID}" -- true 2>/dev/null && break; sleep 1; done
fi

if [ "${SNAPSHOT}" = true ]; then
  # Replace any previous pre-update snapshot so the rollback point is the latest.
  if pct listsnapshot "${APP_ID}" 2>/dev/null | grep -qw "${SNAPSHOT_NAME}"; then
    echo ">>> Removing previous '${SNAPSHOT_NAME}' snapshot ..."
    pct delsnapshot "${APP_ID}" "${SNAPSHOT_NAME}"
  fi
  echo ">>> Snapshotting CT ${APP_ID} as '${SNAPSHOT_NAME}' ..."
  if ! pct snapshot "${APP_ID}" "${SNAPSHOT_NAME}"; then
    echo "ERROR: snapshot failed (storage may not support snapshots). Fix it, or" >&2
    echo "       re-run with --no-snapshot to update without a rollback point." >&2
    exit 1
  fi
  echo "    roll back with:  pct rollback ${APP_ID} ${SNAPSHOT_NAME}"
fi

echo ">>> Updating the app inside CT ${APP_ID} ..."
pct push "${APP_ID}" "${HERE}/update-app.in-ct.sh" /root/update-app.in-ct.sh
if ! pct exec "${APP_ID}" -- env APP_REF="${APP_REF}" APP_PORT="${APP_PORT}" bash /root/update-app.in-ct.sh; then
  echo "ERROR: the update did not finish healthily inside CT ${APP_ID}." >&2
  [ "${SNAPSHOT}" = true ] && echo "       roll back with:  pct rollback ${APP_ID} ${SNAPSHOT_NAME}" >&2
  echo "       inspect:  pct exec ${APP_ID} -- journalctl -u openpoll -n 50 --no-pager" >&2
  exit 1
fi

echo
echo "App container ${APP_ID} updated. Check:"
echo "  pct exec ${APP_ID} -- journalctl -u openpoll -n 30 --no-pager   # expect 'Bolt app is running!'"
[ "${SNAPSHOT}" = true ] && echo "  roll back if needed:  pct rollback ${APP_ID} ${SNAPSHOT_NAME}"
echo
echo "Note: if a release bumped the Node MAJOR version, re-run app/deploy-app-to-ct.sh"
echo "(or the Node install step in app/setup-app.in-ct.sh) first, then update again."
