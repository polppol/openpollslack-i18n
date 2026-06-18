#!/usr/bin/env bash
#
# Install Caddy (the HTTPS front door) INSIDE the container that terminates TLS
# — the App CT in the BUNDLED setup, or the standalone reverse-proxy CT in the
# SPLIT setup. This REPLACES the old Apache reverse proxy.
#
# TLS mode (env TLS_MODE, default "cloudflare"):
#   cloudflare : also add the Cloudflare DNS module so Caddy issues + auto-renews
#                certs via the DNS-01 challenge (no inbound port 80) and wire the
#                token env file.
#   manual     : install the stock Caddy only — NO automatic certs, NO Cloudflare
#                token. You provide the certificate yourself (the deploy wrapper
#                writes a `tls <cert> <key>` line into the Caddyfile).
#
# This runs INSIDE that CT. You normally do NOT run it by hand — the deploy
# wrapper on the Proxmox node (app/deploy-app-to-ct.sh for bundled, or
# rproxy/deploy-rproxy-to-ct.sh for split) pushes this in and runs it for you,
# then pushes the Caddyfile (+ the token in cloudflare mode) and restarts Caddy.
# (To run it manually: pct enter <CT ID>, then  TLS_MODE=cloudflare bash install-caddy.in-ct.sh.)
set -euo pipefail

TLS_MODE="${TLS_MODE:-cloudflare}"   # cloudflare = DNS-01 auto-cert; manual = you install the cert

# ── Safety: run INSIDE the CT that runs Caddy, NOT on a Proxmox node. ────────
# This installs Caddy; on a node that would pollute the hypervisor. A Proxmox
# host has /etc/pve + pct/pveversion; a container does not — bail out on a host.
if [ -d /etc/pve ] || command -v pct >/dev/null 2>&1 || command -v pveversion >/dev/null 2>&1; then
  echo "ERROR: this looks like a Proxmox HOST, not the CT that should run Caddy." >&2
  echo "       Run it inside the CT:  pct enter <CT ID>   then  bash install-caddy.in-ct.sh" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg

# --- Caddy from the official APT repo ---------------------------------------
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
apt-get update
apt-get install -y caddy

if [ "${TLS_MODE}" = manual ]; then
  cat <<'EOF'

Caddy installed (stock binary, TLS_MODE=manual — NO automatic certificates).
You must provide the certificate yourself. The deploy wrapper sets a
'tls <cert> <key>' line in the Caddyfile (default paths /etc/caddy/cert.pem and
/etc/caddy/key.pem). Put your fullchain + private key there (or edit the paths),
then:  systemctl reload caddy
To run your own DNS-01 renewal (certbot / acme.sh) instead, see
app/tls-cloudflare-dns.md (Options B and C).
EOF
  exit 0
fi

# ===== TLS_MODE=cloudflare : Cloudflare DNS-01 automatic certs ===============

# --- Cloudflare DNS provider module -----------------------------------------
# The stock Caddy binary has no DNS plugins; `caddy add-package` swaps in a
# build that includes the Cloudflare provider (needed for the DNS-01 challenge).
# Idempotent: on a re-run `add-package` exits non-zero ("package is already
# added"), which under `set -e` would abort the whole deploy — so only build
# when the module is actually missing. This script MUST be safe to re-run.
if caddy list-modules 2>/dev/null | grep -qi 'dns.providers.cloudflare'; then
  echo "Cloudflare DNS module already present — skipping add-package."
else
  caddy add-package github.com/caddy-dns/cloudflare
fi
if caddy list-modules | grep -qi 'dns.providers.cloudflare'; then
  echo "Cloudflare DNS module present."
else
  echo "WARN: Cloudflare DNS module not found — re-check 'caddy add-package' output." >&2
fi
# add-package swaps in a self-built binary that dpkg does NOT track, so a later
# `apt upgrade` would silently revert to the stock binary and break cert renewal
# ("unknown module dns.providers.cloudflare"). Hold it; after an intentional Caddy
# upgrade, re-run `caddy add-package github.com/caddy-dns/cloudflare`.
# (Only held in cloudflare mode — the manual mode above keeps the stock binary
# patchable, since it has no self-built module to protect.)
apt-mark hold caddy

# --- Token wiring -----------------------------------------------------------
# Caddy reads CF_API_TOKEN from this env file (referenced as {env.CF_API_TOKEN}
# in the Caddyfile). Keep it root-only.
if [ ! -f /etc/caddy/cloudflare.env ]; then
  install -m 600 /dev/null /etc/caddy/cloudflare.env
  echo 'CF_API_TOKEN=REPLACE_WITH_CLOUDFLARE_TOKEN' > /etc/caddy/cloudflare.env
fi
mkdir -p /etc/systemd/system/caddy.service.d
cat > /etc/systemd/system/caddy.service.d/cloudflare.conf <<'EOF'
[Service]
EnvironmentFile=/etc/caddy/cloudflare.env
EOF
systemctl daemon-reload

cat <<'EOF'

Caddy installed with Cloudflare DNS support.
Next (the deploy wrapper normally does this for you):
  1. Set /etc/caddy/cloudflare.env  ->  CF_API_TOKEN=<your token>   (chmod 600)
  2. Install the Caddyfile and restart:
       systemctl restart caddy
       journalctl -u caddy -f      # watch it obtain the cert via DNS-01
EOF
