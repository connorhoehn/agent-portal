// Program lead: owns the assessment program end to end. Everything a
// lead-assessor can do, plus changing program-wide assessment configuration
// (rubric target level, motions/cohorts) and managing users within the
// assessment tenant. No forbids of its own — program-lead is the top of the
// assessment role ladder, one step below the cross-tenant admin.
// Scoped to the assessment tenant.
permit (
  principal,
  action in [
    OrgIQ::Action::"ViewAssessment",
    OrgIQ::Action::"ScoreAssessment",
    OrgIQ::Action::"ManageSubmissions",
    OrgIQ::Action::"RunAssessmentAgent",
    OrgIQ::Action::"Search",
    OrgIQ::Action::"LabelFeedback",
    OrgIQ::Action::"ApproveException",
    OrgIQ::Action::"PublishReport",
    OrgIQ::Action::"ManageKnowledge",
    OrgIQ::Action::"ViewObservability",
    OrgIQ::Action::"ManageAssessmentConfig",
    OrgIQ::Action::"ManageUsers"
  ],
  resource
)
when { principal.role == "program-lead" && principal has tenant && principal.tenant == "assessment" };
