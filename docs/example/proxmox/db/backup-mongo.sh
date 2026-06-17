#!/usr/bin/env bash
#
# Logical backup of the open_poll database (mongodump) with rotation.
# Runs inside the DB container, driven by mongo-backup.timer (see below).
#
# Ceph already keeps multiple copies of your data against HARDWARE failure.
# This protects against the other kind: an accidental delete, a bad migration,
# or "I need yesterday's data back". Keep BOTH.
#
# You normally do NOT install this by hand: db/deploy-db-to-ct.sh (run on the
# Proxmox node) pushes this + the systemd units into CT 5010, chmods it, and
# enables the timer. Just set the password below before running the wrapper.
# Manual fallback (inside CT 5010): copy this to /usr/local/bin/, the .service +
# .timer to /etc/systemd/system/, chmod +x, then
# `systemctl daemon-reload && systemctl enable --now mongo-backup.timer`.
set -euo pipefail

# ── Safety: runs INSIDE the DB container (CT 5010), not on a Proxmox node. ────
# (Normally invoked by mongo-backup.timer inside the CT.) Bail out on a host.
if [ -d /etc/pve ] || command -v pct >/dev/null 2>&1 || command -v pveversion >/dev/null 2>&1; then
  echo "ERROR: this looks like a Proxmox HOST, not the DB container (CT 5010)." >&2
  exit 1
fi

# ─────────────────────────── settings to review ────────────────────────────
APP_DB_USER="openpoll"
APP_DB_PASS="REPLACE_WITH_APP_DB_PASSWORD"
BACKUP_DIR="/var/backups/mongo"
KEEP=14                                   # keep the newest N dumps
# ────────────────────────────────────────────────────────────────────────────

if [ "${APP_DB_PASS}" = "REPLACE_WITH_APP_DB_PASSWORD" ]; then
  echo "ERROR: edit APP_DB_PASS at the top of this script first." >&2
  exit 1
fi

mkdir -p "${BACKUP_DIR}"
STAMP="$(date +%F_%H%M)"
ARCHIVE="${BACKUP_DIR}/open_poll_${STAMP}.archive.gz"

# NOTE: the password is in this command's argv, so it is visible via `ps` to
# any local user during the dump. The DB container is single-tenant (only this
# app + root), so that's acceptable here — don't add other users to this CT.
mongodump \
  --uri="mongodb://${APP_DB_USER}:${APP_DB_PASS}@127.0.0.1:27017/open_poll?authSource=open_poll" \
  --archive="${ARCHIVE}" --gzip

# Rotate: delete everything older than the newest ${KEEP}.
ls -1t "${BACKUP_DIR}"/open_poll_*.archive.gz 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -f

echo "Backup written: ${ARCHIVE}"
# Tip: copy these off-box too (Proxmox Backup Server, or rsync to a NAS).
