// The pricing authority for agent runs, and the claim policy for the machines
// that run them. Both modules are pure on purpose — these are refusals and
// overrides, and a refusal that can only be exercised by standing up a database
// and a laptop is a refusal nobody tests.
//
// Every number asserted here was measured, on 2026-09-11, against a Homebrew
// llama-server on 127.0.0.1:8080 serving Qwen3.6-35B-A3B, driven by Claude Code
// 2.1.236. The two producer bugs this file pins are the reason the module exists:
// a reported cost that is silently read as zero, and a reported cost that is a
// confident non-zero lie.

import {
  asModelProvider, parseReportedCost, resolveRunCost, resultEventSucceeded, resultEventError, resultEventFailureCode,
  type ModelProvider,
} from '../run-cost.js';
import {
  decideClaim, allowedKinds, capConcurrency, LOCAL_JOB_KINDS, LOCAL_MAX_CONCURRENCY,
} from '../local-work.js';

describe('parseReportedCost — silence is not zero', () => {
  it('keeps a reported 0, because "the run cost nothing" is a real claim', () => {
    // Claude Code says exactly this on a pre-flight API error. Collapsing it into
    // the same value as "no figure arrived" is what erased the distinction this
    // module exists to preserve.
    expect(parseReportedCost({ total_cost_usd: 0 })).toBe(0);
  });

  it('reads absent, null and non-numeric as null — never as 0', () => {
    for (const raw of [undefined, null, 'free', Number.NaN, Number.POSITIVE_INFINITY]) {
      expect([raw, parseReportedCost({ total_cost_usd: raw })]).toEqual([raw, null]);
    }
    // The key missing entirely is the commonest shape of all.
    expect(parseReportedCost({})).toBeNull();
  });

  it('does not let a falsy non-number coerce its way into a reported zero', () => {
    // `Number('')`, `Number([])` and `Number(false)` are all 0, so the obvious
    // `Number(raw ?? 0)` reads an EMPTY field as the positive claim "this run
    // cost nothing". For a Bedrock run that is the difference between
    // `cost_usd = NULL` and `cost_usd = 0` — "burn unknown" versus "free" — in
    // an initiative's spend rollup, which is the exact failure this module was
    // written to fix, reappearing inside the fix.
    for (const raw of ['', '   ', [], false, {}]) {
      expect([raw, parseReportedCost({ total_cost_usd: raw })]).toEqual([raw, null]);
    }
  });

  it('parses a numeric string, because JSON from a worker is not always typed', () => {
    expect(parseReportedCost({ total_cost_usd: '0.003711' })).toBe(0.003711);
  });

  it('treats a negative charge as absent — there is no reading of it that belongs in a rollup', () => {
    expect(parseReportedCost({ total_cost_usd: -1 })).toBeNull();
  });
});

describe('asModelProvider — validated, not cast', () => {
  it('accepts exactly the three the schema knows', () => {
    for (const p of ['bedrock', 'local', 'simulated']) {
      expect(asModelProvider(p)).toBe(p);
    }
  });

  it('reads anything else as not-recorded rather than storing it', () => {
    // Both call sites are outside this process — a JSONB column written by
    // whatever executed the job, and a completion body posted by a laptop. A
    // stored `firstParty` would be matched by nothing and counted by nothing.
    for (const junk of ['firstParty', 'LOCAL', 'anthropic', '', null, undefined, 42, {}]) {
      expect([junk, asModelProvider(junk)]).toEqual([junk, null]);
    }
  });
});

