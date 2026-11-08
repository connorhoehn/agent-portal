// Pipeline admin: an operator plus the tenant's configuration and its users
// ("configuration and tenant users", docs/social-tenant-design.md §5.1). No
// forbids of its own — the top of the pipelines role ladder, one step below
// the cross-tenant admin. Scoped to the pipelines tenant.
permit (
  principal,
  action in [
    OrgIQ::Action::"ViewPipelines",
    OrgIQ::Action::"RunPipeline",
    OrgIQ::Action::"ApproveStep",
    OrgIQ::Action::"CancelRun",
    OrgIQ::Action::"ManagePipelineConfig",
    OrgIQ::Action::"ManageUsers",
    // Mint a voice navigator session: reads and navigation only in this tenant
    // (docs/voice-navigator-gaps.md Q1); each tool is gated by its own read's action.
    OrgIQ::Action::"VoiceNavigate"
  ],
  resource
)
when { principal.role == "pipeline-admin" && principal has tenant && principal.tenant == "pipelines" };
