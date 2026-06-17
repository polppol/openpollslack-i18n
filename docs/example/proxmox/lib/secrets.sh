# lib/secrets.sh — literal, xtrace-safe token replacement in a config file.
#
# Used by deploy wrappers to drop a prompted secret into a file (e.g. fill the
# REPLACE_WITH_* placeholders in default.json) WITHOUT a fragile sed/regex pass.

if [ -z "${BASH_VERSION:-}" ]; then
  echo "secrets.sh requires bash." >&2
  return 1 2>/dev/null || exit 1
fi

# replace_token <file> <token> <value> [json]
# Replace every LITERAL occurrence of <token> with <value> in <file>, in place.
# The value is passed through the environment (ENVIRON) so awk does not process
# backslash escapes or treat any character (/ & \ $ " etc.) specially, and xtrace
# is disabled around the work so the value can't leak into `bash -x` output.
# With a 4th arg "json", the value is JSON-string-escaped (\ -> \\, " -> \") first,
# so it can be dropped safely inside a JSON string literal.
# Preserves the file's existing permissions (writes through the same inode).
replace_token() {
  local __file="$1"
  local __token="$2"
  local __value="$3"
  local __mode="${4:-raw}"
  local __xt=0
  case "$-" in *x*) __xt=1; set +x ;; esac
  if [ "${__mode}" = json ]; then
    __value="${__value//\\/\\\\}"
    __value="${__value//\"/\\\"}"
  fi
  local __tmp
  __tmp="$(mktemp)"
  if RT_TOK="${__token}" RT_VAL="${__value}" awk '
       {
         line = $0; t = ENVIRON["RT_TOK"]; v = ENVIRON["RT_VAL"]; out = ""
         while ((p = index(line, t)) > 0) {
           out = out substr(line, 1, p - 1) v
           line = substr(line, p + length(t))
         }
         print out line
       }
     ' "${__file}" > "${__tmp}"; then
    cat "${__tmp}" > "${__file}"
  fi
  rm -f "${__tmp}"
  [ "${__xt}" = 1 ] && set -x
  return 0
}
