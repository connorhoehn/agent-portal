// ResearcherPipelinePage — Phase 2.5 stub
//
// Shows active runs of the orgiq-researcher AgenticPipeline CRD.
// Full implementation deferred to Phase 2.5 (trigger + observe end-to-end).
//
// When complete this page should:
//   1. List recent pipeline runs via platform-api GET /api/pipelines/orgiq-researcher/runs
//   2. Subscribe to live run events via a dedicated `usePipelineRun(runId)` hook
//      in @connorhoehnslalom/realtime-modules (does not exist yet — `useAgentStream`
//      is now HTTP-chat shaped and is the wrong primitive for WS pipeline events)
//   3. Surface the `approval` human-gate as a modal for role:editor users
//
// Phase 2.5 prerequisite: operator deployed + EC bundle agentic-pipeline-signal@1.0.0 registered.

import { PageSection } from '@connorhoehnslalom/ui-components/shared';

export function ResearcherPipelinePage() {
  return (
    <PageSection
      title="Researcher Pipeline"
      description="Phase 2.5 — full run list + live observation not yet implemented."
    >
      <p className="text-xs text-gray-400">
        CRD: <code>agenticpipeline/orgiq-researcher</code> (namespace: orgiq)
      </p>
    </PageSection>
  );
}

export default ResearcherPipelinePage;
