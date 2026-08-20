// Editor: newsroom desk lead. Everything a reporter can do, plus publishing,
// knowledge-base management for the newsroom KB, and observability into the
// newsroom agents (news-researcher / news-brief / news-headline).
// Scoped to the newsroom tenant.
permit (
  principal,
  action in [
    OrgIQ::Action::"Search",
    OrgIQ::Action::"WriteArticle",
    OrgIQ::Action::"ManagePitches",
    OrgIQ::Action::"PublishArticle",
    OrgIQ::Action::"ManageKB",
    OrgIQ::Action::"ViewObservability",
    OrgIQ::Action::"LabelFeedback"
  ],
  resource
)
when { principal.role == "editor" && principal.tenant == "newsroom" };
