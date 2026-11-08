// Author: writes and versions pipeline definitions, and dry-runs them — a
// runbook only becomes a skill after a completed run of its definition.
// Scoped to the pipelines tenant (docs/pipelines-tenant-goal.md §Cedar).
permit (
  principal,
  action in [
    OrgIQ::Action::"ViewPipelines",
    OrgIQ::Action::"AuthorDefinition",
    OrgIQ::Action::"RunPipeline",
    // Mint a voice navigator session: reads and navigation only in this tenant
    // (docs/voice-navigator-gaps.md Q1); each tool is gated by its own read's action.
    OrgIQ::Action::"VoiceNavigate"
  ],
  resource
)
when { principal.role == "author" && principal has tenant && principal.tenant == "pipelines" };

// Separation of duties: an author never approves a step of a definition they
// wrote, never cancels someone else's run, and never configures the tenant.
forbid (
  principal,
  action in [
    OrgIQ::Action::"ApproveStep",
    OrgIQ::Action::"CancelRun",
    OrgIQ::Action::"ManagePipelineConfig"
  ],
  resource
)
when { principal.role == "author" };
