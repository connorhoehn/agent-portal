// ResearcherPipelinePage — Phase 2.5 stub
//
// Shows active runs of the orgiq-researcher AgenticPipeline CRD.
// Full implementation deferred to Phase 2.5 (trigger + observe end-to-end).
//
// When complete this page should:
//   1. List recent pipeline runs via platform-api GET /api/pipelines/orgiq-researcher/runs
//   2. Subscribe to live run events via gateway WS channel `pipeline:run:<runId>`
//      using useAgentStream (or a future usePipelineRun hook)
//   3. Surface the `approval` human-gate as a modal for role:editor users
//
// Phase 2.5 prerequisite: operator deployed + EC bundle agentic-pipeline-signal@1.0.0 registered.

import { useAgentStream } from '@connorhoehn/realtime-modules/agent-streaming/client';

// TODO Phase 2.5: replace placeholder runId with a real run selected from
// platform-api GET /api/pipelines/orgiq-researcher/runs
const PLACEHOLDER_RUN_ID = '';

export function ResearcherPipelinePage() {
  // NOTE: useAgentStream is used here as a stopgap to demonstrate the
  // subscription pattern. Once a dedicated usePipelineRun hook exists in
  // realtime-modules it should replace this.
  const { events, status } = useAgentStream({
    // The gateway WS channel for a pipeline run is `pipeline:run:<runId>`.
    // Phase 2.5: derive runId from route params or a run-selector UI.
    sessionId: PLACEHOLDER_RUN_ID ? `pipeline:run:${PLACEHOLDER_RUN_ID}` : '',
    agentId: 'orgiq-researcher',
    onEvent: () => {
      // TODO Phase 2.5: handle step transitions, approval-gate prompt, completion
    },
  });

  if (!PLACEHOLDER_RUN_ID) {
    return (
      <div className="p-8 text-center text-gray-500">
        <h1 className="text-xl font-semibold mb-2">Researcher Pipeline</h1>
        <p className="text-sm">
          Phase 2.5 — full run list + live observation not yet implemented.
        </p>
        <p className="mt-4 text-xs text-gray-400">
          CRD: <code>agenticpipeline/orgiq-researcher</code> (namespace: orgiq)
        </p>
      </div>
    );
  }

  return (
    <div className="p-8">
      <h1 className="text-xl font-semibold mb-4">
        Researcher Pipeline — Run{' '}
        <code className="text-sm font-mono">{PLACEHOLDER_RUN_ID}</code>
      </h1>
      <p className="text-sm text-gray-500 mb-2">Status: {status}</p>
      <ul className="space-y-2">
        {events.map((evt, i) => (
          <li key={i} className="text-xs font-mono bg-gray-50 rounded p-2">
            {JSON.stringify(evt)}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default ResearcherPipelinePage;
