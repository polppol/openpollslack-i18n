# lib/caddy.sh — shared Caddyfile helpers for the deploy wrappers (SSOT).
#
# SOURCE this from a node-run wrapper (same as lib/ask.sh):
#   . "${HERE}/../lib/caddy.sh"   # from app/, rproxy/
#
# Both app/deploy-app-to-ct.sh (bundled) and rproxy/deploy-rproxy-to-ct.sh
# (split) need to turn the Caddyfile's __TLS_DIRECTIVE__ placeholder into a real
# tls directive based on the chosen TLS_MODE. Keep that logic in ONE place.

if [ -z "${BASH_VERSION:-}" ]; then
  echo "caddy.sh requires bash." >&2
  return 1 2>/dev/null || exit 1
fi

# Print the tls directive for a mode. cloudflare -> DNS-01 auto-cert;
# manual -> a cert/key pair you install yourself.
caddy_tls_directive() {
  local __mode="$1"
  local __cert="${2:-/etc/caddy/cert.pem}"
  local __key="${3:-/etc/caddy/key.pem}"
  case "${__mode}" in
    cloudflare) printf 'tls {\n\tdns cloudflare {env.CF_API_TOKEN}\n}' ;;
    manual)     printf 'tls %s %s' "${__cert}" "${__key}" ;;
    *) echo "caddy.sh: unknown TLS_MODE '${__mode}' (use cloudflare|manual)" >&2; return 1 ;;
  esac
}

# Render <src> into <dst>, replacing every line that contains __TLS_DIRECTIVE__
# with the chosen tls directive (indentation preserved). Literal replacement via
# awk, so cert paths containing regex/replacement specials are safe.
caddy_finalize() {
  local __src="$1"
  local __dst="$2"
  local __mode="$3"
  local __cert="${4:-/etc/caddy/cert.pem}"
  local __key="${5:-/etc/caddy/key.pem}"
  local __directive
  __directive="$(caddy_tls_directive "${__mode}" "${__cert}" "${__key}")" || return 1
  # Replace ONLY a line whose sole content is the sentinel (ignoring
  # indentation) — so comment lines that merely mention __TLS_DIRECTIVE__ are
  # left untouched. The cloudflare directive spans multiple lines (Caddy forbids
  # one-line blocks: '{' must end its line, '}' on its own line), so prepend the
  # sentinel line's indentation to EACH line of the directive.
  awk -v d="${__directive}" '
    {
      t = $0
      sub(/^[ \t]+/, "", t); sub(/[ \t]+$/, "", t)
      if (t == "__TLS_DIRECTIVE__") {
        match($0, /^[ \t]*/)
        ind = substr($0, 1, RLENGTH)
        n = split(d, lines, "\n")
        for (i = 1; i <= n; i++) print ind lines[i]
      } else {
        print
      }
    }
  ' "${__src}" > "${__dst}"
}
