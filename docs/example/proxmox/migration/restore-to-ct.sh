#!/usr/bin/env bash
#
# Restore a mongodump archive into the new DB container.
# Run INSIDE the DB container, after copying the archive over.
#
#   # from a Proxmox node, push the dump into the container:
#   pct push 5010 open_poll_2026-06-17_1200.archive.gz /root/dump.archive.gz
#   pct push 5010 migration/restore-to-ct.sh /root/restore-to-ct.sh
#   pct enter 5010
#   # edit the password below, then:
#   bash /root/restore-to-ct.sh /root/dump.archive.gz
#
# --drop replaces the existing collections, so it is safe to run again for the
# final "catch-up" sync during cutover.
set -euo pipefail

# ── Safety: run INSIDE the DB container (CT 5010), NOT on a Proxmox node. ─────
if [ -d /etc/pve ] || command -v pct >/dev/null 2>&1 || command -v pveversion >/dev/null 2>&1; then
  echo "ERROR: this looks like a Proxmox HOST, not the DB container (CT 5010)." >&2
  echo "       Run it inside the CT:  pct enter 5010   then  bash restore-to-ct.sh <archive>" >&2
  exit 1
fi

# ─────────────────────────── settings to review ────────────────────────────
APP_DB_USER="openpoll"
APP_DB_PASS="REPLACE_WITH_APP_DB_PASSWORD"
# ────────────────────────────────────────────────────────────────────────────

ARCHIVE="${1:-}"
if [ -z "${ARCHIVE}" ] || [ ! -f "${ARCHIVE}" ]; then
  echo "Usage: bash restore-to-ct.sh <path-to.archive.gz>" >&2
  exit 1
fi

mongorestore \
  --uri="mongodb://${APP_DB_USER}:${APP_DB_PASS}@127.0.0.1:27017/open_poll?authSource=open_poll" \
  --archive="${ARCHIVE}" --gzip --drop

echo
echo "Restore complete. Verify the key collections came across:"
echo "  mongosh \"mongodb://${APP_DB_USER}:<password>@127.0.0.1:27017/open_poll?authSource=open_poll\" \\"
echo "    --eval 'print(db.getCollectionNames()); print(\"workspaces:\", db.token.countDocuments()); print(\"polls:\", db.poll_data.countDocuments());'"
