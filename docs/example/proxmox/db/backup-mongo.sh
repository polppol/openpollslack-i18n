#!/usr/bin/env bash
#
# Logical backup of the application database (mongodump) with rotation.
# Runs inside the DB container, driven by mongo-backup.timer (see below).
#
# Ceph already keeps multiple copies of your data against HARDWARE failure.
# This protects against the other kind: an accidental delete, a bad migration,
# or "I need yesterday's data back". Keep BOTH.
#
# You normally do NOT install this by hand: db/deploy-db-to-ct.sh (run on the
# Proxmox node) pushes this + the systemd units into the DB CT, writes the
# credentials to /etc/openpoll/mongo-backup.env (root 600, loaded by the service
# via EnvironmentFile), chmods it, and enables the timer.
# Manual fallback (inside the DB CT): copy this to /usr/local/bin/, the .service +
# .timer to /etc/systemd/system/, create /etc/openpoll/mongo-backup.env with the
# APP_DB_* values (or edit the defaults below), chmod +x, then
# `systemctl daemon-reload && systemctl enable --now mongo-backup.timer`.
set -euo pipefail

# ── Safety: runs INSIDE the DB container, not on a Proxmox node. ─────────────
# (Normally invoked by mongo-backup.timer inside the CT.) Bail out on a host.
if [ -d /etc/pve ] || command -v pct >/dev/null 2>&1 || command -v pveversion >/dev/null 2>&1; then
  echo "ERROR: this looks like a Proxmox HOST, not the DB container." >&2
  exit 1
fi

# ─────────────────────────── settings to review ────────────────────────────
# Each honors an env override (the systemd service supplies APP_DB_* from
# /etc/openpoll/mongo-backup.env). The value after :- is the manual default.
APP_DB_USER="${APP_DB_USER:-openpoll}"
APP_DB_NAME="${APP_DB_NAME:-open_poll}"
APP_DB_PASS="${APP_DB_PASS:-REPLACE_WITH_APP_DB_PASSWORD}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/mongo}"
KEEP="${KEEP:-14}"                            # keep the newest N dumps
# ────────────────────────────────────────────────────────────────────────────

if [ "${APP_DB_PASS}" = "REPLACE_WITH_APP_DB_PASSWORD" ] || [ -z "${APP_DB_PASS}" ]; then
  echo "ERROR: APP_DB_PASS is not set — write /etc/openpoll/mongo-backup.env (the deploy" >&2
  echo "       wrapper does this), or edit APP_DB_PASS at the top of this script." >&2
  exit 1
fi

mkdir -p "${BACKUP_DIR}"
STAMP="$(date +%F_%H%M)"
ARCHIVE="${BACKUP_DIR}/${APP_DB_NAME}_${STAMP}.archive.gz"

# NOTE: the password is in this command's argv, so it is visible via `ps` to
# any local user during the dump. The DB container is single-tenant (only this
# app + root), so that's acceptable here — don't add other users to this CT.
mongodump \
  --uri="mongodb://${APP_DB_USER}:${APP_DB_PASS}@127.0.0.1:27017/${APP_DB_NAME}?authSource=${APP_DB_NAME}" \
  --archive="${ARCHIVE}" --gzip

# Rotate: delete everything older than the newest ${KEEP} for THIS database.
ls -1t "${BACKUP_DIR}/${APP_DB_NAME}"_*.archive.gz 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -f

echo "Backup written: ${ARCHIVE}"
# Tip: copy these off-box too (Proxmox Backup Server, or rsync to a NAS).
