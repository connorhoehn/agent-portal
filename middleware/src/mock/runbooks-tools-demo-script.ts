// The script of the skills demo (mock/runbooks-tools-demo.ts): who does what,
// in which beat, and the words they use.
//
// The story, in one paragraph. Vera Green sends Basil, an agent, at the
// refresh loop on Auth Migration: when a grant is revoked mid-session, the
// portal reconnects its realtime socket over and over. Basil cannot see why
// from the logs, so it writes a small harness that watches the page's
// websocket frames over the Chrome DevTools Protocol, records a capture, and
// keeps the harness in `.lab/keep/rb-ws-cdp-debug/` with a replayable sample.
// At the end of the run the capture path proposes it as a new skill, script
// and data included. Nora DaSilva, an SME on Auth Migration, reads the
// procedure and the file diff and accepts it into the org's skill library.
// The library's hash moves. The next morning Eli Garcia sends Dex at a bug on
// a different initiative — duplicate alerts on Observability — and Dex's box
// boots with the new skill installed beside every other one, lists it, and
// runs the harness from it.
import { CDP_RUNBOOK_ID } from './runbook-bundles.js';

export const SKILL_ID = CDP_RUNBOOK_ID;

export const CAST = {
  vera: { user: 'u-vera', person: 'p-002', name: 'Vera Green' },
  nora: { user: 'u-nora', person: 'p-004', name: 'Nora DaSilva' },
  eli: { user: 'u-eli', person: 'p-011', name: 'Eli Garcia' },
} as const;

export interface ToolsDemoRun {
  agent: 'Basil' | 'Dex';
  runRef: string;
  sessionId: string;
  workItemId: string;
  /** Who sent the agent (person id). */
  by: string;
  startBeat: number;
}

/** Basil builds the harness on Auth Migration; Dex, on Observability, is given it. */
export const BUILD_RUN: ToolsDemoRun = { agent: 'Basil', runRef: 'run-basil-refresh-loop-ws', sessionId: 'sess-basil-refresh-loop-ws', workItemId: 'wi-auth-e1-b4', by: CAST.vera.person, startBeat: 1 };
export const USE_RUN: ToolsDemoRun = { agent: 'Dex', runRef: 'run-dex-duplicate-alerts', sessionId: 'sess-dex-duplicate-alerts', workItemId: 'wi-obs-e2-b4', by: CAST.eli.person, startBeat: 12 };

/** Beats after the story starts. */
export const BEATS = { keep: 4, propose: 5, open: 7, accept: 9 } as const;

export const REVIEW_NOTE = 'Yes. Every realtime team has wanted this; the replay check means anyone can trust it offline.';

/** What the box prints when the harness runs from the installed skill (the bundled verify step's last line). */
export const RAN_OK = 'replay-ok';

export function beatMs(): number {
  for (const name of ['RUNBOOKS_DEMO_PACE_MS', 'DEMO_PACE_MS']) {
    const raw = process.env[name];
    if (raw !== undefined && raw !== '') {
      const n = Number(raw);
      if (Number.isFinite(n) && n >= 0) return n;
    }
  }
  return process.env['NODE_ENV'] === 'test' ? 0 : 10_000;
}
