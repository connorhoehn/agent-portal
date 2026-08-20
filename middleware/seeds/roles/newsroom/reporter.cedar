// Reporter: files stories and pitches. Can search the shared graph (people are
// shared between tenants as byline sources) but has no publish authority and no
// visibility into orgiq admin or observability surfaces.
// Scoped to the newsroom tenant.
permit (
  principal,
  action in [
    OrgIQ::Action::"Search",
    OrgIQ::Action::"WriteArticle",
    OrgIQ::Action::"ManagePitches",
    OrgIQ::Action::"LabelFeedback"
  ],
  resource
)
when { principal.role == "reporter" && principal.tenant == "newsroom" };
