// /iq/runs — OrgIQ's Runs section under Operate (docs/social-tenant-design.md
// §5.1, lane E): the runs this workspace's bots, agents and queue produced,
// read through the orgiq façade GET /api/runs (context.tenant = orgiq only;
// middleware routes/runs.ts). Never the pipelines tenant's own door — that
// mount refuses every session outside the pipelines tenant.
//
// Gated like the façade: the bots router's read gate (org-leader, hr-admin,
// program-owner, and anyone holding ManageBots — sme), so the rail, the
// palette and the route admit exactly who the API serves
// (docs/nav-server-tier-decisions.md).

import { RunsLedger } from '../../components/runs/RunsLedger';
import { CollectionCommandPage } from '../../components/collections/CollectionCommandPage';

export default function IqRunsPage() {
  return (
    <CollectionCommandPage data-testid="iq-runs" title="Runs" description="What this workspace's bots, agents and queue ran, and where each run stands.">
      <RunsLedger endpoint="/api/runs" detailBase="/iq/runs" fill data-testid="iq-runs-table" />
    </CollectionCommandPage>
  );
}