describe('resolveRunCost', () => {
  it('prices a local run at a confident 0 and overrides the measured lie', () => {
    // 1227 in / 2 out on loopback, reported as 0.003711 with
    // `provider: "firstParty"` — exactly Anthropic Sonnet 4.5 list price, for a
    // run that spent nothing. Non-zero and authoritative-looking is worse than
    // the silent zero: it bills an allocation and trips all three money brakes.
    const cost = resolveRunCost('local', 0.003711);
    expect(cost.costUsd).toBe(0);
    expect(cost.provider).toBe('local');
    expect(cost.note).toBe('run reported $0.003711; recorded $0 — served by local inference');
  });

  it('adds no note when there was nothing to override', () => {
    // A note beside an uncontested figure is noise, and noise in a transcript
    // gets learned as ignorable — which is how the notes that matter stop being
    // read. Nothing reported, and a reported 0, agree with the recorded 0.
    expect(resolveRunCost('local', null)).toEqual({ costUsd: 0, provider: 'local', note: undefined });
    expect(resolveRunCost('local', 0).note).toBeUndefined();
  });

  it('records local burn as 0 rather than null — the two are opposite claims', () => {
    // `null` means "we do not know what this cost". For local inference we do
    // know: the marginal cost of a token on hardware the org already owns is
    // nothing, and that is the feature's whole value proposition. Recording null
    // would make local work indistinguishable from unmetered work, and the
    // maintenance floor would never visibly drop.
    expect(resolveRunCost('local', null).costUsd).toBe(0);
    expect(resolveRunCost('bedrock', null).costUsd).toBeNull();
  });

  it('leaves a cloud run\'s reported figure alone, present or absent', () => {
    for (const provider of ['bedrock', 'simulated'] as ModelProvider[]) {
      expect(resolveRunCost(provider, 1.25)).toEqual({ costUsd: 1.25, provider });
      // Absence stays absence. This is the null-vs-zero rule the attribution
      // schema states outright: degrade to "burn unknown", never "burn zero".
      expect(resolveRunCost(provider, null)).toEqual({ costUsd: null, provider });
      expect(resolveRunCost(provider, 0)).toEqual({ costUsd: 0, provider });
    }
  });

  it('always records a provider, so a wrong number stays selectable later', () => {
    for (const provider of ['bedrock', 'local', 'simulated'] as ModelProvider[]) {
      expect(resolveRunCost(provider, null).provider).toBe(provider);
    }
  });
});

describe('resultEventSucceeded — is_error outranks subtype', () => {
  /** The exact envelope a hard API failure produced, measured. */
  const measuredApiFailure = {
    is_error: true,
    terminal_reason: 'api_error',
    api_error_status: 400,
    subtype: 'success',
    total_cost_usd: 0,
    num_turns: 1,
    result: 'API Error (400 Bad Request): 400 The provided model identifier is invalid..',
  };

  it('reads the measured failure as a failure, despite subtype: success', () => {
    // `claude -p` also exits 0 here, so the downstream exit-code check does not
    // catch it either. Read on subtype alone, this recorded a run that never
    // reached a model as a $0 success — and `requiresReview` then parked it in
    // awaiting_review, asking a human to accept an artifact never produced.
    expect(resultEventSucceeded(measuredApiFailure)).toBe(false);
  });

  it('still accepts a genuine success', () => {
    expect(resultEventSucceeded({ subtype: 'success', total_cost_usd: 0.01 })).toBe(true);
    expect(resultEventSucceeded({ subtype: 'success', is_error: false })).toBe(true);
  });

  it('reads a missing or non-success subtype as failure', () => {
    for (const ev of [{}, { subtype: 'error_max_turns' }, { subtype: '' }, { subtype: null }]) {
      expect([ev, resultEventSucceeded(ev)]).toEqual([ev, false]);
    }
  });

  it('does not treat a non-boolean is_error as a failure signal', () => {
    // Only `=== true` counts. A truthy string would otherwise let a producer
    // quirk fail every run in the fleet.
    expect(resultEventSucceeded({ subtype: 'success', is_error: 'false' })).toBe(true);
  });

  it('names the failure with the reason, status and text — not "failed"', () => {
    expect(resultEventError(measuredApiFailure)).toBe(
      'api_error: status 400: API Error (400 Bad Request): 400 The provided model identifier is invalid..',
    );
  });

  it('keeps the structured code independent of the failure prose', () => {
    expect(resultEventFailureCode(measuredApiFailure)).toBe('api_error');
    expect(resultEventFailureCode({ ...measuredApiFailure, terminal_reason: 'NEEDS_GPU_POOL', result: 'A different detail' })).toBe('needs_gpu_pool');
    expect(resultEventFailureCode({ subtype: 'success', terminal_reason: 'api_error' })).toBeUndefined();
  });

  it.each([undefined, null, {}, 42, '', 'needs a GPU', 'api_error\n', 'a'.repeat(81)])(
    'leaves an invalid structured reason to legacy error classification: %j', (terminal_reason) => {
      expect(resultEventFailureCode({ ...measuredApiFailure, terminal_reason })).toBeUndefined();
    },
  );

  it('accepts a reason at the report code length limit', () => {
    expect(resultEventFailureCode({ ...measuredApiFailure, terminal_reason: 'a'.repeat(80) })).toBe('a'.repeat(80));
  });

  it('says something useful even when the event carries no detail', () => {
    expect(resultEventError({ subtype: 'error_max_turns' })).toBe('run reported error_max_turns');
    expect(resultEventError({})).toBe('run reported failure');
  });

  it('returns undefined for a success — there is no error to record', () => {
    expect(resultEventError({ subtype: 'success' })).toBeUndefined();
  });

  it('truncates a runaway error body rather than storing it whole', () => {
    const err = resultEventError({ subtype: 'error', result: 'x'.repeat(5000) })!;
    expect(err.length).toBeLessThanOrEqual(601);
    expect(err.endsWith('…')).toBe(true);
  });
});

