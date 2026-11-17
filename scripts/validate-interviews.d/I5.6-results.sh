# The result bells of row I5.6 (scorecard due, scorecard in, decided): hardening lane H4's half. This piece registers nothing;
# it defines the function H1's I5.6.sh calls when it is present (guarded with `declare -F row_I5_6_results`).

row_I5_6_results() {
  local bells=$MW/lib/interviews/result-bells.ts
  exists $bells "the result bells"
  needF "export async function interviewEnded" $bells "scorecard due"
  needF "export async function scorecardSubmitted" $bells "scorecard in"
  needF "export async function stageDecided" $bells "decided"
  # No bell carries the candidate: no name, rating, recommendation, reason or recap text is read into a title or a body.
  if grep -nE "candidate\\.name|candidateName|\\.reason|\\.summary|recommendation|ratings|recap" $bells | grep -vE "^[0-9]+:\\s*(//|\\*|/\\*)" >/dev/null; then fail "a bell reads the candidate, a rating, a reason or a recap into its words"; else ok "no bell reads a candidate name, rating, recommendation, reason or recap"; fi
  if [ "$QUICK" -eq 0 ]; then
    run_journey
    for s in I5.6r-a I5.6r-b I5.6r-c; do journey_step "$s"; done
  fi
}
