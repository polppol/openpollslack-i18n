#!/usr/bin/env bash
#
# Deploy an App container FROM A PROXMOX NODE. One command sets up the whole CT:
# installs Node + the app, pushes your config, starts the openpoll service, and
# (unless --app-only) installs Caddy for HTTPS. You run THIS on the node.
#
# Two topologies:
#   BUNDLED (default):  Caddy runs in THIS CT — self-contained HTTPS for one app.
#   SPLIT (--app-only): no Caddy here; a separate reverse-proxy CT
#                       (rproxy/deploy-rproxy-to-ct.sh) fronts this and other app CTs.
#
#   1. bash proxmox/create-containers.sh    # create the CTs (run first)
#   2. bash db/deploy-db-to-ct.sh           # bring the DB up first (app needs Mongo)
#   3. Prepare config in THIS app/ folder, on the node:
#        cp default.json.example default.json   # then edit it: mongo_url host, domain,
#            oauth_success/oauth_failure. The wrapper can PROMPT the Slack/DB secrets
#            (hidden) and fill them in for you.
#        # BUNDLED only: edit Caddyfile (your domain). The CF token is prompted.
#   4. bash app/deploy-app-to-ct.sh             # bundled (Caddy here)
#      bash app/deploy-app-to-ct.sh --app-only  # split (app only, no Caddy)
#
# Prompts for the settings below (Enter keeps the default). NONINTERACTIVE=1 or
# --yes accepts all defaults.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"   # the app/ folder of this kit
for _lib in ask caddy secrets; do
  _p="${HERE}/../lib/${_lib}.sh"
  [ -r "${_p}" ] || { echo "ERROR: missing ${_p}" >&2; exit 1; }
  . "${_p}"
done

# ─────────────────────────── settings to review ────────────────────────────
APP_ID=5000                                  # this app CT's id
APP_PORT=5000                                # port the Node app listens on (must match "port" in default.json)
APP_DIR=/opt/openpollslack-i18n
INSTALL_CADDY=true                           # true = bundled (Caddy here); false = app-only (--app-only)
TLS_MODE=cloudflare                          # (bundled) cloudflare = DNS-01 auto-cert; manual = you install the cert
TLS_CERT_PATH=/etc/caddy/cert.pem            # (bundled, manual TLS) cert path inside the CT
TLS_KEY_PATH=/etc/caddy/key.pem              # (bundled, manual TLS) key path inside the CT
# ────────────────────────────────────────────────────────────────────────────

# Flags: --app-only/--no-caddy (split), --bundled/--with-caddy, --yes (non-interactive).
for _arg in "$@"; do
  case "$(printf '%s' "${_arg}" | tr '[:upper:]' '[:lower:]')" in
    --app-only|--no-caddy)  INSTALL_CADDY=false ;;
    --bundled|--with-caddy) INSTALL_CADDY=true ;;
    -y|--yes)               NONINTERACTIVE=1 ;;
    *) echo "ERROR: unknown argument '${_arg}' (supported: --app-only, --bundled, --yes)" >&2; exit 1 ;;
  esac
done
export NONINTERACTIVE

ask_active || echo ">>> non-interactive: keeping defaults (App CT ${APP_ID}, port ${APP_PORT}, INSTALL_CADDY=${INSTALL_CADDY})." >&2
ask     APP_ID    "App CT id"
ask     APP_PORT  "App listen port (must match \"port\" in default.json)"
confirm INSTALL_CADDY "Install Caddy (HTTPS) in THIS CT?  No = app-only, fronted by a separate reverse-proxy CT"
if [ "${INSTALL_CADDY}" = true ]; then
  ask TLS_MODE "TLS mode (cloudflare = auto DNS-01 cert | manual = you install the cert)"
  case "${TLS_MODE}" in cloudflare|manual) ;; *) echo "ERROR: TLS_MODE must be cloudflare|manual (got '${TLS_MODE}')." >&2; exit 1 ;; esac
  if [ "${TLS_MODE}" = manual ]; then
    ask TLS_CERT_PATH "Path to your cert (fullchain) inside the CT"
    ask TLS_KEY_PATH  "Path to your private key inside the CT"
  fi
fi

command -v pct >/dev/null 2>&1 || {
  echo "ERROR: 'pct' not found — run this ON a Proxmox node, not inside a CT." >&2; exit 1; }
pct status "${APP_ID}" >/dev/null 2>&1 || {
  echo "ERROR: CT ${APP_ID} not found — run proxmox/create-containers.sh first." >&2; exit 1; }
if ! pct exec "${APP_ID}" -- true 2>/dev/null; then
  echo ">>> Starting CT ${APP_ID} ..."; pct start "${APP_ID}"
  for _i in $(seq 1 30); do pct exec "${APP_ID}" -- true 2>/dev/null && break; sleep 1; done
fi

# Required config files. default.json always; the Caddyfile only when we install
# Caddy here (the rproxy CT owns the Caddyfile in the split topology).
[ -f "${HERE}/default.json" ] || {
  echo "ERROR: ${HERE}/default.json is missing — cp default.json.example default.json (then edit it)." >&2; exit 1; }
if [ "${INSTALL_CADDY}" = true ]; then
  [ -f "${HERE}/Caddyfile" ] || {
    echo "ERROR: ${HERE}/Caddyfile is missing — needed for the bundled (Caddy-here) setup." >&2; exit 1; }
fi

