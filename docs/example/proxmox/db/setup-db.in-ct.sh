#!/usr/bin/env bash
#
# Install and harden MongoDB. This runs INSIDE the DB container (CT 5010) —
# you normally do NOT run it by hand. Edit the passwords below, then on the
# Proxmox node run  db/deploy-db-to-ct.sh , which pushes this script in and runs
# it for you. (To run it manually anyway: pct enter 5010, then bash this file.)
#
# It installs MongoDB from the official repo, writes a hardened /etc/mongod.conf
# (auth on, bound to loopback + this container's IP only), and creates an admin
# user plus an "openpoll" application user scoped to the open_poll database.
set -euo pipefail

# ── Safety: run INSIDE the DB container (CT 5010), NOT on a Proxmox node. ─────
# This installs MongoDB and rewrites /etc/mongod.conf; on a node that would
# pollute the hypervisor. A Proxmox host has /etc/pve + pct/pveversion; a
# container does not — so bail out if we detect a host.
if [ -d /etc/pve ] || command -v pct >/dev/null 2>&1 || command -v pveversion >/dev/null 2>&1; then
  echo "ERROR: this looks like a Proxmox HOST, not the DB container (CT 5010)." >&2
  echo "       Run it inside the CT:  pct enter 5010   then  bash setup-db.in-ct.sh" >&2
  exit 1
fi

# ─────────────────────────── settings to review ────────────────────────────
DB_BIND_IP="10.100.51.42"                       # THIS container's internal IP
APP_DB_USER="openpoll"
APP_DB_PASS="REPLACE_WITH_APP_DB_PASSWORD"    # must match mongo_url in the app config
ADMIN_DB_PASS="REPLACE_WITH_ADMIN_PASSWORD"   # for the root/admin account
MONGO_MAJOR="8.0"                             # MongoDB 8.0 (needs a CPU with AVX)
# MongoDB's APT repo codename — matches the container OS (Debian 12 = "bookworm"),
# which MongoDB 8.0 fully supports (server + tools), so there is no cross-distro
# trick here. We stay on Debian 12 because (checked 2026-06) MongoDB 8.0's Debian
# 13 "trixie" repo ships only mongosh, not the server. To move to Debian 13 later,
# switch BOTH the CT template (create-containers.sh) and this to "trixie" once:
#   curl -s https://repo.mongodb.org/apt/debian/dists/trixie/mongodb-org/8.0/main/binary-amd64/Packages | grep -c '^Package: mongodb-org-server$'
# returns 1 (it is 0 today).
MONGO_DEB_CODENAME="bookworm"
CACHE_GB="1.5"                                # WiredTiger = 50% of (CT RAM - 1GB); 4GB CT -> 1.5
MONGO_LOG_KEEP_DAYS=360                        # days of /var/log/mongodb/mongod.log to keep (logrotate)
# ────────────────────────────────────────────────────────────────────────────

if [ "${APP_DB_PASS}" = "REPLACE_WITH_APP_DB_PASSWORD" ] || [ "${ADMIN_DB_PASS}" = "REPLACE_WITH_ADMIN_PASSWORD" ]; then
  echo "ERROR: edit APP_DB_PASS and ADMIN_DB_PASS at the top of this script first." >&2
  exit 1
fi

# MongoDB 5.0+ (incl. 8.0) requires a CPU with AVX support; without it mongod
# dies on start with an illegal-instruction error. An LXC sees the host CPU
# flags directly (there is NO Proxmox "CPU type" to pick for a container), so
# this check is accurate. AVX first appears at the x86-64-v3 level — x86-64-v2
# and -v2-AES do NOT include it; if you ever run the DB as a VM instead, set its
# CPU type to x86-64-v3 (or "host"), not v2-AES. Fail fast rather than crash.
if ! grep -qw avx /proc/cpuinfo; then
  echo "ERROR: this CPU does not expose AVX; MongoDB ${MONGO_MAJOR} will not start." >&2
  echo "       Run this container on an AVX-capable node, or pin MONGO_MAJOR to" >&2
  echo "       4.4 (the last release without the AVX requirement)." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y gnupg curl

# --- MongoDB official APT repository -----------------------------------------
curl -fsSL "https://pgp.mongodb.com/server-${MONGO_MAJOR}.asc" \
  | gpg -o "/usr/share/keyrings/mongodb-server-${MONGO_MAJOR}.gpg" --dearmor