describe('capConcurrency — a ceiling, not a target', () => {
  it('caps at the server\'s own limit whatever the machine advertises', () => {
    // Two, because that is what the reference workstation's inference server
    // serves: llama-server runs `--parallel 2` with a unified KV cache, and a
    // third request does not fail — it queues. That is the expensive failure
    // mode, not a loud one: the queued run heartbeats, holds its claim, and blows
    // past the stale window having produced nothing, while evicting the other
    // runs' prompt prefix (measured ~30× on reuse) and slowing all of them.
    expect(LOCAL_MAX_CONCURRENCY).toBe(2);
    expect(capConcurrency(64)).toBe(LOCAL_MAX_CONCURRENCY);
    expect(capConcurrency(LOCAL_MAX_CONCURRENCY + 1)).toBe(LOCAL_MAX_CONCURRENCY);
  });

  it('honours a machine that asks for less', () => {
    expect(capConcurrency(1)).toBe(1);
  });

  it('lands unknown on 1 rather than on the ceiling', () => {
    // An unparseable capability is a machine we know nothing about, and the
    // conservative reading of "unknown" is one job. Landing on the ceiling would
    // mean a garbled registration got the most work.
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, 'lots', null, undefined, {}, []]) {
      expect([bad, capConcurrency(bad)]).toEqual([bad, 1]);
    }
  });

  it('floors a fractional advertisement rather than rounding it up', () => {
    expect(capConcurrency(1.9)).toBe(1);
    expect(capConcurrency(0.9)).toBe(1);
  });
});

describe('allowedKinds — the intersection is the trust boundary', () => {
  it('yields nothing for an empty advertisement, not everything', () => {
    // A worker that has registered no capability has none. Defaulting to the full
    // set would make the intersection decorative: the first thing a
    // half-configured worker did would be to claim work it cannot run.
    expect(allowedKinds([])).toEqual([]);
  });

  it('drops devbox:task, the kind almost everything enqueues', () => {
    expect(allowedKinds(['devbox:task'])).toEqual([]);
    expect(allowedKinds(['local:task', 'devbox:task'])).toEqual(['local:task']);
  });

  it('drops anything invented, however plausible', () => {
    expect(allowedKinds(['local:embed', 'local:', 'LOCAL:TASK', 'sudo:anything'])).toEqual([]);
  });

  it('orders by the SERVER\'s list and deduplicates', () => {
    // So a node cannot influence which kind it is offered first by reordering or
    // repeating its advertisement.
    expect(allowedKinds(['local:distill', 'local:task', 'local:task']))
      .toEqual(['local:task']);
    expect(allowedKinds([...LOCAL_JOB_KINDS])).toEqual([...LOCAL_JOB_KINDS]);
  });
});

