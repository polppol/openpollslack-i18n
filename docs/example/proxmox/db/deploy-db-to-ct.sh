#!/usr/bin/env bash
#
# Deploy the DB container FROM A PROXMOX NODE — one command sets up the whole CT.
# It pushes the in-CT setup + backup files into CT 5010 and runs them there via
# `pct push` + `pct exec`. You run THIS on the node; it installs nothing on the
# node itself (the actual install happens inside the container).
#
#   1. bash proxmox/create-containers.sh        # create the CTs (run first)
#   2. edit db/setup-db.in-ct.sh AND db/backup-mongo.sh   # set the passwords
#   3. bash db/deploy-db-to-ct.sh               # <- this script
set -euo pipefail

DB_ID=5010
HERE="$(cd "$(dirname "$0")" && pwd)"   # the db/ folder of this kit

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

# Fail fast if passwords weren't edited (mirrors the in-CT guard; also catches a
# forgotten backup-mongo.sh password that would otherwise fail silently at 03:30).
for _f in setup-db.in-ct.sh backup-mongo.sh; do
  if grep -q "REPLACE_WITH" "${HERE}/${_f}"; then
    echo "ERROR: ${HERE}/${_f} still has REPLACE_WITH placeholders — set the passwords first." >&2
    exit 1
  fi
done

echo ">>> Pushing DB files into CT ${DB_ID} ..."
pct push "${DB_ID}" "${HERE}/setup-db.in-ct.sh"    /root/setup-db.in-ct.sh
pct push "${DB_ID}" "${HERE}/backup-mongo.sh"      /usr/local/bin/backup-mongo.sh
pct push "${DB_ID}" "${HERE}/mongo-backup.service" /etc/systemd/system/mongo-backup.service
pct push "${DB_ID}" "${HERE}/mongo-backup.timer"   /etc/systemd/system/mongo-backup.timer

echo ">>> Installing + hardening MongoDB inside CT ${DB_ID} ..."
pct exec "${DB_ID}" -- bash /root/setup-db.in-ct.sh

echo ">>> Enabling the daily backup timer ..."
pct exec "${DB_ID}" -- chmod +x /usr/local/bin/backup-mongo.sh
pct exec "${DB_ID}" -- systemctl daemon-reload
pct exec "${DB_ID}" -- systemctl enable --now mongo-backup.timer

echo
echo "DB container ${DB_ID} is set up. Quick check:"
echo "  pct exec ${DB_ID} -- systemctl is-active mongod"
