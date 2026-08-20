// Editor: newsroom desk lead. Everything a reporter can do, plus publishing.
// Scoped to the newsroom tenant.
//
// ManageKB and ViewObservability are RESERVED here for a future newsroom-native
// KB / agent-observability surface. They gate nothing an editor can reach today:
// the orgiq KB-registry and observability routes are tenant-scoped to orgiq, so
// these grants only ever apply to a newsroom-tenant resource, which doesn't
// exist yet. Kept (not deleted) so the grant is ready when that surface lands.
permit (
  principal,
  action in [
    OrgIQ::Action::"Search",
    OrgIQ::Action::"WriteArticle",     // RESERVED — no article-write endpoint yet
    OrgIQ::Action::"ManagePitches",
    OrgIQ::Action::"PublishArticle",
    OrgIQ::Action::"ManageKB",          // RESERVED — see header
    OrgIQ::Action::"ViewObservability", // RESERVED — see header
    OrgIQ::Action::"LabelFeedback"
  ],
  resource
)
when { principal.role == "editor" && principal.tenant == "newsroom" };
