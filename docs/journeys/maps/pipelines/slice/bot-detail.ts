import type { JourneyMap, Target } from '../../../../../scripts/journeys/journey-map.ts';

// The cross-tenant slice (PROTOCOL "Plus one cross-tenant slice log"): a maintenance bot's cron firing, read on the
// org workspace's bot page through the orgiq /api/runs façade, rendered as Run → Steps → Artifact → Events.
const BOT = '/admin/bots/32970d0a-e28e-5100-8fb0-a5cbb87dac99';
const rows = (testId: string): Target => ({ css: 'tbody tr', within: { testId } });

export default {
  family: 'pipelines', log: 'slice/bot-detail', kind: 'slice', scenario: 'shared',
  persona: { user: 'u-nora', name: 'Nora DaSilva', tenant: 'orgiq', role: 'sme' },
  goal: 'Nora (orgiq sme) opens the obs-nightly-maintenance bot and reads its latest cron firing as a pipeline run: the run, its steps, what it produced and its events',
  fields: { surface: 'bot-detail (slice)', pages: 'portal/src/pages/bots/BotDetailPage.tsx,portal/src/components/runs/PipelineRunParts.tsx,portal/src/components/runs/RunTimeline.tsx,portal/src/lib/pipelineRuns.ts' },
  claims: { 'run-rendered': 'yes', 'steps-rendered': '3+ (at least three step rows)', 'artifact-rendered': 'yes', 'events-streamed': 'yes', 'empty-state': 'n/a — every seeded bot has firings, and no mock scenario is switched on the shared stack' },
  steps: [
    { do: 'navigate', url: BOT, name: 'Open the obs-nightly-maintenance bot: the Runs tab shows its latest firing as a pipeline run', proves: 'run-rendered', expect: { visible: [{ role: 'heading', level: 1 }, { testId: 'pipeline-run' }] } },
    { do: 'wait', target: { testId: 'pipeline-steps' }, name: 'The firing’s steps render as rows', proves: 'steps-rendered', audit: false, auditReason: 'the same resting state the first step measured', expect: { count: [{ target: rows('pipeline-steps'), min: 3 }] } },
    { do: 'wait', target: { testId: 'pipeline-artifacts' }, name: 'What the firing produced renders as an artifact row', proves: 'artifact-rendered', audit: false, auditReason: 'the same resting state the first step measured', expect: { count: [{ target: rows('pipeline-artifacts'), min: 1 }] } },
    { do: 'wait', target: { testId: 'pipeline-events' }, name: 'The events stream lists the run’s step events without a refresh', proves: 'events-streamed', audit: false, auditReason: 'the same resting state the first step measured', expect: { visible: [{ testId: 'pipeline-events' }], text: [/pipeline:step:(started|completed)/] } },
    { do: 'tab-walk', name: 'Tab from the top of the page through every control', proves: 'keyboard', expect: { minVisited: 10 } },
    { do: 'navigate', url: BOT, name: 'The page holds the run sections and no pipelines-tenant chrome', proves: 'empty-state', audit: false, auditReason: 'the same resting state the first step measured', expect: { visible: [{ testId: 'pipeline-run' }], absent: [{ css: '[data-shell-nav] a[href^="/pipelines"]' }] } },
    { do: 'api', url: '/api/runs', name: 'The page’s source, the orgiq /api/runs façade, answers 200 for an sme', proves: 'role-gating', expect: { status: 200 } },
    { do: 'api', url: '/api/pipelines/runs', name: 'The pipelines tenant’s own /api/pipelines/runs answers 403 for this orgiq session', proves: 'role-gating', expect: { status: 403 } },
  ],
} satisfies JourneyMap;
