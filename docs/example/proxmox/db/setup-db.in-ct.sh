#!/usr/bin/env bash
#
# Install and harden MongoDB. This runs INSIDE the DB container — you normally do
# NOT run it by hand. On the Proxmox node run  db/deploy-db-to-ct.sh , which
# pushes this script in and runs it for you, passing the IP/passwords as env.
# (To run it manually: pct enter <DB CT ID>, set the values below or pass them as
#  env, then bash this file.)
#
# It installs MongoDB from the official repo, writes a hardened /etc/mongod.conf
# (auth on, bound to loopback + this container's IP only), and creates an admin
# user plus an application user scoped to its database.
#
# Each setting honors an env override (the deploy wrapper sets these); the value
# after :- is the default used when the env var is unset/empty.
set -euo pipefail

# ── Safety: run INSIDE the DB container, NOT on a Proxmox node. ──────────────
# This installs MongoDB and rewrites /etc/mongod.conf; on a node that would
# pollute the hypervisor. A Proxmox host has /etc/pve + pct/pveversion; a
# container does not — so bail out if we detect a host.
if [ -d /etc/pve ] || command -v pct >/dev/null 2>&1 || command -v pveversion >/dev/null 2>&1; then
  echo "ERROR: this looks like a Proxmox HOST, not the DB container." >&2
  echo "       Run it inside the CT:  pct enter <DB CT ID>   then  bash setup-db.in-ct.sh" >&2
  exit 1
fi

# ─────────────────────────── settings to review ────────────────────────────
DB_BIND_IP="${DB_BIND_IP:-10.100.51.42}"                  # THIS container's internal IP
APP_DB_USER="${APP_DB_USER:-openpoll}"
APP_DB_NAME="${APP_DB_NAME:-open_poll}"                    # the application database
APP_DB_PASS="${APP_DB_PASS:-REPLACE_WITH_APP_DB_PASSWORD}"   # must match mongo_url in the app config
ADMIN_DB_PASS="${ADMIN_DB_PASS:-REPLACE_WITH_ADMIN_PASSWORD}" # for the root/admin account
MONGO_MAJOR="${MONGO_MAJOR:-7.0}"                         # default 7.0: safe on ALL kernels (incl. >= 6.19).
                                                          # 8.0 crashes on kernel >= 6.19 (SERVER-121912; see
                                                          # the guard below). Either way MongoDB 5.0+ needs AVX.
# MongoDB's APT repo codename. Keep "bookworm" (Debian 12): re-checked 2026-06,
# MongoDB's "trixie" (Debian 13) repo still ships ONLY mongosh, NOT the server —
# for BOTH 7.0 and 8.0. So Debian 12 is the lowest-friction base (native repo).
# Debian 13 ALSO works today, but you must keep this codename "bookworm" — the
# bookworm server packages run fine on trixie. Switch this to "trixie" only once
# it actually carries a server package; check with:
#   curl -s https://repo.mongodb.org/apt/debian/dists/trixie/mongodb-org/8.0/main/binary-amd64/Packages | grep -c '^Package: mongodb-org-server$'
# (returns 1 when ready; it is 0 today).
MONGO_DEB_CODENAME="${MONGO_DEB_CODENAME:-bookworm}"
CACHE_GB="${CACHE_GB:-1.5}"                               # WiredTiger = 50% of (CT RAM - 1GB); 4GB CT -> 1.5
MONGO_LOG_KEEP_DAYS="${MONGO_LOG_KEEP_DAYS:-360}"          # days of /var/log/mongodb/mongod.log to keep (logrotate)
# ────────────────────────────────────────────────────────────────────────────

if [ "${APP_DB_PASS}" = "REPLACE_WITH_APP_DB_PASSWORD" ] || [ "${ADMIN_DB_PASS}" = "REPLACE_WITH_ADMIN_PASSWORD" ]; then
  echo "ERROR: set APP_DB_PASS and ADMIN_DB_PASS (answer the deploy prompts, pass them as env," >&2
  echo "       or edit the defaults at the top of this script) before running." >&2
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

