# Row I4.4: runs on the mock executor (lane H8). Sourced by scripts/validate-interviews.sh. The contract, service, store
# and route suites are the I4 floor (src/lib/interviews/runs, src/routes/__tests__/interviews-runs.test.ts); this piece adds
# the stream and money suites. O-252's guard: nothing under lib/interviews/runs can execute what it is given.
row_I4_4() {
  local RD=$MW/lib/interviews/runs
  needF "runsRouter.post('/interviews/:id/runs'" "$MW/routes/interviews/runs.ts" "the panel's five routes (start)"
  for p in "runsRouter.get('/interviews/:id/runs'," "runsRouter.get('/interviews/:id/runs/events'" "runsRouter.get('/interviews/:id/runs/:runId'" "runsRouter.post('/interviews/:id/runs/:runId/cancel'"; do
    needF "$p" "$MW/routes/interviews/runs.ts" "the panel's route ${p#runsRouter.}"
  done
  for p in "runsGuestRouter.post('/runs'," "runsGuestRouter.get('/runs'," "runsGuestRouter.get('/runs/events'" "runsGuestRouter.get('/runs/:runId'" "runsGuestRouter.post('/runs/:runId/cancel'"; do
    needF "$p" "$MW/routes/interview-invite-runs.ts" "the candidate's route ${p#runsGuestRouter.}"
  done
  # Nothing a person types is executed: no process, vm, worker, network or dynamic-code import anywhere in the runs code.
  local hits; hits=$(grep -rnE "from 'node:(child_process|vm|worker_threads|net|http|https|dgram|tls|cluster|inspector)'|from '(child_process|vm|worker_threads|net|http|https|dgram|tls|cluster)'|require\(['\"](node:)?(child_process|vm|worker_threads|net|http|https)['\"]\)|\beval\(|new Function\(|import\(\s*[a-zA-Z_]|\bfetch\(|execSync|spawnSync|\bspawn\(|\bexecFile\(" "$RD" --include=*.ts 2>/dev/null | grep -v '/__tests__/' | grep -vE '^\S+:[0-9]+:\s*(//|\*)' || true)
  if [ -z "$hits" ]; then ok "nothing under lib/interviews/runs can execute what it is given (no process, vm, worker, network or eval)"; else fail "lib/interviews/runs can reach something but the mock: $(echo "$hits" | head -2 | cut -c1-160)"; fi
  needF "readonly backend = 'mock';" "$RD/mock-executor.ts" "the only executor is the mock"
  local execs; execs=$(grep -rlE "implements Executor\b" "$MW" --include=*.ts 2>/dev/null | grep -v __tests__ || true)
  if [ "$execs" = "$RD/mock-executor.ts" ]; then ok "the mock is the one Executor in the middleware"; else fail "an Executor other than the mock: $execs"; fi
  needF 'never runs what it is given' "$RD/__tests__/mock-executor.test.ts" "the contract suite proves the mock never runs code"
  exists "$MW/routes/__tests__/interviews-runs-stream.test.ts" "the stream suite (O-253, O-255)"
  exists "$MW/routes/__tests__/interviews-runs-money.test.ts" "the money suite (O-254)"
  refuses_404 I4.4
  if [ "$QUICK" -eq 0 ]; then
    jest_ok "the runs' stream and money suites" src/routes/__tests__/interviews-runs-stream.test.ts src/routes/__tests__/interviews-runs-money.test.ts
    run_journey
    for s in a b c d e; do journey_step "I4.4$s"; done
  fi
}
built_row I4.4 row_I4_4
