#!/usr/bin/env bash
#
# Deploy the App container FROM A PROXMOX NODE — one command sets up the whole
# CT: installs Node + the app, pushes your config, installs Caddy (HTTPS), and
# starts everything inside CT 5000. You run THIS on the node.
#
#   1. bash proxmox/create-containers.sh    # create the CTs (run first)
#   2. bash db/deploy-db-to-ct.sh           # bring the DB up first (app needs Mongo)
#   3. Prepare these files in THIS app/ folder, on the node:
#        cp default.json.example default.json   # then edit it: mongo_url (with the
#            openpoll password), Slack client_id/client_secret/signing_secret,
#            state_secret, oauth_success/oauth_failure
#        edit Caddyfile                          # set your real domain
#        printf 'CF_API_TOKEN=%s\n' 'YOUR_TOKEN' > cloudflare.env   # Cloudflare token
#        # default.json + cloudflare.env are git-ignored — they hold secrets
#   4. bash app/deploy-app-to-ct.sh         # <- this script
set -euo pipefail

APP_ID=5000
APP_DIR=/opt/openpollslack-i18n
HERE="$(cd "$(dirname "$0")" && pwd)"   # the app/ folder of this kit

command -v pct >/dev/null 2>&1 || {
  echo "ERROR: 'pct' not found — run this ON a Proxmox node, not inside a CT." >&2; exit 1; }
pct status "${APP_ID}" >/dev/null 2>&1 || {
  echo "ERROR: CT ${APP_ID} not found — run proxmox/create-containers.sh first." >&2; exit 1; }
if ! pct exec "${APP_ID}" -- true 2>/dev/null; then
  echo ">>> Starting CT ${APP_ID} ..."; pct start "${APP_ID}"
  for _i in $(seq 1 30); do pct exec "${APP_ID}" -- true 2>/dev/null && break; sleep 1; done
fi

# The config files you must prepare first (they hold YOUR secrets / domain).
for f in default.json cloudflare.env Caddyfile; do
  [ -f "${HERE}/${f}" ] || {
    echo "ERROR: ${HERE}/${f} is missing — see this script's header (step 3)." >&2; exit 1; }
done
if grep -q "REPLACE_WITH" "${HERE}/default.json"; then
  echo "ERROR: edit app/default.json — it still has REPLACE_WITH placeholders." >&2; exit 1
fi

echo ">>> Installing Node + the app inside CT ${APP_ID} ..."
pct push "${APP_ID}" "${HERE}/setup-app.in-ct.sh" /root/setup-app.in-ct.sh
pct exec "${APP_ID}" -- bash /root/setup-app.in-ct.sh

echo ">>> Pushing your config + the systemd unit ..."
pct push "${APP_ID}" "${HERE}/default.json"     "${APP_DIR}/config/default.json"
pct exec "${APP_ID}" -- chown openpoll:openpoll "${APP_DIR}/config/default.json"
pct exec "${APP_ID}" -- chmod 600               "${APP_DIR}/config/default.json"
pct push "${APP_ID}" "${HERE}/openpoll.service" /etc/systemd/system/openpoll.service
pct exec "${APP_ID}" -- systemctl daemon-reload
pct exec "${APP_ID}" -- systemctl enable --now openpoll

echo ">>> Installing Caddy (HTTPS) inside CT ${APP_ID} ..."
pct push "${APP_ID}" "${HERE}/install-caddy.in-ct.sh" /root/install-caddy.in-ct.sh
pct exec "${APP_ID}" -- bash /root/install-caddy.in-ct.sh
pct push "${APP_ID}" "${HERE}/cloudflare.env" /etc/caddy/cloudflare.env
pct exec "${APP_ID}" -- chmod 600             /etc/caddy/cloudflare.env
pct push "${APP_ID}" "${HERE}/Caddyfile"      /etc/caddy/Caddyfile
pct exec "${APP_ID}" -- systemctl enable caddy
pct exec "${APP_ID}" -- systemctl restart caddy

echo
echo "App container ${APP_ID} is set up. Checks:"
echo "  pct exec ${APP_ID} -- curl -s http://127.0.0.1:5000/healthz"
echo "  then point your router's 443 at the App CT and open https://<domain>/node/5000/healthz"
