# shellcheck shell=bash
# Journey-log freshness for the validators (docs/journeys.md) — the ONE
# implementation, sourced by every validator that judges journey logs.
#
#   source scripts/lib/journeys.sh
#   jr_freshness docs/<family>-journeys <log>...   # judge these logs
#   jr_report                                       # print ✓/✗ through the caller's ok/fail
#
# A log is stale when the RENDERED CONTRACT of a route it walked changed since
# its walk was sealed (scripts/journeys/journeys.mjs has the rule), not when
# a source file under the route was touched. jr_report fails:
#   - once, when the contracts are not measured on the current source
#     (run scripts/journeys/measure.sh) — the per-log verdicts are then provisional;
#   - when any listed log is stale, unsealed or names nothing judgeable.
# The caller must define ok() and fail(). Only scripts/journeys/seal.sh seals.

jr_freshness() {
  local fam=$1; shift
  JR_FAMILY=$fam; JR_TOTAL=$#; JR_STALE=0; JR_NAMES=""; JR_UNMEASURED=""; JR_FRESH=0
  [ $# -gt 0 ] || return 0
  local out line log verdict detail
  out=$(node scripts/journeys/journeys.mjs judge "$fam" "$@" 2>&1) || { JR_UNMEASURED="the freshness judge crashed: $(printf '%s' "$out" | head -3 | tr '\n' ' ')"; JR_STALE=$#; return 0; }
  while IFS=$'\t' read -r log verdict detail; do
    if [ "$log" = MEASURED ]; then [ "$verdict" = ok ] || JR_UNMEASURED=$detail; continue; fi
    if [ "$verdict" = fresh ]; then JR_FRESH=$((JR_FRESH+1)); continue; fi
    if [ "$verdict" = record ]; then continue; fi  # a review/ledger record is not a walk (docs/journeys.md)
    JR_STALE=$((JR_STALE+1))
    case "$verdict" in
      stale) JR_NAMES="$JR_NAMES ${log#$fam/}(contract:${detail%%;*})";;
      *) JR_NAMES="$JR_NAMES ${log#$fam/}($verdict)";;
    esac
  done <<< "$out"
}

jr_report() {
  local seal="scripts/journeys/seal.sh <dir>"
  if [ -n "$JR_UNMEASURED" ]; then
    fail "rendered contracts are not measured on the current source ($JR_UNMEASURED) — run scripts/journeys/measure.sh; the verdicts below are against the last measurement"
  fi
  if [ "$JR_TOTAL" = 0 ]; then return 0; fi
  if [ "$JR_STALE" = 0 ]; then
    ok "$JR_TOTAL logs' rendered contracts match their sealed walks"
  else
    fail "$JR_STALE of $JR_TOTAL logs: a walked route's rendered contract changed since the walk, or the log was never sealed under the contract rule — re-walk them, then $seal:$JR_NAMES"
  fi
}

# The old in-validator `--seal` is gone: sealing is one helper that refuses
# anything but a real walk.
jr_refuse_seal_flag() {
  for a in "$@"; do
    if [ "$a" = --seal ]; then
      echo "--seal is retired: walk the logs, then run scripts/journeys/seal.sh <dir> (one directory per walk; docs/journeys.md)" >&2
      exit 2
    fi
  done
}
