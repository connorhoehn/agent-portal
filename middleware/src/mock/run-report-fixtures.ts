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

export interface SimulatedRunFixture {
  key: 'teaches' | 'used' | 'nothing' | 'failed';
  outcome: 'done' | 'failed';
  failureCode: string | null;
  /** Skill names the session loaded (observed use). */
  skillsLoaded: string[];
  summary: string;
  verification: Array<{ command: string; passed: boolean }>;
  obstacles: string[];
}

interface ItemLike { title: string; labels: readonly string[]; projectId?: string | null; type?: string | null }

const FIXTURES: Array<{ when: (w: ItemLike) => boolean; build: (w: ItemLike) => SimulatedRunFixture }> = [
  {
    when: (w) => w.labels.includes('latency') && (w.projectId === 'p-inference-platform' || /cold.start/i.test(w.title)),
    build: () => ({
      key: 'failed', outcome: 'failed', failureCode: 'needs_gpu_pool', skillsLoaded: [],
      summary: 'Stopped before changing anything: reproducing the cold start needs a GPU node pool that scales to zero, and the test account has none.',
      verification: [{ command: 'npm test -- cold-start', passed: false }],
      obstacles: ['The cold-start test waits for a GPU node to report ready and times out after ten minutes. There is no way round it without a node pool, so the run stopped rather than ship a fix it could not measure.'],
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
    }),
  },
  {
    when: (w) => w.projectId === 'p-observability' && (w.labels.includes('finops') || w.labels.includes('metrics')),
    build: (w) => ({
      key: 'used', outcome: 'done', failureCode: null, skillsLoaded: ['rb-flaky-test-rerun-diff'],
      summary: `Worked "${w.title}" in the collector pipeline config and the processor that enforces it.`,
      verification: [{ command: 'npm test', passed: true }, { command: 'npm run lint', passed: true }],
      obstacles: ['The collector integration test failed on the first run. Followed the flaky-test runbook: reran it and compared the two outputs, which differed only in timing, so it was flaky rather than a regression.'],
    }),
  },
];

/** The fixture a simulated run of this work item ends with. */
export function simulatedRunFixture(item: ItemLike): SimulatedRunFixture {
  for (const f of FIXTURES) if (f.when(item)) return f.build(item);
  return {
    key: 'nothing', outcome: 'done', failureCode: null, skillsLoaded: [],
    summary: `Worked "${item.title}" end to end. The change was small and followed patterns already in the repository.`,
    verification: [{ command: 'npm test', passed: true }],
    obstacles: [],
  };
}

/** The final message a worker would have written: a line of prose, then the lab-report block. */
export function simulatedFinalMessage(f: SimulatedRunFixture): string {
  const block = JSON.stringify({ summary: f.summary, verification: f.verification, obstacles: f.obstacles }, null, 2);
  return `${f.outcome === 'failed' ? 'I could not finish this.' : 'Done.'}\n\n\`\`\`lab-report\n${block}\n\`\`\`\n`;
}

/** Every fixture's text, for scripts/content/check-story.mjs. */
export function simulatedRunTexts(): Array<{ key: string; text: string }> {
  const samples: ItemLike[] = [
    { title: 'Cold-start p99 breaches SLA after scale-to-zero', labels: ['latency'], projectId: 'p-inference-platform' },
    { title: 'Logout leaves the legacy shim cookie alive', labels: ['session', 'decom'] },
    { title: 'Metric cardinality budgets', labels: ['finops', 'metrics'], projectId: 'p-observability' },
    { title: 'Error-budget dashboard per team', labels: ['slo'] },
  ];
  return samples.flatMap((w) => {
    const f = simulatedRunFixture(w);
    return [f.summary, ...f.obstacles, ...f.verification.map((v) => v.command)].map((text) => ({ key: f.key, text }));
  });
}
