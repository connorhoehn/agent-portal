# shellcheck shell=bash
# Run a static judge ONCE per tree state (audit 2026-10-07 T7). A full audit
# pass runs the portal typecheck in six validators and the nav-parity and
# route-coverage judges as siblings of three more; each is a pure function of
# the tree, so a later caller replays the first one's result.
#
#   jg_cached <name> <command...>   run it (or replay it): its output on stdout, its exit code returned
#
# A cached result is replayed only while NOTHING under the judged roots (both
# source trees, the e2e specs, the scripts, the seeds, docs, both installs'
# lockfiles, the queue) is newer than it — an edit, a delete (the directory's
# mtime moves), an install or a checkout all invalidate it — and for at most
# 30 minutes. JUDGE_CACHE=off disables it; $JUDGE_CACHE_DIR moves it. Only
# static judges belong here: nothing that reads the clock, the dev stack or
# the network.
JG_ROOTS=(portal/src portal/e2e portal/package.json portal/tsconfig.json portal/vite.config.ts portal/node_modules/.package-lock.json
  middleware/src middleware/seeds middleware/package.json middleware/tsconfig.json middleware/node_modules/.package-lock.json
  scripts docs)

jg_cached() {
  local name=$1; shift
  if [ "${JUDGE_CACHE:-on}" = off ]; then "$@"; return $?; fi
  local dir=${JUDGE_CACHE_DIR:-${TMPDIR:-/tmp}/orgiq-judge-cache}
  mkdir -p "$dir"
  find "$dir" -type f -mmin +30 -delete 2>/dev/null
  # The date is part of the key: a burn-down judge reads today's date.
  local key; key=$(printf '%s\0%s\0%s' "$PWD" "$name" "$(date +%F)" | shasum -a 256 | cut -c1-24)
  local out="$dir/$key.out" rc="$dir/$key.rc"
  if [ -f "$rc" ] && [ -f "$out" ] && [ -z "$(find "${JG_ROOTS[@]}" -newer "$rc" -print -quit 2>/dev/null)" ]; then
    cat "$out"; return "$(cat "$rc")"
  fi
  local code started="$dir/$key.start"
  : > "$started"
  "$@" > "$dir/$key.tmp" 2>&1; code=$?
  # A tree that moved WHILE the judge ran is not the tree it judged: keep nothing.
  if [ -n "$(find "${JG_ROOTS[@]}" -newer "$started" -print -quit 2>/dev/null)" ]; then
    cat "$dir/$key.tmp"; rm -f "$dir/$key.tmp" "$started" "$out" "$rc"; return "$code"
  fi
  mv "$dir/$key.tmp" "$out"; printf '%s' "$code" > "$rc"; touch -r "$started" "$rc"; rm -f "$started"
  cat "$out"; return "$code"
}

# The typecheck/build gates every tenant validator repeats.
jg_portal_tsc()  { jg_cached portal-tsc      bash -c 'cd portal && npx tsc --noEmit'; }
jg_mw_tsc()      { jg_cached middleware-tsc  bash -c 'cd middleware && npx tsc --noEmit'; }
jg_mw_typecheck(){ jg_cached middleware-typecheck bash -c 'cd middleware && npm run -s typecheck'; }
jg_vite_build()  { jg_cached portal-vite-build bash -c 'cd portal && npx vite build'; }

# Sibling judges that are pure functions of the tree and the date (no stack,
# no network, no time-of-day gate) — the only ones a validator may replay
# instead of rerunning. Anything else runs every time.
jg_judge() {
  local script=$1; shift
  case "$script $*" in
    "validate-nav-parity.sh --quick"|"validate-nav-parity.sh "|"validate-route-coverage.sh "|"validate-component-discipline.sh "|"validate-component-discipline.sh --quick"|"validate-rail-parity.sh --quick") ;;
    *) bash "scripts/$script" "$@"; return $?;;
  esac
  jg_cached "judge:$script $*" bash "scripts/$script" "$@"
}