echo "deb [ signed-by=/usr/share/keyrings/mongodb-server-${MONGO_MAJOR}.gpg ] http://repo.mongodb.org/apt/debian ${MONGO_DEB_CODENAME}/mongodb-org/${MONGO_MAJOR} main" \
  > "/etc/apt/sources.list.d/mongodb-org-${MONGO_MAJOR}.list"
apt-get update
apt-get install -y mongodb-org logrotate

# --- Hardened configuration -------------------------------------------------
cat > /etc/mongod.conf <<EOF
# Managed by setup-db.in-ct.sh — see docs/example/proxmox/db/mongod.conf for notes.
storage:
  dbPath: /var/lib/mongodb
  wiredTiger:
    engineConfig:
      # In an LXC, Mongo can mis-read the host's RAM. Pin the cache so it does
      # not over-allocate — MongoDB's default: 50% of (this CT's RAM - 1 GB).
      cacheSizeGB: ${CACHE_GB}
systemLog:
  destination: file
  logAppend: true
  path: /var/log/mongodb/mongod.log
net:
  port: 27017
  # Loopback (for local admin) + this container's internal IP (for the app CT).
  # NEVER bind 0.0.0.0 — keep 27017 off the public internet.
  bindIp: 127.0.0.1,${DB_BIND_IP}
security:
  authorization: enabled
processManagement:
  timeZoneInfo: /usr/share/zoneinfo
EOF

# --- Log rotation for mongod.log (mongod does NOT rotate it on its own) ------
# Daily, keep MONGO_LOG_KEEP_DAYS days, compress. copytruncate avoids having to
# signal mongod — fine for low-traffic logs. Debian runs logrotate daily, so
# this is hands-off once written.
cat > /etc/logrotate.d/mongod <<EOF
/var/log/mongodb/mongod.log {
    daily
    rotate ${MONGO_LOG_KEEP_DAYS}
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
    su mongodb mongodb
}
EOF

systemctl enable mongod
systemctl restart mongod

# Wait for mongod to accept connections instead of a fixed sleep. `ping` is
# allowed before any user exists, so this works with auth already enabled.
echo "Waiting for mongod to accept connections..."
for _i in $(seq 1 30); do
  if mongosh --quiet "mongodb://127.0.0.1:27017/admin" --eval 'db.runCommand({ping:1})' >/dev/null 2>&1; then
    break
  fi
  if [ "${_i}" -eq 30 ]; then
    echo "ERROR: mongod did not become ready within 30s. Check: journalctl -u mongod" >&2
    exit 1
  fi
  sleep 1
done

# --- Create users via the localhost exception -------------------------------
# With auth enabled and zero users, MongoDB lets the FIRST user be created over
# loopback; we then authenticate as admin to create the app user. Secrets are
# passed via env (NOT interpolated into the JS) so a quote/space in a password
# can't break the script, and quit(1) makes ANY failure abort under `set -e`
# instead of printing a false "success" banner.
MONGO_ADMIN_PASS="${ADMIN_DB_PASS}" \
MONGO_APP_USER="${APP_DB_USER}" \
MONGO_APP_PASS="${APP_DB_PASS}" \
mongosh --quiet "mongodb://127.0.0.1:27017/admin" <<'EOF'
try {
  const adminPass = process.env.MONGO_ADMIN_PASS;
  const appUser   = process.env.MONGO_APP_USER;
  const appPass   = process.env.MONGO_APP_PASS;
  db.createUser({ user: 'admin', pwd: adminPass, roles: [{ role: 'root', db: 'admin' }] });
  if (!db.auth('admin', adminPass)) { throw new Error('admin auth failed after createUser'); }
  db.getSiblingDB('open_poll').createUser({
    user: appUser, pwd: appPass, roles: [{ role: 'readWrite', db: 'open_poll' }],
  });
  if (!db.getSiblingDB('open_poll').getUser(appUser)) {
    throw new Error('app user missing after creation');
  }
  print('OK: created admin and ' + appUser);
} catch (e) {
  print('FATAL: user creation failed: ' + e);
  quit(1);
}
EOF

echo
echo "MongoDB ${MONGO_MAJOR} is installed, hardened and running."
echo "App connection string (put this in the app's config/default.json):"
echo "  mongodb://${APP_DB_USER}:<password>@${DB_BIND_IP}:27017/open_poll?authSource=open_poll"
echo
echo "Quick test:"
echo "  mongosh \"mongodb://${APP_DB_USER}:<password>@127.0.0.1:27017/open_poll?authSource=open_poll\" --eval 'db.runCommand({ping:1})'"
