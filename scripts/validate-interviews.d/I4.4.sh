# Row I4.4: runs on the mock executor (lane H8). Sourced by scripts/validate-interviews.sh. The contract, service, store
# and route suites are the I4 floor (src/lib/interviews/runs, src/routes/__tests__/interviews-runs.test.ts); this piece adds
# the stream and money suites. O-252's guard, amended for the Docker runner: only docker-process.ts can start a process,
# only the docker binary, with the hardened arguments it builds.
row_I4_4() {
  local RD=$MW/lib/interviews/runs
  needF "runsRouter.post('/interviews/:id/runs'" "$MW/routes/interviews/runs.ts" "the panel's five routes (start)"
  for p in "runsRouter.get('/interviews/:id/runs'," "runsRouter.get('/interviews/:id/runs/events'" "runsRouter.get('/interviews/:id/runs/:runId'" "runsRouter.post('/interviews/:id/runs/:runId/cancel'"; do
    needF "$p" "$MW/routes/interviews/runs.ts" "the panel's route ${p#runsRouter.}"
  done
  for p in "runsGuestRouter.post('/runs'," "runsGuestRouter.get('/runs'," "runsGuestRouter.get('/runs/events'" "runsGuestRouter.get('/runs/:runId'" "runsGuestRouter.post('/runs/:runId/cancel'"; do
    needF "$p" "$MW/routes/interview-invite-runs.ts" "the candidate's route ${p#runsGuestRouter.}"
  done
  # O-252, as amended for the Docker runner (I4.6 answer, "The Docker runner on a developer's machine"): exactly one
  # file under lib/interviews/runs starts a process, docker-process.ts; it starts only the docker binary, without a
  # shell, with the hardened argument list it builds; nothing anywhere in the runs code reaches a vm, a worker, the
  # network, eval or any other way of starting a process.
  local hits; hits=$(grep -rnE "from 'node:(vm|worker_threads|net|http|https|dgram|tls|cluster|inspector)'|from '(vm|worker_threads|net|http|https|dgram|tls|cluster)'|require\(['\"](node:)?(child_process|vm|worker_threads|net|http|https)['\"]\)|\beval\(|new Function\(|import\(\s*[a-zA-Z_]|\bfetch\(|execSync|spawnSync|\bexecFile\(" "$RD" --include=*.ts 2>/dev/null | grep -v '/__tests__/' | grep -vE '^\S+:[0-9]+:\s*(//|\*)' || true)
  if [ -z "$hits" ]; then ok "nothing under lib/interviews/runs reaches a vm, worker, network, eval or another way to start a process"; else fail "lib/interviews/runs can reach something it must not: $(echo "$hits" | head -2 | cut -c1-160)"; fi
  local spawners; spawners=$(grep -rlE "from '(node:)?child_process'" "$RD" --include=*.ts 2>/dev/null | grep -v '/__tests__/' || true)
  if [ "$spawners" = "$RD/docker-process.ts" ]; then ok "exactly one file under lib/interviews/runs can start a process: docker-process.ts"; else fail "files that can start a process: ${spawners:-none}"; fi
  local DP=$RD/docker-process.ts
  needF "export const DOCKER_BIN = 'docker';" "$DP" "the one spawner names only the docker binary"
  want_count "from 'node:child_process'" "$DP" 1 "it imports child_process once"
  needF "import { spawn } from 'node:child_process';" "$DP" "and takes only spawn from it (no exec, execFile or fork)"
  local calls; calls=$(grep -nE "\bspawn\(" "$DP" 2>/dev/null | grep -vE '^[0-9]+:\s*(//|\*)' || true)
  if [ -n "$calls" ] && ! echo "$calls" | grep -vq "spawn(DOCKER_BIN, "; then ok "every spawn in it starts DOCKER_BIN"; else fail "a spawn that is not spawn(DOCKER_BIN, ...): $(echo "$calls" | head -2 | cut -c1-140)"; fi
  local impl; impl=$(grep -nE "\bspawnImpl\(" "$DP" | grep -vE "spawnImpl\(DOCKER_BIN, docker(Run|Remove)Args\(" || true)
  if [ -z "$impl" ]; then ok "it hands the spawner only the two argument lists it builds (run, remove)"; else fail "a spawner call with another argument list: $(echo "$impl" | head -1 | cut -c1-140)"; fi
  needF "shell: false" "$DP" "no shell"
  for f in "'--rm'" "'--pull', 'never'" "'--init'" "'--network', 'none'" "'--read-only'" "'--cap-drop', 'ALL'" "'--security-opt', 'no-new-privileges'" "'--user', '65534:65534'" "'--pids-limit'" "'--memory-swap'" "'--cpus'" "'--log-driver', 'none'"; do
    needF "$f" "$DP" "the run's hardened flag $f"
  done
  if grep -qE "'(-v|--volume|--mount|--privileged|--cap-add|--device|--pid|--userns|--network=host|host)'" "$DP"; then fail "docker-process.ts names a mount, a privilege or the host network"; else ok "no host mount, added privilege or host network in the run's arguments"; fi
  needF "if (!DOCKER_IMAGES.includes(spec.image))" "$DP" "the image must be on the allowlist"
  needF "if (!SCRIPTS.has(spec.script))" "$DP" "the script must be on the allowlist"
  needF "readonly backend = 'mock';" "$RD/mock-executor.ts" "the mock executor is still there"
  local execs; execs=$(grep -rlE "implements Executor\b" "$MW" --include=*.ts 2>/dev/null | grep -v __tests__ | sort | tr '\n' ' ' || true)
  if [ "$execs" = "$RD/agentcore-executor.ts $RD/docker-executor.ts $RD/mock-executor.ts " ]; then ok "the middleware's Executors are the mock, the Docker runner and the AgentCore interpreter"; else fail "Executors in the middleware: $execs"; fi
  needF "if (raw === 'docker') {" "$RD/select.ts" "the Docker runner only by INTERVIEWS_RUN_BACKEND=docker"
  needF "if (env['NODE_ENV'] === 'production') throw" "$RD/select.ts" "a production process never gets the Docker runner"
  needF 'exactly the hardened argument list' "$RD/__tests__/docker-executor.test.ts" "the runner's suite proves the argument list, the allowlist, the timers, cancel and truncation"
  needF 'only docker-process.ts can start a process' "$RD/__tests__/docker-executor.test.ts" "the runner's suite holds the one-spawner rule too"
  exists "$RD/__tests__/docker-executor.real.test.ts" "the real-Docker suite (REAL_DOCKER_RUNS=1)"
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