# MongoDB 8.0+ bundles a TCMalloc that CRASHES on start on Linux kernel >= 6.19
# (MongoDB SERVER-121912). An LXC shares the HOST kernel, so this CT sees the
# Proxmox node's kernel — `uname -r` here is the host's. Fail fast with the fix
# rather than letting mongod crash-loop (the symptom: "MongoDB cannot start:
# Linux kernel versions 6.19 and newer has a known incompatibility ...").
# The fix stays INSIDE this CT: run MongoDB 7.0 (unaffected). We never touch the
# host (no kernel pinning, no node reboot) — that is out of this kit's scope.
if [[ "$(uname -r)" =~ ^([0-9]+)\.([0-9]+) ]]; then
  _kmaj="${BASH_REMATCH[1]}"; _kmin="${BASH_REMATCH[2]}"; _mmaj="${MONGO_MAJOR%%.*}"
  if [[ "${_mmaj}" =~ ^[0-9]+$ ]] && [ "${_mmaj}" -ge 8 ] \
     && { [ "${_kmaj}" -gt 6 ] || { [ "${_kmaj}" -eq 6 ] && [ "${_kmin}" -ge 19 ]; }; }; then
    echo "ERROR: MongoDB ${MONGO_MAJOR} crashes on start on Linux kernel $(uname -r)" >&2
    echo "       (>= 6.19; bundled-TCMalloc incompatibility, MongoDB SERVER-121912)." >&2
    echo "       FIX (entirely in this CT): use MongoDB 7.0, which is unaffected —" >&2
    echo "       re-run db/deploy-db-to-ct.sh and choose 7.0 at the prompt (or pass" >&2
    echo "       MONGO_MAJOR=7.0). Move back to 8.0 once SERVER-121912 is fixed." >&2
    exit 1
  fi
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y gnupg curl

# --- MongoDB official APT repository -----------------------------------------
curl -fsSL "https://pgp.mongodb.com/server-${MONGO_MAJOR}.asc" \
  | gpg --batch --yes -o "/usr/share/keyrings/mongodb-server-${MONGO_MAJOR}.gpg" --dearmor
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

# --- Create users (idempotent) ----------------------------------------------
# With auth enabled and zero users, MongoDB lets the FIRST user be created over
# the loopback exception; once any user exists that exception is gone, so a
# re-run must authenticate as admin instead. We handle BOTH: try to auth as
# admin first (re-run path); if that fails, bootstrap the admin via the localhost
# exception (first-run path). Then create the app user only if it's missing — so
# re-running this whole script (e.g. to repair the backup half) is safe rather
# than aborting at "user already exists" / "not authorized". Secrets + the db
# name are passed via env (NOT interpolated into the JS) so a quote/space can't
# break the script; quit(1) makes a genuine failure abort under `set -e`.
MONGO_ADMIN_PASS="${ADMIN_DB_PASS}" \
MONGO_APP_USER="${APP_DB_USER}" \
MONGO_APP_PASS="${APP_DB_PASS}" \
MONGO_APP_DB="${APP_DB_NAME}" \
mongosh --quiet "mongodb://127.0.0.1:27017/admin" <<'EOF'
try {
  const adminPass = process.env.MONGO_ADMIN_PASS;
  const appUser   = process.env.MONGO_APP_USER;
  const appPass   = process.env.MONGO_APP_PASS;
  const appDb     = process.env.MONGO_APP_DB;

  // Re-run path: admin already exists -> authenticate. First-run path: no users
  // yet -> the auth throws/returns false, so create admin via the loopback
  // exception, then authenticate.
  let authed = false;
  try { authed = db.auth('admin', adminPass); } catch (e) { authed = false; }
  if (!authed) {
    db.createUser({ user: 'admin', pwd: adminPass, roles: [{ role: 'root', db: 'admin' }] });
    if (!db.auth('admin', adminPass)) { throw new Error('admin auth failed after createUser'); }
  }

  // App user: create only if missing (idempotent).
  const target = db.getSiblingDB(appDb);
  if (!target.getUser(appUser)) {
    target.createUser({ user: appUser, pwd: appPass, roles: [{ role: 'readWrite', db: appDb }] });
  }
  if (!target.getUser(appUser)) { throw new Error('app user missing after creation'); }
  print('OK: admin ready and ' + appUser + ' present on ' + appDb);
} catch (e) {
  print('FATAL: user setup failed: ' + e);
  quit(1);
}
EOF

echo
echo "MongoDB ${MONGO_MAJOR} is installed, hardened and running."
echo "App connection string (put this in the app's config/default.json):"
echo "  mongodb://${APP_DB_USER}:<password>@${DB_BIND_IP}:27017/${APP_DB_NAME}?authSource=${APP_DB_NAME}"
echo
echo "Quick test:"
echo "  mongosh \"mongodb://${APP_DB_USER}:<password>@127.0.0.1:27017/${APP_DB_NAME}?authSource=${APP_DB_NAME}\" --eval 'db.runCommand({ping:1})'"
