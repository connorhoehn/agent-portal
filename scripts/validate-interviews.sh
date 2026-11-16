#!/usr/bin/env bash
# The judge for docs/interviews-tenant-plan.md — the `interviews` tenant. A row is done when this script
# says so, never when the plan's table is edited (row I0.1).
#
#   scripts/validate-interviews.sh --quick           static checks only, every phase
#   scripts/validate-interviews.sh --phase I0        phase 0, with its suites
#   scripts/validate-interviews.sh --phase I1        phases 0 and 1 (phases nest), with the walk
#   scripts/validate-interviews.sh                   every phase through E
#
# Each ledger row is either BUILT (listed in BUILT below, the lane's claim) or not. A built row in a judged
# phase runs its checks and every failing check prints with its row number. A row not built prints
# "not built"; it fails only in the full run (no --phase), which is the backlog view of the whole plan.
# A row in a phase after the one asked for prints "later phase" and is not judged.
#
# Suites (skipped by --quick): the middleware jest suites the rows own, the portal's interviews test, and,
# from phase I1, journey:interviews through run-demo-moments.mjs on JOURNEY_MIDDLEWARE_PORT /
# JOURNEY_PORTAL_PORT (set both when anyone else runs servers on this machine).
#
# Exit 0 and "ALL CHECKS PASS" only when no check failed.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

QUICK=0; PHASE=E; FULL=1
while [ $# -gt 0 ]; do
  case "$1" in
    --quick) QUICK=1 ;;
    --phase) shift; PHASE="${1:-E}"; FULL=0 ;;
    --phase=*) PHASE="${1#--phase=}"; FULL=0 ;;
    *) echo "usage: $0 [--quick] [--phase I0|I1|I2|I3|I4|I5|I6|E]" >&2; exit 2 ;;
  esac
  shift
done
phase_rank() { case "$1" in I0) echo 0;; I1) echo 1;; I2) echo 2;; I3) echo 3;; I4) echo 4;; I5) echo 5;; I6) echo 6;; E) echo 7;; *) echo -1;; esac; }
PR=$(phase_rank "$PHASE")
[ "$PR" -ge 0 ] || { echo "unknown phase: $PHASE" >&2; exit 2; }

LOGS="$(mktemp -d "${TMPDIR:-/tmp}/validate-interviews-XXXXXX")"
FAILS=(); PENDING=()
ROW=""
fail()  { FAILS+=("$ROW $1"); printf '  ✗ %s %s\n' "$ROW" "$1"; }
ok()    { printf '  ✓ %s %s\n' "$ROW" "$1"; }
note()  { printf '      %s\n' "$1"; }
pending() { PENDING+=("$ROW $1"); printf '  · %s %s\n' "$ROW" "$1"; }
has()   { grep -qE -- "$1" "$2" 2>/dev/null; }
hasF()  { grep -qF -- "$1" "$2" 2>/dev/null; }
need()  { if has "$1" "$2"; then ok "$3"; else fail "$3 (not found in $2)"; fi; }
needF() { if hasF "$1" "$2"; then ok "$3"; else fail "$3 (not found in $2)"; fi; }
exists() { if [ -e "$1" ]; then ok "$2"; else fail "$2 ($1 missing)"; fi; }
count() { grep -cE -- "$1" "$2" 2>/dev/null || true; }
want_count() { local n; n=$(count "$1" "$2"); if [ "${n:-0}" -eq "$3" ]; then ok "$4 ($n)"; else fail "$4: $n, want $3"; fi; }

# A jest suite list, run once; the log is kept for a failure.
jest_ok() {
  local label="$1"; shift
  local log="$LOGS/jest-$(echo "$label" | tr -c 'a-z0-9' '-').log"
  ( cd middleware && npx jest "$@" --maxWorkers=2 ) >"$log" 2>&1
  if [ $? -eq 0 ]; then ok "$label: $(grep -E '^Tests:' "$log" | tail -1)"; else fail "$label: $(grep -E '^Tests:' "$log" | tail -1) (see $log)"; grep -E '✕' "$log" | head -8 | sed 's/^/      /'; fi
}

T=interviews
ROLES=(recruiter interviewer hiring-manager)
ACTIONS=(ViewInterviews ManageCandidates AssignInterviews ConductInterview DecideCandidate)
CAST=(u-greta u-hugo u-wen u-amara)
CAST_NAMES=("Greta Lindqvist" "Hugo Marchetti" "Wen Zhao" "Amara Okafor")
MW=middleware/src
PAGES=portal/src/pages/interviews

