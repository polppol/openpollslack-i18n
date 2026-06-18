#!/usr/bin/env bash
#
# Deploy the standalone REVERSE-PROXY container FROM A PROXMOX NODE (the SPLIT
# setup). One command sets up the whole rproxy CT: installs Caddy, finalizes +
# pushes your multi-backend Caddyfile, wires TLS, and starts Caddy. You run THIS
# on the node. It fronts SEVERAL independent app-only CTs by /node/<port>/ path.
#
#   1. bash proxmox/create-containers.sh    # create the CTs (enable the rproxy CT)
#   2. bash db/deploy-db-to-ct.sh           # bring the DB(s) up
#   3. For EACH app instance:
#        bash app/deploy-app-to-ct.sh --app-only   # app only, no Caddy
#   4. edit rproxy/Caddyfile.multi          # set your domain + each backend IP:PORT
#   5. bash rproxy/deploy-rproxy-to-ct.sh   # <- this script
#
# Prompts for the settings below (Enter keeps the shown default). Run
# non-interactively with NONINTERACTIVE=1 (or --yes) to accept all defaults.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"     # the rproxy/ folder of this kit
APP_DIR_KIT="${HERE}/../app"              # reuse the App CT's Caddy installer (SSOT)
for _lib in ask caddy; do
  _p="${HERE}/../lib/${_lib}.sh"
  [ -r "${_p}" ] || { echo "ERROR: missing ${_p}" >&2; exit 1; }
  . "${_p}"
done

# ─────────────────────────── settings to review ────────────────────────────
RPROXY_ID=5030                               # the reverse-proxy CT's id
TLS_MODE=cloudflare                          # cloudflare = DNS-01 auto-cert; manual = you install the cert
TLS_CERT_PATH=/etc/caddy/cert.pem            # (manual mode) where you'll put your fullchain cert
TLS_KEY_PATH=/etc/caddy/key.pem              # (manual mode) where you'll put your private key
# ────────────────────────────────────────────────────────────────────────────

# Minimal flag parse: --yes / -y for non-interactive; reject anything unknown.
for _arg in "$@"; do
  case "${_arg}" in
    -y|--yes) NONINTERACTIVE=1 ;;
    *) echo "ERROR: unknown argument '${_arg}' (supported: --yes)" >&2; exit 1 ;;
  esac
done
export NONINTERACTIVE

ask_active || echo ">>> non-interactive: keeping defaults (rproxy CT ${RPROXY_ID}, TLS_MODE=${TLS_MODE})." >&2
ask     RPROXY_ID  "Reverse-proxy CT id"
ask     TLS_MODE   "TLS mode (cloudflare = auto DNS-01 cert | manual = you install the cert)"
case "${TLS_MODE}" in
  cloudflare|manual) ;;
  *) echo "ERROR: TLS_MODE must be 'cloudflare' or 'manual' (got '${TLS_MODE}')." >&2; exit 1 ;;
esac
if [ "${TLS_MODE}" = manual ]; then
  ask TLS_CERT_PATH "Path to your cert (fullchain) inside the CT"
  ask TLS_KEY_PATH  "Path to your private key inside the CT"
fi

command -v pct >/dev/null 2>&1 || {
  echo "ERROR: 'pct' not found — run this ON a Proxmox node, not inside a CT." >&2; exit 1; }
pct status "${RPROXY_ID}" >/dev/null 2>&1 || {
  echo "ERROR: CT ${RPROXY_ID} not found — run proxmox/create-containers.sh (enable the rproxy CT) first." >&2; exit 1; }
if ! pct exec "${RPROXY_ID}" -- true 2>/dev/null; then
  echo ">>> Starting CT ${RPROXY_ID} ..."; pct start "${RPROXY_ID}"
  for _i in $(seq 1 30); do pct exec "${RPROXY_ID}" -- true 2>/dev/null && break; sleep 1; done
fi

# The multi-backend Caddyfile you must edit first (domain + backend IP:PORTs).
[ -f "${HERE}/Caddyfile.multi" ] || {
  echo "ERROR: ${HERE}/Caddyfile.multi is missing." >&2; exit 1; }
# Strip "#" comments before checking — this file MENTIONS the placeholder in its
# own header comments, so grepping the raw file would keep matching even after
# you've edited the real domain line. (A domain never contains "#", so stripping
# from "#" to end-of-line can't swallow a real value.)
if sed 's/#.*//' "${HERE}/Caddyfile.multi" | grep -q "REPLACE_WITH"; then
  echo "ERROR: edit ${HERE}/Caddyfile.multi — set your domain (REPLACE_WITH_YOUR_DOMAIN) and each backend IP:PORT." >&2
  exit 1
