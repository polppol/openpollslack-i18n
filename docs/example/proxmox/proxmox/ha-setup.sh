#!/usr/bin/env bash
#
# Register the containers as Proxmox HA resources.
# Run on ANY node of the cluster, AFTER the containers exist and are working.
#
# What this gives you:
#   - If the node a container runs on dies, the HA manager fences it and
#     restarts the container on a surviving node (your "brief restart").
#   - For PLANNED maintenance you still migrate manually first (see README),
#     then patch the now-empty node.
#
# In the SPLIT topology, register the reverse-proxy CT too (it terminates TLS for
# every backend — its restart-on-node-failure is exactly what you want covered),
# plus EACH app CT in APP_IDS.
#
# Prompts for the ids below (Enter keeps the default). NONINTERACTIVE=1 / --yes
# keeps defaults. Re-running is safe — already-registered resources are skipped.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"   # the proxmox/ folder of this kit
_p="${HERE}/../lib/ask.sh"
[ -r "${_p}" ] || { echo "ERROR: missing ${_p}" >&2; exit 1; }
. "${_p}"

# ─────────────────────────── settings to review ────────────────────────────
DB_ID=5010                 # the DB CT id
APP_IDS="5000"             # space-separated list of app CT ids (e.g. "5000 5001" for split)
RPROXY_ID=""               # set to the reverse-proxy CT id in the split topology (blank = none)
# ────────────────────────────────────────────────────────────────────────────

for _arg in "$@"; do
  case "$(printf '%s' "${_arg}" | tr '[:upper:]' '[:lower:]')" in
    -y|--yes) NONINTERACTIVE=1 ;;
    *) echo "ERROR: unknown argument '${_arg}' (supported: --yes)" >&2; exit 1 ;;
  esac
done
export NONINTERACTIVE

ask_active || echo ">>> non-interactive: keeping defaults (DB ${DB_ID}, app(s) ${APP_IDS}, rproxy '${RPROXY_ID}')." >&2
ask DB_ID     "DB CT id"
ask APP_IDS   "App CT id(s), space-separated"
ask RPROXY_ID "Reverse-proxy CT id (blank if not using the split topology)"

command -v ha-manager >/dev/null 2>&1 || {
  echo "ERROR: 'ha-manager' not found — run this ON a Proxmox cluster node." >&2; exit 1; }

# Idempotent: ha-manager add errors if the resource already exists (and would
# abort under set -e), so skip ids that are already HA resources.
#   --state started : HA keeps the container running (restart/relocate on failure)
#   --max_restart   : restart attempts on the same node before relocating
#   --max_relocate  : relocate attempts to other nodes
ha_add() {
  local _id="$1"
  if ha-manager config 2>/dev/null | grep -q "^ct:${_id}$"; then
    echo ">>> ct:${_id} is already an HA resource — skipping."
    return 0
  fi
  echo ">>> Adding ct:${_id} ..."
  ha-manager add "ct:${_id}" --state started --max_restart 3 --max_relocate 3
}

ha_add "${DB_ID}"
for _id in ${APP_IDS}; do
  ha_add "${_id}"
done
if [ -n "${RPROXY_ID}" ]; then
  ha_add "${RPROXY_ID}"
fi

echo
echo "HA resources configured. Inspect with:"
echo "  ha-manager status"
echo "  ha-manager config"
