// The Distillation demo's progress line (pure; node:test).
//
// The demo is a mock scenario (middleware/src/mock/distillation-demo.ts,
// docs/distillation-demo.md): `POST /api/__mock/scenario
// {"scenario":"distillation-demo"}` starts a timed director, and
// `GET /api/__mock/state` reports where it has got to as `distillationDemo`.
// Both routes 404 outside a non-production mock server, which is how the
// landing knows to hide the control entirely. This module turns that state
// into one sentence and the one place to look next.

import { knowledgeHref, knowledgeItemHref, reviewHref, activityHref } from './distillationRoutes.ts';

export const DEMO_SCENARIO = 'distillation-demo';

/** The slice of `GET /api/__mock/state` → `distillationDemo` this page reads. */
export interface DemoState {
  phase: 'idle' | 'writing' | 'compacting' | 'reviewing' | 'distilling' | 'publishing' | 'applying' | 'done' | 'stopped' | 'failed';
  notes: string[];
  notesTotal?: number;
  milestones: {
    patternsMinted: boolean;
    sampled: boolean;
    reviewed: boolean;
    guideMinted: boolean;
    published: boolean;
    applied: boolean;
  };
  guideId: string | null;
  openDecidedBy: 'person' | 'director' | null;
  errors: string[];
}

export interface MockStateResponse {
  scenario?: string;
  distillationDemo?: DemoState;
}

export interface DemoProgress {
  /** Is the story playing now (poll fast, offer Stop)? */
  playing: boolean;
  /** One sentence; null when nothing has been played. */
  line: string | null;
  tone: 'info' | 'success' | 'warning' | 'error' | 'neutral';
  /** Short status for the pill. */
  status: string;
  /** Where to look for this beat. */
  look: { label: string; href: string } | null;
}

const PLAYING: ReadonlySet<DemoState['phase']> = new Set(['writing', 'compacting', 'reviewing', 'distilling', 'publishing', 'applying']);

export function demoProgress(state: DemoState | null | undefined): DemoProgress {
  if (!state || state.phase === 'idle') {
    return { playing: false, line: null, tone: 'neutral', status: 'Not playing', look: null };
  }
  const playing = PLAYING.has(state.phase);
  const guide = state.guideId;
  const m = state.milestones;
  const total = state.notesTotal ?? state.notes.length;
  switch (state.phase) {
    case 'writing':
      return {
        playing, tone: 'info', status: 'Run notes',
        line: `Three Auth Migration lab sessions are writing run notes — ${Math.min(state.notes.length, total)} of ${total} so far.`,
        look: { label: 'Watch Run notes', href: knowledgeHref({ view: 'notes' }) },
      };
    case 'compacting':
      return {
        playing, tone: 'info', status: 'Compacting',
        line: 'A compaction pass is merging the story’s run notes into patterns.',
        look: { label: 'Watch Activity', href: activityHref({}) },
      };
    case 'reviewing':
      return {
        playing, tone: 'info', status: 'Review',
        line: m.sampled
          ? 'Reviewers are checking the new patterns. One is left for you: agree or disagree with it in Review.'
          : 'The new patterns are being sampled for review.',
        look: { label: 'Open Review', href: reviewHref({}) },
      };
    case 'distilling':
      return {
        playing, tone: 'info', status: 'Distilling',
        line: 'The patterns review agreed with are being distilled into a guide.',
        look: { label: 'Watch Activity', href: activityHref({}) },
      };
    case 'publishing':
      return {
        playing, tone: 'info', status: 'Publishing',
        line: m.guideMinted ? 'The new guide is a draft: it is being reviewed, then published.' : 'The new guide is being written.',
        look: guide ? { label: 'Open the guide', href: knowledgeItemHref(guide, 'L2') } : null,
      };
    case 'applying':
      return {
        playing, tone: 'info', status: 'In use',
        line: 'The published guide is being run by an agent session.',
        look: guide ? { label: 'Open the guide', href: knowledgeItemHref(guide, 'L2') } : null,
      };
    case 'done':
      return {
        playing: false, tone: 'success', status: 'Done',
        line: m.applied
          ? 'Done: the guide was published and an agent ran it. Its Runs tab and Sources show where it came from and where it went.'
          : 'Done.',
        look: guide ? { label: 'Open the guide', href: knowledgeItemHref(guide, 'L2') } : null,
      };
    case 'stopped':
      return { playing: false, tone: 'neutral', status: 'Stopped', line: 'The demo was stopped before it finished.', look: null };
    case 'failed':
      return {
        playing: false, tone: 'error', status: 'Failed',
        line: state.errors[0] ?? 'The demo stopped on an error.',
        look: null,
      };
    default:
      return { playing: false, line: null, tone: 'neutral', status: 'Not playing', look: null };
  }
}
