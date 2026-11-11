// What a simulated run hands back when it ends (docs/learning-loop-design.md §1,
// "Mock"): a small set of fixtures keyed by the work item's labels, so a
// dispatch on the mock stores a real run report and the rest of the loop
// (distiller, offer, evidence) has something to act on.
//
// Each fixture is what a worker would send: a final message ending in a
// `lab-report` block (read back by the same tolerant parser a real run's goes
// through) and the skills its session loaded. In the Halyard story's voice:
// what the run did and what got in its way, no filler, no record ids.
// scripts/content/check-story.mjs scans every text here.
//
//   teaches   a run that hit something no runbook covers (the logout cookie)
//   used      a run that loaded a runbook it was given and finished well with it
//   nothing   a run that needed nothing (the default)
//   failed    a run that stopped before changing anything
//
// Lane C: each also says what it learned (`learned`, '' for nothing) and what it did with the
// runbooks it was given (`runbooks`). Only `teaches` earns a debrief, which the mock plays from
// the hand-written folder in mock/debrief-fixtures.ts.

export interface SimulatedRunFixture {
  key: 'teaches' | 'used' | 'nothing' | 'failed';
  outcome: 'done' | 'failed';
  failureCode: string | null;
  /** Skill names the session loaded (observed use). */
  skillsLoaded: string[];
  summary: string;
  verification: Array<{ command: string; passed: boolean }>;
  obstacles: string[];
  /** Lane C: the one sentence of what a written procedure would have saved the run ('' for nothing). */
  learned: string;
  /** Lane C: what the run said of each runbook it was given. */
  runbooks: Array<{ id: string; followed: 'yes' | 'partly' | 'no'; wrongStep?: number; note?: string }>;
}

const LOGOUT_RUNBOOK = 'rb-logout-shim-cookie';

interface ItemLike { title: string; labels: readonly string[]; projectId?: string | null; type?: string | null }

const FIXTURES: Array<{ when: (w: ItemLike) => boolean; build: (w: ItemLike) => SimulatedRunFixture }> = [
  {
    when: (w) => w.labels.includes('latency') && (w.projectId === 'p-inference-platform' || /cold.start/i.test(w.title)),
    build: () => ({
      key: 'failed', outcome: 'failed', failureCode: 'needs_gpu_pool', skillsLoaded: [],
      summary: 'Stopped before changing anything: reproducing the cold start needs a GPU node pool that scales to zero, and the test account has none.',
      verification: [{ command: 'npm test -- cold-start', passed: false }],
      obstacles: ['The cold-start test waits for a GPU node to report ready and times out after ten minutes. There is no way round it without a node pool, so the run stopped rather than ship a fix it could not measure.'],
      learned: 'Reproducing the cold start needs a GPU node pool that scales to zero, which the test account does not have.',
      runbooks: [],
    }),
  },
  {
    when: (w) => w.labels.includes('session'),
    build: () => ({
      key: 'teaches', outcome: 'done', failureCode: null, skillsLoaded: [],
      summary: 'Logout now clears the legacy shim cookie on the parent domain as well as the app\'s own. The fix deletes it with the same Domain and Path the shim used when it set it.',
      verification: [{ command: 'npm test', passed: true }, { command: 'npx playwright test logout', passed: true }],
      obstacles: [
        'Deleting the cookie by name alone did nothing: a browser only removes a cookie when Domain and Path match the ones it was set with. Read both from the shim\'s Set-Cookie header and matched them.',
        'The first test ran on a local origin with no parent domain, so it could not see the bug. Added a case that sets the cookie on the parent domain before logging out.',
      ],
      learned: 'Clearing a cookie another service set takes its exact Domain and Path from that service\'s Set-Cookie header, and a test on a local origin cannot see the bug.',
      runbooks: [],
    }),
  },
  {
    when: (w) => w.projectId === 'p-auth-migration' && (w.labels.includes('runbook') || /cutover/i.test(w.title)),
    build: () => ({
      key: 'used', outcome: 'done', failureCode: null, skillsLoaded: ['rb-tenant-cutover'],
      summary: 'Wrote the tenant-by-tenant cutover plan with the tenant cutover runbook: sign-in checked on the shim before each tenant moves, one tenant at a time, and a rollback rehearsed on the first.',
      verification: [{ command: 'npm test', passed: true }, { command: 'npm run lint', passed: true }],
      obstacles: ['The rollback rehearsal failed on one test tenant because its SAML app had been switched off. Switched it back on for the rehearsal and added a check for it to the plan.'],
      learned: '',
      runbooks: [{ id: 'rb-tenant-cutover', followed: 'yes' }],
    }),
  },
];

