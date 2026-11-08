// Lead assessor: everything an assessor can do, plus the consequential
// decisions an assessor cannot make for themselves — approving an N/A
// exception and publishing a report — plus curating the knowledge base
// (enterprise context, rules, prompts) and reading observability. Changing
// the rubric target level / assessment configuration stays program-lead only.
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
    // Mint a voice navigator session: reads and navigation only in this tenant
    // (docs/voice-navigator-gaps.md Q1); each tool is gated by its own read's action.
    OrgIQ::Action::"VoiceNavigate"
  ],
  resource
)
when { principal.role == "lead-assessor" && principal has tenant && principal.tenant == "assessment" };

// The rubric target level and other program-wide assessment configuration is
// a program-lead decision, not a lead-assessor one.
forbid (
  principal,
  action == OrgIQ::Action::"ManageAssessmentConfig",
  resource
)
when { principal.role == "lead-assessor" };