# The ledger (docs/interviews-tenant-plan.md "Ledger"): id|phase|title.
ROWS=(
  "I0.1|I0|the judge, with --quick and --phase, phases nesting"
  "I0.2|I0|registration: manifest, Cedar, actions, rank, mount, channels, labels, voice, flags, nav, picker, colours, inventory"
  "I0.3|I0|the model: schema, the in-memory store and the SQL store behaving the same"
  "I0.4|I0|the cast and the seed story in the mock world"
  "I0.5|I0|read routes and the permission matrix"
  "I0.6|I0|spend source interviews and how an opening carries a cap"
  "I0.7|I0|spike: how the code pad is carried and walked; a guest's seat"
  "I1.1|I1|Candidates table"
  "I1.2|I1|candidate profile with the stage tracker and the rounds list"
  "I1.3|I1|openings and the kit editor"
  "I1.4|I1|assign a round; the bell; My interviews; accept or decline"
  "I1.5|I1|a date-and-time field; the time on an interview; Upcoming"
  "I1.6|I1|résumé upload and a PDF viewer"
  "I1.7|I1|Prepare page"
  "I1.8|I1|behavioural rounds"
  "I2.1|I2|invite token and the guest identity"
  "I2.2|I2|lobby family, admission, a guest seat, the channel guard"
  "I2.3|I2|portal: landing, notice and consents, device check, waiting room"
  "I2.4|I2|the interview room for both sides"
  "I2.5|I2|declined consent"
  "I2.6|I2|recording only with consent; panel-only playback"
  "I2.7|I2|panel seats"
  "I3.1|I3|a policy seam in the meeting assistant"
  "I3.2|I3|the interviews policy"
  "I3.3|I3|the coach with a scripted stand-in; the suggestion log"
  "I3.4|I3|the footer prompt"
  "I3.5|I3|Milo asks aloud"
  "I3.6|I3|Milo for you"
  "I3.7|I3|the live transcript, panel side only"
  "I3.8|I3|the candidate's two fixed requests"
  "I3.9|I3|what an interview costs; a listener on Amazon Transcribe"
  "I3.10|I3|the coach drafts a question plan"
  "I4.1|I4|library: a collaborative code editor"
  "I4.2|I4|the pad in the room"
  "I4.3|I4|the pad log"
  "I4.4|I4|the run interface, queue, mock executor and output"
  "I4.5|I4|the coach reads the pad and the last run"
  "I4.6|I4|design: the real backends"
  "I5.1|I5|the interview record page"
  "I5.2|I5|the recap writer"
  "I5.3|I5|a rating input; the scorecard"
  "I5.4|I5|recruiter review and the debrief page"
  "I5.5|I5|the hiring manager's recap and the stage decision"
  "I5.6|I5|bells"
  "I6.1|I6|consent records and notice versions"
  "I6.2|I6|export"
  "I6.3|I6|retention sweeps and deletion on request"
  "I6.4|I6|settings per deployment"
  "E1|E|the whole journey in one pass"
  "E2|E|isolation walks"
  "E3|E|the DOM audit and the type-scale sweep over every new page"
  "E4|E|a read-only audit sweep and its repairs"
)
# A lane adds the rows it builds as a piece, never by editing this file: create
# scripts/validate-interviews.d/<row>.sh (e.g. I2.3.sh) that defines one function per row it judges, using the
# helpers above (ok, fail, need, needF, exists, want_count, jest_ok, run_journey, journey_step; $T, $MW, $PAGES,
# $QUICK are set), and registers each with one line: built_row I2.3 row_I2_3. A row not registered prints
# "not built". The row must already be in ROWS above. Pieces are sourced in name order.
BUILT=" "; ROWFNS=" "
built_row() { BUILT="$BUILT$1 "; ROWFNS="$ROWFNS$1=$2 "; }
row_fn() { local x="${ROWFNS#* $1=}"; echo "${x%% *}"; }

JOURNEY_LOG=""
run_journey() {
  [ -n "$JOURNEY_LOG" ] && return
  JOURNEY_LOG="$LOGS/journey.log"
  ( cd portal && node ../scripts/journeys/run-demo-moments.mjs --journey interviews --out "$LOGS/journey" ) >"$JOURNEY_LOG" 2>&1
}
journey_step() {
  if grep -q "^PASS $1:" "$JOURNEY_LOG" && ! grep -q "^FAIL $1:" "$JOURNEY_LOG"; then ok "walk step $1"; else fail "walk step $1 ($(grep -E "^(FAIL|PASS) $1:" "$JOURNEY_LOG" | head -1 | cut -c1-160))"; fi
}

for piece in scripts/validate-interviews.d/*.sh; do
  [ -f "$piece" ] && source "$piece"
done

printf 'validate-interviews: phase %s%s, logs in %s\n' "$PHASE" "$([ "$QUICK" -eq 1 ] && echo ', quick')" "$LOGS"
JUDGED=0; NOT_BUILT=0; LATER=0
CURRENT_PHASE=""
for entry in "${ROWS[@]}"; do
  id="${entry%%|*}"; rest="${entry#*|}"; ph="${rest%%|*}"; title="${rest#*|}"
  ROW="$id"
  if [ "$ph" != "$CURRENT_PHASE" ]; then printf '\n== phase %s ==\n' "$ph"; CURRENT_PHASE="$ph"; fi
  if [ "$(phase_rank "$ph")" -gt "$PR" ]; then printf '  - %s later phase: %s\n' "$id" "$title"; LATER=$((LATER + 1)); continue; fi
  if [[ "$BUILT" != *" $id "* ]]; then
    if [ "$FULL" -eq 1 ]; then fail "not built: $title"; else printf '  · %s not built: %s\n' "$id" "$title"; fi
    NOT_BUILT=$((NOT_BUILT + 1)); continue
  fi
  printf '  %s %s\n' "$id" "$title"
  JUDGED=$((JUDGED + 1))
  "$(row_fn "$id")"
done

echo
printf 'rows judged %d, not built %d, later phases %d; pending (not failing) %d\n' "$JUDGED" "$NOT_BUILT" "$LATER" "${#PENDING[@]}"
for p in "${PENDING[@]+"${PENDING[@]}"}"; do printf '  · %s\n' "$p"; done
if [ "${#FAILS[@]}" -eq 0 ]; then
  echo "ALL CHECKS PASS"
  exit 0
fi
printf '%d FAILING:\n' "${#FAILS[@]}"
for f in "${FAILS[@]}"; do printf '  ✗ %s\n' "$f"; done
exit 1