# Offer to fill the Slack secrets in default.json (hidden, JSON-escaped). Skips
# any token you already replaced; pressing Enter keeps whatever is in the file.
# The whole body runs with xtrace OFF so a `bash -x` run can't leak the values.
# NOTE: the Mongo password is NOT prompted here — it lives inside the mongo_url
# URI (with the DB host you must set anyway), so edit that one line by hand and
# keep the password URI-safe (URL-encode reserved characters).
_fill() {   # _fill <token> <prompt> <plain|secret>
  grep -q "$1" "${HERE}/default.json" || return 0
  local _xt=0; case "$-" in *x*) _xt=1; set +x ;; esac
  local _v=""
  if [ "$3" = secret ]; then ask_secret _v "$2"; else ask _v "$2"; fi
  [ -n "${_v}" ] && replace_token "${HERE}/default.json" "$1" "${_v}" json
  [ "${_xt}" = 1 ] && set -x
  return 0
}
_fill REPLACE_WITH_SLACK_CLIENT_ID      "Slack client_id"                  plain
_fill REPLACE_WITH_SLACK_CLIENT_SECRET  "Slack client_secret"              secret
_fill REPLACE_WITH_SLACK_SIGNING_SECRET "Slack signing_secret"             secret
_fill REPLACE_WITH_ANY_RANDOM_STRING    "state_secret (any random string)" secret

if grep -q "REPLACE_WITH" "${HERE}/default.json"; then
  echo "ERROR: app/default.json still has REPLACE_WITH placeholders — fill them" >&2
  echo "       (edit the file directly, or answer the prompts; the mongo_url password" >&2
  echo "        + host and the oauth/domain URLs are edited by hand)." >&2
  exit 1
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

if [ "${INSTALL_CADDY}" = true ]; then
  echo ">>> Installing Caddy (HTTPS, TLS_MODE=${TLS_MODE}) inside CT ${APP_ID} ..."
  pct push "${APP_ID}" "${HERE}/install-caddy.in-ct.sh" /root/install-caddy.in-ct.sh
  pct exec "${APP_ID}" -- env TLS_MODE="${TLS_MODE}" bash /root/install-caddy.in-ct.sh

  if [ "${TLS_MODE}" = cloudflare ]; then
    # Cloudflare token: reuse app/cloudflare.env, else prompt (hidden) + create it.
    CF_API_TOKEN=""
    if [ -f "${HERE}/cloudflare.env" ]; then
      CF_API_TOKEN="$(sed -n 's/^CF_API_TOKEN=//p' "${HERE}/cloudflare.env" | head -n1)"
      [ "${CF_API_TOKEN}" = "REPLACE_WITH_CLOUDFLARE_TOKEN" ] && CF_API_TOKEN=""
    fi
    ask_secret CF_API_TOKEN "Cloudflare API token (Zone:DNS:Edit)"
    [ -n "${CF_API_TOKEN}" ] || {
      echo "ERROR: no Cloudflare token provided (or re-run with --app-only, or pick TLS_MODE=manual)." >&2; exit 1; }
    ( set +x; umask 077; printf 'CF_API_TOKEN=%s\n' "${CF_API_TOKEN}" > "${HERE}/cloudflare.env" )
    pct push "${APP_ID}" "${HERE}/cloudflare.env" /etc/caddy/cloudflare.env
    pct exec "${APP_ID}" -- chmod 600             /etc/caddy/cloudflare.env
  fi

  _FINAL="$(mktemp)"; trap 'rm -f "${_FINAL}"' EXIT
  caddy_finalize "${HERE}/Caddyfile" "${_FINAL}" "${TLS_MODE}" "${TLS_CERT_PATH}" "${TLS_KEY_PATH}"
  pct push "${APP_ID}" "${_FINAL}" /etc/caddy/Caddyfile

  if [ "${TLS_MODE}" = cloudflare ]; then
    pct exec "${APP_ID}" -- caddy validate --config /etc/caddy/Caddyfile
    pct exec "${APP_ID}" -- systemctl enable caddy
    pct exec "${APP_ID}" -- systemctl restart caddy
  else
    # Manual TLS: cert files may not be in place yet, so validate/start can
    # legitimately fail until you install them — don't abort the deploy.
    pct exec "${APP_ID}" -- caddy validate --config /etc/caddy/Caddyfile \
      || echo "    (validate failed — expected until your cert is at ${TLS_CERT_PATH}/${TLS_KEY_PATH})"
    pct exec "${APP_ID}" -- systemctl enable caddy
    pct exec "${APP_ID}" -- systemctl restart caddy \
      || echo "    (Caddy did not start — install your cert+key, then: pct exec ${APP_ID} -- systemctl restart caddy)"
  fi
fi

echo
echo "App container ${APP_ID} is set up (mode: $([ "${INSTALL_CADDY}" = true ] && echo bundled || echo app-only))."
echo "  pct exec ${APP_ID} -- curl -s http://127.0.0.1:${APP_PORT}/healthz"
if [ "${INSTALL_CADDY}" = true ]; then
  echo "  then point your router's 443 at this CT and open https://<your-domain>/node/${APP_PORT}/healthz"
  [ "${TLS_MODE}" = manual ] && \
    echo "  manual TLS: put your cert+key at ${TLS_CERT_PATH} / ${TLS_KEY_PATH}, then: pct exec ${APP_ID} -- systemctl restart caddy"
else
  echo "  app-only: add this CT as a backend in your reverse-proxy CT's Caddyfile.multi:"
  echo "      handle_path /node/${APP_PORT}/* { import app_backend <this-CT-IP>:${APP_PORT} }"
  echo "  then deploy/reload the rproxy:  bash rproxy/deploy-rproxy-to-ct.sh"
fi
