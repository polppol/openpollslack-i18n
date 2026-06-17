#!/usr/bin/env bash
#
# Create the LXC containers for Open Poll Plus on a Proxmox + Ceph cluster.
# Run this on any node of the cluster (it talks to the cluster, not a single node).
#
#   bash create-containers.sh
#
# Always creates a DB CT + an App CT. Optionally also creates a standalone
# reverse-proxy CT (the SPLIT topology — one rproxy fronting several app CTs).
# To add MORE app instances later, re-run this with a different App id / host /
# IP (existing CTs are skipped; a duplicate IP is rejected).
#
# Prompts for every setting below (Enter keeps the shown default). Run
# non-interactively (keep all defaults) with NONINTERACTIVE=1 or --yes.
#
# IMPORTANT: the root filesystem MUST live on SHARED storage (your Ceph RBD
# pool). That is what lets Proxmox HA restart a container on another node and
# what lets you live/restart-migrate it for maintenance. A container on local
# storage CANNOT be made highly available.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"   # the proxmox/ folder of this kit
_p="${HERE}/../lib/ask.sh"
[ -r "${_p}" ] || { echo "ERROR: missing ${_p}" >&2; exit 1; }
. "${_p}"

# ─────────────────────────── settings to review ────────────────────────────
# Your Ceph RBD storage name. Find it with:  pvesm status   (Type "rbd")
CT_STORAGE="ceph-ct"

# A Debian 12 (bookworm) template on your template storage ("fs" here; run
# `pvesm status` and use the storage that holds CT templates / vztmpl content).
# Debian 12 is the lowest-friction base: MongoDB still has no native Debian 13
# ("trixie") SERVER package (re-checked 2026-06 — trixie ships only mongosh, for
# both 7.0 and 8.0; see db/setup-db.in-ct.sh). Debian 13 also works IF the DB CT
# keeps MONGO_DEB_CODENAME=bookworm (those packages run on trixie); Node + Caddy
# publish for Debian 13 too. Download the latest 12.x with:
#   pveam available | grep debian-12
#   pveam download fs debian-12-standard_12.12-1_amd64.tar.zst
TEMPLATE="fs:vztmpl/debian-12-standard_12.12-1_amd64.tar.zst"

BRIDGE="vmbr0"           # must be an actual bridge (vmbrN), NOT a VLAN subif (e.g. vmbr1.51)
# VLAN tag for the container NIC. THIS EXAMPLE ASSUMES you want the CTs on VLAN
# 51 (VLAN_TAG=51 below). For untagged (the bridge's native VLAN) edit this to ""
# in the file. A tag also needs the bridge to be VLAN-aware ONCE per node (in
# /etc/network/interfaces: `bridge-vlan-aware yes` + `bridge-vids 2-4094`);
# Proxmox then tags the container's port automatically.
VLAN_TAG=51
GATEWAY="10.100.51.254"       # your gateway
NAMESERVER="10.100.51.254"    # your DNS server

# App container
APP_ID=5000
APP_HOST="openpoll-app"
APP_IP="10.100.51.41/24"
APP_CORES=2
APP_RAM=2048             # MB
APP_DISK=16              # GB

# Database container
DB_ID=5010
DB_HOST="openpoll-db"
DB_IP="10.100.51.42/24"
DB_CORES=2
DB_RAM=4096              # MB  (MongoDB likes RAM for its working set)
DB_DISK=32               # GB

# Reverse-proxy container (SPLIT topology) — created only if CREATE_RPROXY=true.
# Small: it just runs Caddy. Fronts several app CTs by /node/<port>/ path.
CREATE_RPROXY=false
RPROXY_ID=5030
RPROXY_HOST="openpoll-rproxy"
RPROXY_IP="10.100.51.40/24"
RPROXY_CORES=1
RPROXY_RAM=512           # MB
RPROXY_DISK=8            # GB
# ────────────────────────────────────────────────────────────────────────────

for _arg in "$@"; do
  case "$(printf '%s' "${_arg}" | tr '[:upper:]' '[:lower:]')" in
    -y|--yes) NONINTERACTIVE=1 ;;
    *) echo "ERROR: unknown argument '${_arg}' (supported: --yes)" >&2; exit 1 ;;
  esac
done
export NONINTERACTIVE

ask_active || echo ">>> non-interactive: keeping all defaults (DB ${DB_ID}/${DB_IP}, App ${APP_ID}/${APP_IP}, rproxy=${CREATE_RPROXY})." >&2
# --- network / storage ---
ask CT_STORAGE "Ceph RBD storage name (pvesm status, Type rbd)"
ask TEMPLATE   "CT template (storage:vztmpl/...)"
ask BRIDGE     "Bridge (vmbrN)"
ask VLAN_TAG   "VLAN tag (blank-in-file for untagged)"
ask GATEWAY    "Gateway IP"
ask NAMESERVER "DNS server IP"
# --- DB CT ---
ask DB_ID    "DB CT id"
ask DB_HOST  "DB CT hostname"
ask DB_IP    "DB CT IP (CIDR, e.g. 10.100.51.42/24)"
ask DB_CORES "DB CT cores"
ask DB_RAM   "DB CT RAM (MB)"
ask DB_DISK  "DB CT disk (GB)"
# --- App CT ---
ask APP_ID    "App CT id"
ask APP_HOST  "App CT hostname"
ask APP_IP    "App CT IP (CIDR)"
ask APP_CORES "App CT cores"
ask APP_RAM   "App CT RAM (MB)"
ask APP_DISK  "App CT disk (GB)"
# --- optional reverse-proxy CT (split topology) ---
confirm CREATE_RPROXY "Also create a standalone reverse-proxy CT (split topology)?"
if [ "${CREATE_RPROXY}" = true ]; then
  ask RPROXY_ID    "Reverse-proxy CT id"
  ask RPROXY_HOST  "Reverse-proxy CT hostname"
  ask RPROXY_IP    "Reverse-proxy CT IP (CIDR)"
  ask RPROXY_CORES "Reverse-proxy CT cores"
  ask RPROXY_RAM   "Reverse-proxy CT RAM (MB)"
  ask RPROXY_DISK  "Reverse-proxy CT disk (GB)"
