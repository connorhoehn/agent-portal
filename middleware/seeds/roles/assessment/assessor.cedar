// Assessor: does the day-to-day scoring work — reads evidence, scores
// dimensions, runs the scoring/drafting agents, manages submission intake.
// Drafts stories and proposes N/A exceptions, but approving either kind of
// consequential decision (an exception, a published report) is a lead's call.
// Scoped to the assessment tenant.
permit (
  principal,
  action in [
    OrgIQ::Action::"ViewAssessment",
    OrgIQ::Action::"ScoreAssessment",
    OrgIQ::Action::"ManageSubmissions",
    OrgIQ::Action::"RunAssessmentAgent",
    OrgIQ::Action::"Search",
    OrgIQ::Action::"LabelFeedback"
  ],
  resource
)
when { principal.role == "assessor" && principal has tenant && principal.tenant == "assessment" };

// Separation of duties: an assessor never approves their own N/A exception
// proposal, and never publishes a report. Both are a lead-assessor decision.
forbid (
  principal,
  action in [
    OrgIQ::Action::"ApproveException",
    OrgIQ::Action::"PublishReport"
  ],
  resource
)
when { principal.role == "assessor" };
