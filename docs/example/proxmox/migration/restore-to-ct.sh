#!/usr/bin/env bash
#
# Restore a mongodump archive into the new DB container.
# Run INSIDE the DB container, after copying the archive over.
#
#   # from a Proxmox node, push the dump into the container:
#   pct push <DB CT ID> open_poll_2026-06-17_1200.archive.gz /root/dump.archive.gz
#   pct push <DB CT ID> migration/restore-to-ct.sh /root/restore-to-ct.sh
#   pct enter <DB CT ID>
#   # set the password below (or pass APP_DB_PASS=... as env), then:
#   bash /root/restore-to-ct.sh /root/dump.archive.gz
#
# --drop replaces the existing collections, so it is safe to run again for the
# final "catch-up" sync during cutover.
set -euo pipefail

# ── Safety: run INSIDE the DB container, NOT on a Proxmox node. ──────────────
if [ -d /etc/pve ] || command -v pct >/dev/null 2>&1 || command -v pveversion >/dev/null 2>&1; then
  echo "ERROR: this looks like a Proxmox HOST, not the DB container." >&2
  echo "       Run it inside the CT:  pct enter <DB CT ID>   then  bash restore-to-ct.sh <archive>" >&2
  exit 1
fi

# ─────────────────────────── settings to review ────────────────────────────
# Each honors an env override. Set APP_DB_NAME to restore into a specific
# instance's database (e.g. open_poll_dev).
APP_DB_USER="${APP_DB_USER:-openpoll}"
APP_DB_NAME="${APP_DB_NAME:-open_poll}"
APP_DB_PASS="${APP_DB_PASS:-REPLACE_WITH_APP_DB_PASSWORD}"
# ────────────────────────────────────────────────────────────────────────────

if [ "${APP_DB_PASS}" = "REPLACE_WITH_APP_DB_PASSWORD" ] || [ -z "${APP_DB_PASS}" ]; then
  echo "ERROR: set APP_DB_PASS (edit it above, or pass it as env) first." >&2
  exit 1
fi

ARCHIVE="${1:-}"
if [ -z "${ARCHIVE}" ] || [ ! -f "${ARCHIVE}" ]; then
  echo "Usage: bash restore-to-ct.sh <path-to.archive.gz>" >&2
  exit 1
fi

mongorestore \
  --uri="mongodb://${APP_DB_USER}:${APP_DB_PASS}@127.0.0.1:27017/${APP_DB_NAME}?authSource=${APP_DB_NAME}" \
  --archive="${ARCHIVE}" --gzip --drop

echo
echo "Restore complete. Verify the key collections came across:"
echo "  mongosh \"mongodb://${APP_DB_USER}:<password>@127.0.0.1:27017/${APP_DB_NAME}?authSource=${APP_DB_NAME}\" \\"
echo "    --eval 'print(db.getCollectionNames()); print(\"workspaces:\", db.token.countDocuments()); print(\"polls:\", db.poll_data.countDocuments());'"
