// Operator: runs pipelines, approves the steps that wait on a person, cancels
// runs, and sees every run. Scoped to the pipelines tenant
// (docs/pipelines-tenant-goal.md §Cedar).
permit (
  principal,
  action in [
    OrgIQ::Action::"ViewPipelines",
    OrgIQ::Action::"RunPipeline",
    OrgIQ::Action::"ApproveStep",
    OrgIQ::Action::"CancelRun",
    // Mint a voice navigator session: reads and navigation only in this tenant
    // (docs/voice-navigator-gaps.md Q1); each tool is gated by its own read's action.
    OrgIQ::Action::"VoiceNavigate"
  ],
  resource
)
when { principal.role == "operator" && principal has tenant && principal.tenant == "pipelines" };

// Separation of duties: an operator never writes the definition they approve,
// and the tenant's configuration is the pipeline admin's.
forbid (
  principal,
  action in [
    OrgIQ::Action::"AuthorDefinition",
    OrgIQ::Action::"ManagePipelineConfig"
  ],
  resource
)
when { principal.role == "operator" };