fi

command -v pct >/dev/null 2>&1 || {
  echo "ERROR: 'pct' not found — run this ON a Proxmox node." >&2; exit 1; }

# Optional VLAN tag fragment for --net0 (omitted entirely when VLAN_TAG is "").
# The `if` form is safe under `set -e` (a bare `&&` test would abort when empty).
TAG_OPT=""
if [ -n "${VLAN_TAG}" ]; then
  TAG_OPT=",tag=${VLAN_TAG}"
fi

# Print the CT id (if any) OTHER than $2 that already uses IP $1 — guards a
# re-run that changes the id but forgets to change the IP (a silent IP clash).
_ip_owner() {
  local _ip="${1%%/*}" _self="$2" _cid
  for _cid in $(pct list 2>/dev/null | awk 'NR>1{print $1}'); do
    [ "${_cid}" = "${_self}" ] && continue
    if pct config "${_cid}" 2>/dev/null | grep -qF "ip=${_ip}/"; then echo "${_cid}"; return 0; fi
  done
  return 1
}

# Create one CT (idempotent: skips an existing id; rejects a duplicate IP).
create_ct() {
  local _id="$1" _host="$2" _ip="$3" _cores="$4" _ram="$5" _disk="$6"
  if pct status "${_id}" >/dev/null 2>&1; then
    echo ">>> CT ${_id} (${_host}) already exists — skipping create."
    return 0
  fi
  local _owner; _owner="$(_ip_owner "${_ip}" "${_id}" || true)"
  if [ -n "${_owner}" ]; then
    echo "ERROR: IP ${_ip%%/*} is already used by CT ${_owner} — choose a different IP for CT ${_id}." >&2
    exit 1
  fi
  echo ">>> Creating CT ${_id} (${_host}) ${_ip} ..."
  pct create "${_id}" "${TEMPLATE}" \
    --hostname     "${_host}" \
    --cores        "${_cores}" \
    --memory       "${_ram}" \
    --swap         512 \
    --rootfs       "${CT_STORAGE}:${_disk}" \
    --net0         "name=eth0,bridge=${BRIDGE}${TAG_OPT},ip=${_ip},gw=${GATEWAY}" \
    --nameserver   "${NAMESERVER}" \
    --features     nesting=1 \
    --unprivileged 1 \
    --onboot       1 \
    --start        1
}

create_ct "${DB_ID}"  "${DB_HOST}"  "${DB_IP}"  "${DB_CORES}"  "${DB_RAM}"  "${DB_DISK}"
create_ct "${APP_ID}" "${APP_HOST}" "${APP_IP}" "${APP_CORES}" "${APP_RAM}" "${APP_DISK}"
if [ "${CREATE_RPROXY}" = true ]; then
  create_ct "${RPROXY_ID}" "${RPROXY_HOST}" "${RPROXY_IP}" "${RPROXY_CORES}" "${RPROXY_RAM}" "${RPROXY_DISK}"
fi

cat <<EOF

Done. Containers:
  - DB  : ${DB_ID}  ${DB_HOST}   ${DB_IP}
  - App : ${APP_ID}  ${APP_HOST}  ${APP_IP}
EOF
[ "${CREATE_RPROXY}" = true ] && echo "  - Rproxy: ${RPROXY_ID}  ${RPROXY_HOST}  ${RPROXY_IP}"
cat <<EOF

Enter a container from the host with:  pct enter ${DB_ID}    (or ${APP_ID})
Push a file into a container with:      pct push ${DB_ID} localfile /root/localfile

Next steps (see README.md) — all run on this node:
  1. Set up the DB container   -> bash db/deploy-db-to-ct.sh
  2. Set up the App container  -> bash app/deploy-app-to-ct.sh           # bundled (Caddy here)
                              (or bash app/deploy-app-to-ct.sh --app-only  # split, app only)
EOF
if [ "${CREATE_RPROXY}" = true ]; then
  echo "  3. Set up the reverse proxy -> bash rproxy/deploy-rproxy-to-ct.sh"
  echo "  4. Register all as HA        -> bash proxmox/ha-setup.sh"
else
  echo "  3. Register both as HA       -> bash proxmox/ha-setup.sh"
fi
echo
echo "To add another app instance later: re-run THIS script with a different App"
echo "id/host/IP (existing CTs are skipped; a clashing IP is rejected)."
