# lib/ask.sh — tiny interactive-prompt helpers for the Open Poll Plus Proxmox kit.
#
# SOURCE this from a wrapper that runs ON the Proxmox node, e.g.:
#   HERE="$(cd "$(dirname "$0")" && pwd)"
#   . "${HERE}/../lib/ask.sh"      # from app/, db/, rproxy/
#   . "${HERE}/lib/ask.sh"         # from proxmox/
#
# It does NOT run on its own and never calls `exit` — only `return` — so a
# missing /dev/tty or a piped run degrades gracefully instead of killing the
# caller (which uses `set -euo pipefail`).
#
# Helpers:
#   ask VAR "Prompt"          show [current]; Enter keeps it, typed value overrides.
#   ask_secret VAR "Prompt"   hidden input; Enter keeps current; never echoed.
#   confirm VAR "Prompt"      y/n -> sets VAR to the string true/false.
#   ask_active                returns 0 when prompting is on (for a "using defaults" notice).
#
# Interactivity: ON only when run on a real controlling terminal
# (`[ -t 1 ] && [ -r /dev/tty ]`) and neither NONINTERACTIVE=1 nor ASSUME_YES=1
# is set. Otherwise every helper keeps the existing default — a `curl | bash`
# or CI run can never hang, and can never silently ship example values without
# the wrapper getting a chance to say so (see ask_active).

# These helpers use bash-only features (`${!var}` indirection, `printf -v`).
if [ -z "${BASH_VERSION:-}" ]; then
  echo "ask.sh requires bash (got a non-bash shell)." >&2
  return 1 2>/dev/null || exit 1
fi

# True when interactive prompting should happen. Reads the controlling
# terminal, NOT stdin — so prompts still work with stdin closed/redirected,
# and are correctly skipped when there is no terminal at all.
ask_active() {
  [ "${NONINTERACTIVE:-0}" != 1 ] || return 1
  [ "${ASSUME_YES:-0}" != 1 ]     || return 1
  [ -t 1 ]                        || return 1
  [ -r /dev/tty ]                 || return 1
  return 0
}

# Reject anything that is not a plain shell identifier before we printf -v into
# it (printf -v 'x[0]' would silently write an array element; 'a;b' is refused
# by printf itself but we fail earlier with a clear message).
_ask_valid_name() {
  case "$1" in
    [A-Za-z_]*) ;;
    *) echo "ask.sh: invalid variable name: '$1'" >&2; return 1 ;;
  esac
  if [[ "$1" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
    return 0
  fi
  echo "ask.sh: invalid variable name: '$1'" >&2
  return 1
}

ask() {
  local __var="$1"
  local __prompt="$2"
  _ask_valid_name "$__var" || return 1
  # Indirect expansion on its OWN line — `local x=$1 y=${!x}` aborts with
  # "invalid indirect expansion". The `-` keeps `set -u` happy if VAR is unset.
  local __cur="${!__var-}"
  ask_active || return 0
  local __in=""
  # `|| __in=""` rescues EOF / unreadable tty so `set -e` can't abort here.
  IFS= read -r -p "${__prompt} [${__cur}]: " __in </dev/tty || __in=""
  if [ -n "$__in" ]; then
    printf -v "$__var" '%s' "$__in"
  fi
  return 0
}

ask_secret() {
  local __var="$1"
  local __prompt="$2"
  _ask_valid_name "$__var" || return 1
  # Turn xtrace OFF for the whole secret-handling body: reading the current
  # value (${!__var}) AND writing the new one would otherwise leak the secret
  # into `bash -x deploy.sh` output. Restore the previous tracing state at the end.
  local __xt=0
  case "$-" in *x*) __xt=1; set +x ;; esac
  local __cur="${!__var-}"
  if ask_active; then
    local __hint="set value"
    [ -n "$__cur" ] && __hint="unchanged"
    local __in=""
    IFS= read -rs -p "${__prompt} [${__hint}]: " __in </dev/tty || __in=""
    printf '\n' >/dev/tty   # read -s ate the newline; advance the cursor.
    [ -n "$__in" ] && printf -v "$__var" '%s' "$__in"
  fi
  [ "$__xt" = 1 ] && set -x
  return 0
}

confirm() {
  local __var="$1"
  local __prompt="$2"
  _ask_valid_name "$__var" || return 1
  local __cur="${!__var-false}"
  ask_active || return 0
  local __def="n"
  [ "$__cur" = true ] && __def="y"
  local __hint="y/N"
  [ "$__def" = y ] && __hint="Y/n"
  local __in=""
  IFS= read -r -p "${__prompt} [${__hint}]: " __in </dev/tty || __in=""
  [ -z "$__in" ] && __in="$__def"
  case "$__in" in
    [Yy]*) printf -v "$__var" '%s' true ;;
    *)     printf -v "$__var" '%s' false ;;
  esac
  return 0
}
