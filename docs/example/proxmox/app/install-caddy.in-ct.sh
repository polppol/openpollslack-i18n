#!/usr/bin/env bash
#
# Install Caddy (the app's HTTPS front door) INSIDE the App container, with the
# Cloudflare DNS module so it can issue certs via the DNS-01 challenge (no
# inbound port 80 required). This REPLACES the old Apache reverse proxy: the App
# container now terminates TLS itself and proxies the Node app on localhost:5000.
#
# This runs INSIDE the App container (CT 5000). You normally do NOT run it by
# hand — app/deploy-app-to-ct.sh (on the Proxmox node) runs it for you, then
# pushes cloudflare.env + Caddyfile and restarts Caddy.
# (To run it manually: pct enter 5000, then bash install-caddy.in-ct.sh.)
set -euo pipefail

# ── Safety: run INSIDE the App container (CT 5000), NOT on a Proxmox node. ────
# This installs Caddy; on a node that would pollute the hypervisor. A Proxmox
# host has /etc/pve + pct/pveversion; a container does not — bail out on a host.
if [ -d /etc/pve ] || command -v pct >/dev/null 2>&1 || command -v pveversion >/dev/null 2>&1; then
  echo "ERROR: this looks like a Proxmox HOST, not the App container (CT 5000)." >&2
  echo "       Run it inside the CT:  pct enter 5000   then  bash install-caddy.in-ct.sh" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg

# --- Caddy from the official APT repo ---------------------------------------
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
apt-get update
apt-get install -y caddy

# --- Cloudflare DNS provider module -----------------------------------------
# The stock Caddy binary has no DNS plugins; `caddy add-package` swaps in a
# build that includes the Cloudflare provider (needed for the DNS-01 challenge).
caddy add-package github.com/caddy-dns/cloudflare
if caddy list-modules | grep -qi 'dns.providers.cloudflare'; then
  echo "Cloudflare DNS module present."
else
  echo "WARN: Cloudflare DNS module not found — re-check 'caddy add-package' output." >&2
fi
# add-package swaps in a self-built binary that dpkg does NOT track, so a later
# `apt upgrade` would silently revert to the stock binary and break cert renewal
# ("unknown module dns.providers.cloudflare"). Hold it; after an intentional Caddy
# upgrade, re-run `caddy add-package github.com/caddy-dns/cloudflare`.
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

cat <<EOF

Caddy installed with Cloudflare DNS support.
Next:
  1. Edit /etc/caddy/cloudflare.env  ->  CF_API_TOKEN=<your token>   (chmod 600)
  2. Install the site config:
       pct push 5000 app/Caddyfile /etc/caddy/Caddyfile   # from a Proxmox node
       # set your real domain inside it, then:
       systemctl restart caddy
       journalctl -u caddy -f      # watch it obtain the cert via DNS-01
EOF
