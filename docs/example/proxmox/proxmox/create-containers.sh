#!/usr/bin/env bash
#
# Create the two LXC containers for Open Poll Plus on a Proxmox + Ceph cluster.
# Run this ONCE, on any node of the cluster (it talks to the cluster, not a
# single node).
#
#   bash create-containers.sh
#
# IMPORTANT: the root filesystem MUST live on SHARED storage (your Ceph RBD
# pool). That is what lets Proxmox HA restart a container on another node and
# what lets you live/restart-migrate it for maintenance. A container on local
# storage CANNOT be made highly available.
set -euo pipefail

# ─────────────────────────── settings to review ────────────────────────────
# Your Ceph RBD storage name. Find it with:  pvesm status   (Type "rbd")
CT_STORAGE="ceph-ct"

# A Debian 12 (bookworm) template on your template storage ("fs" here; run
# `pvesm status` and use the storage that holds CT templates / vztmpl content).
# Debian 12 — not 13 — because MongoDB 8.0 has no usable Debian 13 server repo
# yet (see the note in db/setup-db.in-ct.sh). Download the latest 12.x with:
#   pveam available | grep debian-12
#   pveam download fs debian-12-standard_12.12-1_amd64.tar.zst
TEMPLATE="fs:vztmpl/debian-12-standard_12.12-1_amd64.tar.zst"

BRIDGE="vmbr0"           # must be an actual bridge (vmbrN), NOT a VLAN subif (e.g. vmbr1.51)
# VLAN tag for the container NIC. THIS EXAMPLE ASSUMES you want the CTs on VLAN
# 51 (VLAN_TAG=51 below). Leave "" for untagged (the bridge's native VLAN), or
# set your own VLAN id. A tag also needs the bridge to be VLAN-aware ONCE per
# node (in /etc/network/interfaces: `bridge-vlan-aware yes` + `bridge-vids
# 2-4094`); Proxmox then tags the container's port automatically.
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
# ────────────────────────────────────────────────────────────────────────────

# Optional VLAN tag fragment for --net0 (omitted entirely when VLAN_TAG is "").
# The `if` form is safe under `set -e` (a bare `&&` test would abort when empty).
TAG_OPT=""
if [ -n "${VLAN_TAG}" ]; then
  TAG_OPT=",tag=${VLAN_TAG}"
fi

echo ">>> Creating DB container ${DB_ID} (${DB_HOST}) ..."
# Guard so re-running after a partial failure doesn't abort on an existing CT.
pct status "${DB_ID}" >/dev/null 2>&1 || pct create "${DB_ID}" "${TEMPLATE}" \
  --hostname   "${DB_HOST}" \
  --cores      "${DB_CORES}" \
  --memory     "${DB_RAM}" \
  --swap       512 \
  --rootfs     "${CT_STORAGE}:${DB_DISK}" \
  --net0       "name=eth0,bridge=${BRIDGE}${TAG_OPT},ip=${DB_IP},gw=${GATEWAY}" \
  --nameserver "${NAMESERVER}" \
  --features   nesting=1 \
  --unprivileged 1 \
  --onboot     1 \
  --start      1

echo ">>> Creating App container ${APP_ID} (${APP_HOST}) ..."
pct status "${APP_ID}" >/dev/null 2>&1 || pct create "${APP_ID}" "${TEMPLATE}" \
  --hostname   "${APP_HOST}" \
  --cores      "${APP_CORES}" \
  --memory     "${APP_RAM}" \
  --swap       512 \
  --rootfs     "${CT_STORAGE}:${APP_DISK}" \
  --net0       "name=eth0,bridge=${BRIDGE}${TAG_OPT},ip=${APP_IP},gw=${GATEWAY}" \
  --nameserver "${NAMESERVER}" \
  --features   nesting=1 \
  --unprivileged 1 \
  --onboot     1 \
  --start      1

cat <<EOF

Done. Two containers are running:
  - DB  : ${DB_ID}  ${DB_HOST}   ${DB_IP}
  - App : ${APP_ID}  ${APP_HOST}  ${APP_IP}

Enter a container from the host with:  pct enter ${DB_ID}    (or ${APP_ID})
Push a file into a container with:      pct push ${DB_ID} localfile /root/localfile

Next steps (see README.md) — all run on this node:
  1. Set up the DB container  -> bash db/deploy-db-to-ct.sh
  2. Set up the App container -> bash app/deploy-app-to-ct.sh
  3. Register both as HA      -> bash proxmox/ha-setup.sh
EOF