describe('decideClaim', () => {
  const node = (over: Partial<{ acceptJobs: boolean; jobKinds: string[]; maxConcurrency: number }> = {}) => ({
    id: 'node-1',
    acceptJobs: true,
    jobKinds: ['local:task'] as string[],
    maxConcurrency: 2,
    ...over,
  });

  it('lets a switched-on, registered, idle machine through', () => {
    const v = decideClaim({ node: node(), liveJobs: 0, pullSideReady: true });
    expect(v).toEqual({ kind: 'proceed', kinds: ['local:task'], limit: 2 });
  });

  it('refuses a pre-migration cluster rather than granting an unfenced claim', () => {
    // Degrading to "claim it anyway without a token" would silently reintroduce
    // the overwrite the fence exists to prevent — a late completion from this
    // machine clobbering a newer attempt's result, with both runs billed — and it
    // would do so on exactly the clusters least likely to notice. Push-only is
    // how this behaved before local compute existed, so falling back is safe.
    const v = decideClaim({ node: node(), liveJobs: 0, pullSideReady: false });
    expect(v).toMatchObject({ kind: 'deny', status: 503, gate: 'migration' });
    expect(v.kind === 'deny' && v.reason).toMatch(/local_compute_worker_schema\.sql/);
  });

  it('checks the migration BEFORE anything the node said', () => {
    // A machine that is switched off on a pre-migration cluster has two problems,
    // and the one it cannot fix is the one worth reporting: told 'accept_jobs',
    // its owner flips a switch and the claim still fails.
    const v = decideClaim({
      node: node({ acceptJobs: false, jobKinds: [] }), liveJobs: 99, pullSideReady: false,
    });
    expect(v).toMatchObject({ gate: 'migration' });
  });

  it('refuses a machine whose owner has not switched it on', () => {
    const v = decideClaim({ node: node({ acceptJobs: false }), liveJobs: 0, pullSideReady: true });
    expect(v).toMatchObject({ kind: 'deny', status: 409, gate: 'accept_jobs' });
    // The refusal says what to DO. "409" on its own sends someone to the logs.
    expect(v.kind === 'deny' && v.reason).toMatch(/accept jobs/);
  });

  it('refuses a machine that advertised no runnable kind, and names the set', () => {
    for (const jobKinds of [[], ['devbox:task'], ['local:embed']]) {
      const v = decideClaim({ node: node({ jobKinds }), liveJobs: 0, pullSideReady: true });
      expect([jobKinds, v]).toEqual([jobKinds, expect.objectContaining({ status: 409, gate: 'kinds' })]);
      expect(v.kind === 'deny' && v.reason).toContain('local:task');
    }
  });

  it('refuses at the slot limit, and the limit is the CAPPED one', () => {
    const busy = decideClaim({ node: node(), liveJobs: 2, pullSideReady: true });
    expect(busy).toMatchObject({ kind: 'deny', status: 429, gate: 'concurrency' });
    expect(busy.kind === 'deny' && busy.reason).toBe(
      'already holding 2 of 2 job slot(s) — finish or release one first',
    );

    // A node advertising 64 is held to the server's ceiling here too, not to its
    // own claim — otherwise the cap could be lifted by asking.
    const greedy = decideClaim({ node: node({ maxConcurrency: 64 }), liveJobs: 2, pullSideReady: true });
    expect(greedy).toMatchObject({ gate: 'concurrency' });
    const oneSlot = decideClaim({ node: node({ maxConcurrency: 1 }), liveJobs: 1, pullSideReady: true });
    expect(oneSlot).toMatchObject({ gate: 'concurrency' });
  });

  it('reports the capped limit on the way through, so the worker sizes itself correctly', () => {
    const v = decideClaim({ node: node({ maxConcurrency: 64 }), liveJobs: 0, pullSideReady: true });
    expect(v).toEqual({ kind: 'proceed', kinds: ['local:task'], limit: LOCAL_MAX_CONCURRENCY });
  });

  it('never widens on anything the machine asserts — every field only narrows', () => {
    // The property that makes a bearer token on somebody's laptop an acceptable
    // credential for this surface: a node that lies gets LESS work. Asking for
    // every kind, unlimited concurrency and (implicitly) permission cannot beat
    // an owner's switch left off.
    const liar = decideClaim({
      node: { id: 'n', acceptJobs: false, jobKinds: ['local:task', 'devbox:task'], maxConcurrency: 999 },
      liveJobs: 0,
      pullSideReady: true,
    });
    expect(liar).toMatchObject({ kind: 'deny', gate: 'accept_jobs' });
  });

  it('gives every gate a distinct name, because two of them share a status', () => {
    // `accept_jobs` and `kinds` are both 409, and `concurrency`'s 429 is the
    // status the per-IP rate limiter also returns. The worker's response differs
    // per gate — sleep and retry, tell your owner, fix your registration, stop —
    // and it cannot be inferred from the status code.
    const gates = [
      decideClaim({ node: node(), liveJobs: 0, pullSideReady: false }),
      decideClaim({ node: node({ acceptJobs: false }), liveJobs: 0, pullSideReady: true }),
      decideClaim({ node: node({ jobKinds: [] }), liveJobs: 0, pullSideReady: true }),
      decideClaim({ node: node(), liveJobs: 2, pullSideReady: true }),
    ].map((v) => (v.kind === 'deny' ? v.gate : 'proceed'));
    expect(gates).toEqual(['migration', 'accept_jobs', 'kinds', 'concurrency']);
    expect(new Set(gates).size).toBe(gates.length);
  });
});