fi

# Cloudflare token (cloudflare mode only): reuse an existing rproxy/cloudflare.env
# or prompt for it (hidden) and create it. It is git-ignored.
if [ "${TLS_MODE}" = cloudflare ]; then
  CF_API_TOKEN=""
  if [ -f "${HERE}/cloudflare.env" ]; then
    # shellcheck disable=SC1091
    CF_API_TOKEN="$(sed -n 's/^CF_API_TOKEN=//p' "${HERE}/cloudflare.env" | head -n1)"
    [ "${CF_API_TOKEN}" = "REPLACE_WITH_CLOUDFLARE_TOKEN" ] && CF_API_TOKEN=""
  fi
  ask_secret CF_API_TOKEN "Cloudflare API token (Zone:DNS:Edit)"
  if [ -z "${CF_API_TOKEN}" ]; then
    echo "ERROR: no Cloudflare token provided. Set one (or use TLS_MODE=manual)." >&2; exit 1
  fi
  ( set +x; umask 077; printf 'CF_API_TOKEN=%s\n' "${CF_API_TOKEN}" > "${HERE}/cloudflare.env" )
fi

echo ">>> Installing Caddy (TLS_MODE=${TLS_MODE}) inside CT ${RPROXY_ID} ..."
pct push "${RPROXY_ID}" "${APP_DIR_KIT}/install-caddy.in-ct.sh" /root/install-caddy.in-ct.sh
pct exec "${RPROXY_ID}" -- env TLS_MODE="${TLS_MODE}" bash /root/install-caddy.in-ct.sh

echo ">>> Finalizing + pushing the multi-backend Caddyfile ..."
_FINAL="$(mktemp)"
trap 'rm -f "${_FINAL}"' EXIT
caddy_finalize "${HERE}/Caddyfile.multi" "${_FINAL}" "${TLS_MODE}" "${TLS_CERT_PATH}" "${TLS_KEY_PATH}"
pct push "${RPROXY_ID}" "${_FINAL}" /etc/caddy/Caddyfile

if [ "${TLS_MODE}" = cloudflare ]; then
  pct push "${RPROXY_ID}" "${HERE}/cloudflare.env" /etc/caddy/cloudflare.env
  pct exec "${RPROXY_ID}" -- chmod 600             /etc/caddy/cloudflare.env
fi

echo ">>> Validating the Caddy config ..."
pct exec "${RPROXY_ID}" -- caddy fmt --overwrite /etc/caddy/Caddyfile
if [ "${TLS_MODE}" = cloudflare ]; then
  # `caddy validate` provisions the cloudflare DNS module, which needs the token,
  # but a bare validate does NOT read the systemd EnvironmentFile — so load
  # /etc/caddy/cloudflare.env first (set -a exports it, like systemd does).
  pct exec "${RPROXY_ID}" -- bash -c 'set -ea; . /etc/caddy/cloudflare.env; caddy validate --config /etc/caddy/Caddyfile'
  pct exec "${RPROXY_ID}" -- systemctl enable caddy
  pct exec "${RPROXY_ID}" -- systemctl restart caddy
else
  # Manual mode: the cert files may not be in place yet, so validate/start can
  # legitimately fail until you install them. Don't abort the deploy on that.
  pct exec "${RPROXY_ID}" -- caddy validate --config /etc/caddy/Caddyfile \
    || echo "    (validate failed — expected until your cert is at ${TLS_CERT_PATH}/${TLS_KEY_PATH})"
  pct exec "${RPROXY_ID}" -- systemctl enable caddy
  pct exec "${RPROXY_ID}" -- systemctl restart caddy \
    || echo "    (Caddy did not start — put your cert+key in place, then: pct exec ${RPROXY_ID} -- systemctl restart caddy)"
fi

echo
echo "Reverse-proxy CT ${RPROXY_ID} is set up (TLS_MODE=${TLS_MODE})."
if [ "${TLS_MODE}" = manual ]; then
  echo "  Put your cert + key at ${TLS_CERT_PATH} and ${TLS_KEY_PATH} inside CT ${RPROXY_ID}, then:"
  echo "    pct exec ${RPROXY_ID} -- systemctl restart caddy"
fi
echo "  Point your router's 443 at CT ${RPROXY_ID}, then for each backend open:"
echo "    curl -s https://<your-domain>/node/<port>/healthz"
echo "  Each /node/<port>/ prefix is a SEPARATE Slack app + DB — register its URLs in its own Slack app."