/**
 * The fixture a simulated run of this work item ends with. `given` is the runbooks its brief
 * offered: a run that needed nothing says, of each, that it did not follow it (how a runbook given
 * to runs that never use it comes up for retirement).
 */
export function simulatedRunFixture(item: ItemLike, given: readonly string[] = []): SimulatedRunFixture {
  // Lane E4: a session-cookie item whose brief gave the runbook the logout run wrote follows it, and
  // learns nothing new (so it earns no second debrief). Another runbook it was given is not followed.
  if (item.labels.includes('session') && given.includes(LOGOUT_RUNBOOK)) {
    return {
      key: 'used', outcome: 'done', failureCode: null, skillsLoaded: [LOGOUT_RUNBOOK],
      summary: 'Revoking a grant now clears the session cookie on the app domain and on the legacy shim domain, using the logout runbook: the shim cookie is deleted with the same Domain and Path it was set with.',
      verification: [{ command: 'npm test', passed: true }, { command: 'npx playwright test refresh', passed: true }],
      obstacles: [],
      learned: '',
      runbooks: given.map((id) => (id === LOGOUT_RUNBOOK
        ? { id, followed: 'yes' as const }
        : { id, followed: 'no' as const, note: 'The change did not need it.' })),
    };
  }
  for (const f of FIXTURES) if (f.when(item)) return f.build(item);
  return {
    key: 'nothing', outcome: 'done', failureCode: null, skillsLoaded: [],
    summary: `Worked "${item.title}" end to end. The change was small and followed patterns already in the repository.`,
    verification: [{ command: 'npm test', passed: true }],
    obstacles: [],
    learned: '',
    runbooks: given.map((id) => ({ id, followed: 'no' as const, note: 'The change did not need it.' })),
  };
}

/** The final message a worker would have written: a line of prose, then the lab-report block. */
export function simulatedFinalMessage(f: SimulatedRunFixture): string {
  const block = JSON.stringify({
    summary: f.summary, verification: f.verification, obstacles: f.obstacles, learned: f.learned, runbooks: f.runbooks,
  }, null, 2);
  return `${f.outcome === 'failed' ? 'I could not finish this.' : 'Done.'}\n\n\`\`\`lab-report\n${block}\n\`\`\`\n`;
}

/** Every fixture's text, for scripts/content/check-story.mjs. */
export function simulatedRunTexts(): Array<{ key: string; text: string }> {
  const samples: ItemLike[] = [
    { title: 'Cold-start p99 breaches SLA after scale-to-zero', labels: ['latency'], projectId: 'p-inference-platform' },
    { title: 'Logout leaves the legacy shim cookie alive', labels: ['session', 'decom'] },
    { title: 'Tenant-by-tenant cutover runbook with rollback', labels: ['decom', 'runbook', 'blocked'], projectId: 'p-auth-migration' },
    { title: 'Error-budget dashboard per team', labels: ['slo'] },
  ];
  const withLogout: Array<{ w: ItemLike; given: string[] }> = [{ w: { title: 'Refresh loop when a grant is revoked mid-session', labels: ['session'] }, given: [LOGOUT_RUNBOOK] }];
  const more = withLogout.flatMap(({ w, given }) => {
    const f = simulatedRunFixture(w, given);
    return [f.summary, ...f.obstacles, ...f.verification.map((v) => v.command)].map((text) => ({ key: 'used-logout', text }));
  });
  return [...more, ...samples.flatMap((w) => {
    const f = simulatedRunFixture(w);
    return [f.summary, ...f.obstacles, ...f.verification.map((v) => v.command), ...(f.learned ? [f.learned] : [])].map((text) => ({ key: f.key, text }));
  })];
}
