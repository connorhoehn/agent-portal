// Assessment tenant demo fixture — backs providers/assessment.ts under
// MOCK_AURORA. Mirrors the shapes in the source app
// (~/Projects/agentic-assessment-accelerator: ui/src/components/assessment/
// types.ts, knowledge/types.ts) and the vocabulary in
// sdlcd/assessment/dimensions/rubric.yaml verbatim: dimension ids are plain
// "1".."17", confidence is low|moderate|high, follow-up status is
// OPEN|ANSWERED|DROPPED, certification is two-track claimed/verified with
// claim_open, and N/A is never self-granting (archetype/known_exception rows
// are pre-approved; submission/manual rows need a human Approve/Deny).
//
// 7 teams across the 3 cohorts: TEAM-001/002 fully assessed (all 17
// dimensions, with evidence + follow-ups + history + a scoring-log
// reasoning-log sidecar each), TEAM-003/004/005 partially assessed,
// TEAM-006/007 brand new. TEAM-001 carries a claim_open gap of 3 on
// dimension 1, a Level-4 dimension (9) backed by Observed evidence, one
// approved archetype N/A (dimension 6) and one requested manual N/A
// (dimension 7). TEAM-002 mirrors the source fixture's actual shape: every
// dimension self-rated "Leading" (claimed 5) but capped at Level 3 because
// the only evidence is the team's own account (evidence_class "attested"),
// per the self-rating-only cap rule.
//
// This module stands on the mock floor (src/mock/core, docs/mock-floor.md):
//
//   * Every collection is a `defineFixture` with a rows FACTORY, so a caller
//     can ask for `empty`/`error`/`large` (GET/POST /api/__mock/scenario)
//     instead of mutating shared state and warning the next auditor.
//   * Every timestamp comes from `clock` and is sampled when the factory runs,
//     not when this module is imported — a fixture loaded at 23:59 and read at
//     00:01 still says "today".
//   * Nothing here stores a number that could have been counted from rows this
//     same module exports. The two that did are gone: a team's `status` (it is
//     `deriveTeamStatus(dimensions)`, and it once read "New" beside "17/17
//     assessed") and a knowledge-doc version's `size` (it read 210 B over 61
//     bytes of markdown). Both are derived at read time now.
//
// The RUBRIC is deliberately NOT a fixture: it is the rubric.yaml definition
// this tenant scores against — reference data, like a schema, not seeded rows.
// An `empty` rubric would empty DIMENSION_IDS and take every surface with it.

import { clock, countBy, defineFixture } from './core/index.js';

// Sampled at factory-run time, never at import. See core/clock.ts.
const hoursAgo = (n: number): string => clock.hoursAgo(n);
const daysAgo = (n: number): string => clock.daysAgo(n);
const minutesAgo = (n: number): string => clock.hoursAgo(n / 60);

// ─── Rubric ─────────────────────────────────────────────────────────────────

export type Cohort = 'white_glove' | 'self_service' | 'general';

export const COHORT_LABELS: Record<Cohort, string> = {
  white_glove: 'White Glove',
  self_service: 'Self-Service',
  general: 'General',
};

export interface RubricLevel {
  level: number;
  name: string;
  description: string;
  key_characteristics: string[];
  level_up_criteria: string[];
  evidence_examples: string[];
}

export interface RubricDimensionDef {
  /**
   * Which rubric this dimension belongs to. `assessment_rubric_dimensions`
   * keys on `(rubric_version, id)` precisely because dimension `'7'` under one
   * rubric and dimension `'7'` under the next are different questions — so an
   * id alone does not identify a dimension, and a score that names only a
   * level is unreadable once the rubric is edited.
   */
  rubric_version: string;
  id: string;
  title: string;
  definition: string;
  na_description: string;
  levels: RubricLevel[];
}

/**
 * The rubric a team is scored against unless it says otherwise — and the value
 * `assessment_teams.rubric_version` DEFAULTs to, so a row written by either
 * path lands on the same rubric.
 */
export const DEFAULT_RUBRIC_VERSION = 'v1';

/**
 * The version is a property of the SET, not of each of its seventeen rows, so
 * it is stamped from the registry key below rather than typed seventeen times.
 * A second rubric is then a second entry in `RUBRICS` — data, not a code change
 * — which is the shape the composite primary key exists to allow.
 */
type RubricDimensionBody = Omit<RubricDimensionDef, 'rubric_version'>;

const stampRubric = (version: string, dims: RubricDimensionBody[]): RubricDimensionDef[] =>
  dims.map((d) => ({ rubric_version: version, ...d }));

const RUBRIC_V1_DIMENSIONS: RubricDimensionBody[] = [
 {
  "id": "1",
  "title": "Continuous Integration (CI)",
  "definition": "The maturity of automated CI workflows that validate code changes early, enforce quality signals, and ensure consistent integration through predictable build and test pipelines.",
  "na_description": "Not applicable if the team does not commit or integrate code, configuration-as-code, scripts, or infrastructure-as-code into version control.",
  "levels": [
   {
    "level": 0,
    "name": "Below Baseline",
    "description": "CI pipelines are not used; integrations rely on manual processes or individual scripts run outside standardized workflows.",
    "key_characteristics": [
     "None. Team operates without a standardized Continuous Integration capability."
    ],
    "level_up_criteria": [
     "Implement at least one CI pipeline capable of building source code or validating deployable…",
     "Store CI pipeline definitions in version control."
    ],
    "evidence_examples": [
     "GitLab CI YAML",
     "GitHub Actions workflow",
     "Jenkinsfile"
    ]
   },
   {
    "level": 1,
    "name": "Initial",
    "description": "CI is inconsistent, manually triggered, and dependent on individual habits rather than defined integration workflows.",
    "key_characteristics": [
     "A CI pipeline exists and can build/test code, but many changes are still merged without running it.",
     "Pipeline runs are manual or ad hoc rather than automatically triggered on push/PR.",
     "Multiple, inconsistent CI setups exist across teams or services (tool fragmentation)."
    ],
    "level_up_criteria": [
     "Configure CI to automatically trigger on commit, push, merge request, pull request, or equivalent…",
     "Ensure the majority of active development work executes through CI rather than manual builds."
    ],
    "evidence_examples": [
     "Auto-trigger configuration",
     "Automated pipeline execution history",
     "Build notifications"
    ]
   },
   {
    "level": 2,
    "name": "Developing",
    "description": "CI triggers automatically on push/PR for at least some of the team's repositories.",
    "key_characteristics": [
     "CI triggers automatically on push/PR for at least some repositories.",
     "Failing pipelines do not block merges.",
     "Build and test results are visible to the team."
    ],
    "level_up_criteria": [
     "Require successful CI execution before code changes are merged.",
     "Implement branch protection or equivalent controls that prevent direct merges bypassing CI."
    ],
    "evidence_examples": [
     "Protected branch settings",
     "Mandatory status checks",
     "Standard pipeline templates"
    ]
   },
   {
    "level": 3,
    "name": "Defined",
    "description": "CI is standardized and required before merge.",
    "key_characteristics": [
     "CI pipeline definitions are version-controlled and based on an approved template.",
     "A passing CI run (build and automated tests) is required before merge and enforced through protected branches.",
     "CI executes consistently across all qualifying repositories."
    ],
    "level_up_criteria": [
     "Establish and monitor CI performance metrics.",
     "Measure build success rate, pipeline duration, failure rate, and pipeline reliability."
    ],
    "evidence_examples": [
     "CI dashboards",
     "Pipeline health reports",
     "Build success trends"
    ]
   },
   {
    "level": 4,
    "name": "Measured",
    "description": "CI pipeline health is tracked and actively managed.",
    "key_characteristics": [
     "Build success rate, duration, and flakiness are tracked over time.",
     "Failing or flaky CI runs are triaged and remediated as part of normal workflow.",
     "CI performance data informs engineering and process improvements."
    ],
    "level_up_criteria": [
     "Eliminate routine CI bypass mechanisms.",
     "Demonstrate automated optimization of pipeline execution efficiency."
    ],
    "evidence_examples": [
     "Dynamic test selection",
     "Intelligent caching",
     "Parallelized execution"
    ]
   },
   {
    "level": 5,
    "name": "Optimizing",
    "description": "CI is a fully enforced, self-improving gate with no bypass path.",
    "key_characteristics": [
     "Merging without a passing CI run is architecturally impossible.",
     "CI pipelines self-optimize through capabilities such as test selection, parallelization, or caching.",
     "CI telemetry contributes to broader delivery and engineering performance reporting."
    ],
    "level_up_criteria": [],
    "evidence_examples": []
   }
  ]
 },
 {
  "id": "2",
  "title": "Continuous Delivery (CD)",
  "definition": "Validated artifacts are packaged, promoted through environments, and deployed in a governed, automated way, with rollback defined and tested.",
  "na_description": "Not applicable if the team does not package, promote, or deploy software or configuration through release workflows.",
  "levels": [
   {
    "level": 0,
    "name": "Below Baseline",
    "description": "No defined promotion path, packaging standard, approval process, or rollback method; releases are entirely manual and ad hoc.",
    "key_characteristics": [
     "None. Releases are managed through manual effort without established standards, controls, or repeatable…"
    ],
    "level_up_criteria": [
     "Document a repeatable release process, deployment checklist, runbook, or release procedure.",
     "Define deployment responsibilities and required release participants."
    ],
    "evidence_examples": [
     "Release runbook",
     "Deployment checklist",
     "Change management documentation"
    ]
   },
   {
    "level": 1,
    "name": "Initial",
    "description": "Release plans and practices are documented, even though execution is manual and packaging or promotion still require hands-on coordination for each…",
    "key_characteristics": [
     "A documented release plan, runbook, or checklist exists and is followed for each deployment.",
     "Packaging is assembled manually but follows a known, documented process.",
     "Promotion steps are documented, though movement between environments still requires manual coordination."
    ],
    "level_up_criteria": [
     "Standardize portions of packaging or deployment activities.",
     "Define release approval requirements and readiness criteria."
    ],
    "evidence_examples": [
     "Standard release package structure",
     "Approval workflow records",
     "Artifact repository"
    ]
   },
   {
    "level": 2,
    "name": "Developing",
    "description": "A basic release process exists, but practices vary by change type or environment.",
    "key_characteristics": [
     "Packaging is partially standardized, but formats and metadata may vary.",
     "Approval processes exist, though criteria and evidence requirements are inconsistent.",
     "Rollback procedures are documented but not routinely validated."
    ],
    "level_up_criteria": [
     "Use automated deployment pipelines for qualifying releases.",
     "Standardize packaging, versioning, and release artifact requirements."
    ],
    "evidence_examples": [
     "GitLab, GitHub, Azure DevOps, or equivalent deployment…",
     "Release promotion workflows",
     "Signed release artifacts"
    ]
   },
   {
    "level": 3,
    "name": "Defined",
    "description": "Packaging, approval, promotion, and rollback are standardized and pipeline-driven.",
    "key_characteristics": [
     "Packaging is standardized, including versioning structure and release metadata.",
     "Release artifacts, release notes, test evidence, and supporting documentation are consistently maintained.",
     "Deployment occurs through automated pipelines and predictable promotion paths."
    ],
    "level_up_criteria": [
     "Track deployment performance metrics.",
     "Measure deployment success rate, change failure rate, rollback frequency, and deployment throughput."
    ],
    "evidence_examples": [
     "Deployment dashboards",
     "Release scorecards",
     "Rollback testing results"
    ]
   },
   {
    "level": 4,
    "name": "Measured",
    "description": "Release performance is measured and rollback readiness is validated, not just documented.",
    "key_characteristics": [
     "Release metrics are actively tracked and reviewed.",
     "Rollback readiness is validated through testing rather than assumed.",
     "Deployment success and change-failure trends are measured over time."
    ],
    "level_up_criteria": [
     "Implement policy-driven release orchestration.",
     "Dynamically adjust approvals based on risk, evidence, or change type."
    ],
    "evidence_examples": [
     "Automated rollback execution",
     "Risk-based approvals",
     "Feature flag management"
    ]
   },
   {
    "level": 5,
    "name": "Optimizing",
    "description": "Release orchestration is policy-driven, resilient, and self-improving.",
    "key_characteristics": [
     "Approvals are policy-based and adapt to risk and evidence.",
     "Rollback is automated and can be executed rapidly with minimal manual effort.",
     "Progressive delivery techniques are used where appropriate."
    ],
    "level_up_criteria": [],
    "evidence_examples": []
   }
  ]
 },
 {
  "id": "3",
  "title": "Automation",
  "definition": "Infrastructure, configuration, and routine operational tasks are executed through automated, repeatable processes rather than manual or ad hoc action (\"ClickOps\").",
  "na_description": "Not applicable if the team has no ownership of infrastructure, configuration, or operational workflows that could be automated.",
  "levels": [
   {
    "level": 0,
    "name": "Below Baseline",
    "description": "Infrastructure and configuration changes are made entirely manually (e.g., console \"ClickOps\"), with no automation tooling in use.",
    "key_characteristics": [
     "None. Infrastructure, configuration, and operational activities depend entirely on manual execution."
    ],
    "level_up_criteria": [
     "Implement at least one repeatable automation capability for infrastructure, configuration, or…",
     "Use automation tooling for at least a subset of work."
    ],
    "evidence_examples": [
     "Terraform configurations",
     "PowerShell scripts",
     "Bash scripts"
    ]
   },
   {
    "level": 1,
    "name": "Initial",
    "description": "Automation tooling exists, but most work is still manual.",
    "key_characteristics": [
     "Some Infrastructure-as-Code (IaC) exists, but most changes are applied manually with elevated access.",
     "Secrets and credentials are often stored in scripts or configuration files.",
     "Centralized secrets management is not consistently used."
    ],
    "level_up_criteria": [
     "Automate selected repeatable infrastructure or configuration activities.",
     "Store automation artifacts in version control."
    ],
    "evidence_examples": [
     "Source-controlled automation repositories",
     "Automated provisioning scripts",
     "Configuration management artifacts"
    ]
   },
   {
    "level": 2,
    "name": "Developing",
    "description": "Automation scripts exist, but execution is inconsistent.",
    "key_characteristics": [
     "Infrastructure-as-Code or automation scripts exist and are used for some changes.",
     "Execution is inconsistent and often triggered manually.",
     "Automation adoption is not measured."
    ],
    "level_up_criteria": [
     "Require automation for qualifying infrastructure and configuration changes.",
     "Standardize automation patterns, modules, templates, or reusable components."
    ],
    "evidence_examples": [
     "Approved Terraform modules",
     "Infrastructure-as-Code repositories",
     "Secret-management integrations"
    ]
   },
   {
    "level": 3,
    "name": "Defined",
    "description": "Infrastructure and configuration changes are applied through a consistent, automated process.",
    "key_characteristics": [
     "Infrastructure-as-Code and automation assets are version-controlled.",
     "Defined patterns, modules, and templates are used consistently.",
     "Qualifying infrastructure and configuration changes are applied through automation rather than manual…"
    ],
    "level_up_criteria": [
     "Measure automation coverage across infrastructure and operational activities.",
     "Track automation success rates, failures, and reliability metrics."
    ],
    "evidence_examples": [
     "Automation coverage dashboards",
     "Infrastructure deployment metrics",
     "Coverage reports"
    ]
   },
   {
    "level": 4,
    "name": "Measured",
    "description": "Automation coverage and reliability are tracked.",
    "key_characteristics": [
     "Automation coverage is measured as a percentage of qualifying changes.",
     "Manual changes are tracked as exceptions rather than routine practice.",
     "Secrets rotation policies are defined, enforced, and monitored."
    ],
    "level_up_criteria": [
     "Implement technical controls that prevent or significantly restrict manual infrastructure changes.",
     "Continuously detect and remediate infrastructure drift."
    ],
    "evidence_examples": [
     "Drift detection tooling",
     "Policy-as-Code controls",
     "Automated remediation workflows"
    ]
   },
   {
    "level": 5,
    "name": "Optimizing",
    "description": "Manual infrastructure changes are architecturally prevented.",
    "key_characteristics": [
     "Guardrails prevent manual or out-of-band infrastructure changes for qualifying systems.",
     "Automation continuously improves through telemetry-driven optimization.",
     "Infrastructure drift is automatically detected and corrected."
    ],
    "level_up_criteria": [],
    "evidence_examples": []
   }
  ]
 },
 {
  "id": "4",
  "title": "Source Control & Traceability",
  "definition": "The maturity of standardized version control, Infrastructure-as-Code, Configuration-as-Code, and bidirectional traceability linking requirements to code, tests, and release artifacts.",
  "na_description": "Not applicable if the team does not create or modify source code, configuration, scripts, or Infrastructure-as-Code artifacts and is therefore not expected to maintain version…",
  "levels": [
   {
    "level": 0,
    "name": "Below Baseline",
    "description": "Version control is not used. Code, configuration, or infrastructure changes cannot be traced to work items or releases. Branching strategies are not…",
    "key_characteristics": [
     "None. Source artifacts, configuration, or infrastructure changes cannot be reliably tracked, audited, or…"
    ],
    "level_up_criteria": [
     "Store at least some source code, scripts, configuration files, or Infrastructure-as-Code assets in…",
     "Establish a repository structure for active development work."
    ],
    "evidence_examples": [
     "Git repositories",
     "Commit history",
     "Repository ownership documentation"
    ]
   },
   {
    "level": 1,
    "name": "Initial",
    "description": "Version control usage is inconsistent, and traceability relies on manual notes or individual habits.",
    "key_characteristics": [
     "Version control usage varies, with some code, scripts, or configuration stored outside approved repositories.",
     "Configuration updates are handled manually, creating drift and limited visibility into change history.",
     "Infrastructure changes are not consistently tracked and often occur outside Infrastructure-as-Code practices."
    ],
    "level_up_criteria": [
     "Store the majority of source artifacts in approved repositories.",
     "Expand version control beyond application code to include scripts, configuration files, and…"
    ],
    "evidence_examples": [
     "Pull request workflows",
     "Branching standards",
     "Infrastructure-as-Code repositories"
    ]
   },
   {
    "level": 2,
    "name": "Developing",
    "description": "Version control is used for some assets, but branching, Infrastructure-as-Code, and traceability practices differ across work types and are applied…",
    "key_characteristics": [
     "Most code changes are stored in version control, but scripts, configuration files, and infrastructure…",
     "Branching and merge practices vary across repositories.",
     "Protection controls and review requirements are inconsistently enforced."
    ],
    "level_up_criteria": [
     "Use approved repositories consistently across qualifying assets.",
     "Standardize branching, merge, and review practices."
    ],
    "evidence_examples": [
     "Protected branch settings",
     "Merge approval requirements",
     "Repository governance standards"
    ]
   },
   {
    "level": 3,
    "name": "Defined",
    "description": "Standardized repository practices, Configuration-as-Code, and traceability are consistently applied.",
    "key_characteristics": [
     "Approved repositories are used consistently.",
     "Structured branching, merge review processes, and access controls are established.",
     "Multi-factor authentication and repository administration practices are defined."
    ],
    "level_up_criteria": [
     "Maintain end-to-end traceability from work item through deployment.",
     "Measure traceability completeness and metadata quality."
    ],
    "evidence_examples": [
     "Traceability dashboards",
     "Audit reports",
     "Release lineage reports"
    ]
   },
   {
    "level": 4,
    "name": "Measured",
    "description": "Traceability is monitored and used to improve consistency, security, and release reliability.",
    "key_characteristics": [
     "End-to-end traceability connects requirements, commits, builds, deployments, releases, and supporting…",
     "Configuration and infrastructure changes are governed through version-controlled workflows.",
     "Metadata quality is measured and monitored."
    ],
    "level_up_criteria": [
     "Automate traceability across the software delivery lifecycle.",
     "Eliminate manual reconciliation between requirements, code, testing, approvals, and releases."
    ],
    "evidence_examples": [
     "Automated work item linking",
     "Automated release lineage generation",
     "Policy-as-Code governance controls"
    ]
   },
   {
    "level": 5,
    "name": "Optimizing",
    "description": "Traceability is automated and drives continuous improvement, auditability, and delivery intelligence.",
    "key_characteristics": [
     "Automated traceability connects code, Infrastructure-as-Code, configuration, tests, approvals, and releases.",
     "Configuration and infrastructure are fully expressed as code.",
     "Real-time drift detection supports operational integrity."
    ],
    "level_up_criteria": [],
    "evidence_examples": []
   }
  ]
 },
 {
  "id": "5",
  "title": "Testing & QE – Automated Testing",
  "definition": "Coverage, reliability, and integration of automated unit, integration, end-to-end (E2E), and regression tests into delivery workflows.",
  "na_description": "Not applicable if the team does not write, maintain, or execute application or platform code (including scripts). Teams only deploy vendor products, operate COTS systems without…",
  "levels": [
   {
    "level": 0,
    "name": "Below Baseline",
    "description": "The team has no automated tests and relies entirely on manual validation or production discovery.",
    "key_characteristics": [
     "None. Validation depends entirely on manual testing, user reports, or post-release issue discovery."
    ],
    "level_up_criteria": [
     "Implement at least one form of automated testing (unit, integration, API, UI, regression, or…",
     "Execute automated tests for at least a subset of application functionality."
    ],
    "evidence_examples": [
     "Unit test frameworks",
     "Automated test scripts",
     "Test repositories"
    ]
   },
   {
    "level": 1,
    "name": "Initial",
    "description": "Automated testing is minimal; validation is manual and issues are discovered late.",
    "key_characteristics": [
     "Automated testing is minimal, with validation primarily manual or ad hoc after deployment.",
     "Coverage expectations are undefined.",
     "Critical application paths lack unit, integration, or end-to-end coverage."
    ],
    "level_up_criteria": [
     "Expand automated testing beyond isolated components.",
     "Establish documented expectations for automated testing practices."
    ],
    "evidence_examples": [
     "Test coverage inventories",
     "Automated regression suites",
     "Integration test suites"
    ]
   },
   {
    "level": 2,
    "name": "Developing",
    "description": "Some automated tests exist, but coverage, reliability, and consistency vary widely.",
    "key_characteristics": [
     "Coverage is limited and focused on selected components or services.",
     "Automated testing is isolated to specific code paths.",
     "Test execution is irregular and may require manual triggering."
    ],
    "level_up_criteria": [
     "Define testing scope across unit, integration, end-to-end, and regression testing as applicable.",
     "Automatically execute qualifying tests through delivery workflows."
    ],
    "evidence_examples": [
     "Pipeline-integrated test execution",
     "CI/CD quality gates",
     "Merge request validation"
    ]
   },
   {
    "level": 3,
    "name": "Defined",
    "description": "Automated tests exist for key behaviors and run consistently as part of standard delivery workflows.",
    "key_characteristics": [
     "Unit, integration, end-to-end, and regression testing scopes are documented.",
     "Execution is automated and integrated into standard delivery workflows.",
     "Automated tests run through CI/CD pipelines, merge requests, or promotion workflows."
    ],
    "level_up_criteria": [
     "Measure automated testing coverage, execution reliability, and quality trends.",
     "Track test failure rates, flaky tests, execution times, and stability metrics."
    ],
    "evidence_examples": [
     "Coverage dashboards",
     "Test stability reports",
     "Flaky test remediation backlog"
    ]
   },
   {
    "level": 4,
    "name": "Measured",
    "description": "Automated suites provide repeatable, measurable quality signals that influence delivery workflows.",
    "key_characteristics": [
     "Automated test suites are instrumented and monitored.",
     "Coverage, stability, execution performance, and failure trends are tracked.",
     "Test results serve as release confidence indicators."
    ],
    "level_up_criteria": [
     "Use risk-based or impact-based testing strategies.",
     "Continuously tune automated suites to maximize risk coverage while minimizing execution time."
    ],
    "evidence_examples": [
     "Test impact analysis",
     "Risk-based test selection",
     "Adaptive execution strategies"
    ]
   },
   {
    "level": 5,
    "name": "Optimizing",
    "description": "Automation is comprehensive, reliable, and continuously tuned to support fast and safe delivery.",
    "key_characteristics": [
     "Coverage is risk-informed and continuously aligned to protect critical business and technical workflows.",
     "Test execution adapts to code changes and impacted areas.",
     "Test selection is optimized to maximize confidence and speed."
    ],
    "level_up_criteria": [],
    "evidence_examples": []
   }
  ]
 },
 {
  "id": "6",
  "title": "Testing & QE – Security Testing",
  "definition": "Security testing practices that identify, validate, and remediate vulnerabilities through automated and manual security testing activities integrated into the software delivery lifecycle.",
  "na_description": "Not applicable if the team does not develop, modify, deploy, or maintain code, scripts, applications, APIs, Infrastructure-as-Code, or configuration that requires security…",
  "levels": [
   {
    "level": 0,
    "name": "Below Baseline",
    "description": "No security testing is performed prior to deployment or release.",
    "key_characteristics": [
     "None. Security vulnerabilities are discovered only through production incidents, external assessments,…"
    ],
    "level_up_criteria": [
     "Perform at least one form of security validation prior to release or deployment.",
     "Document basic security testing expectations."
    ],
    "evidence_examples": [
     "Vulnerability scan reports",
     "Security review checklists",
     "Security testing plans"
    ]
   },
   {
    "level": 1,
    "name": "Initial",
    "description": "Security testing is limited, inconsistent, and largely dependent on individual initiative.",
    "key_characteristics": [
     "Security reviews occur sporadically.",
     "Vulnerability identification is largely reactive.",
     "Security validation is often performed late in the development lifecycle."
    ],
    "level_up_criteria": [
     "Establish repeatable security testing activities for qualifying applications or services.",
     "Incorporate automated or semi-automated security testing into parts of the development lifecycle."
    ],
    "evidence_examples": [
     "SAST scan results",
     "Dependency scanning reports",
     "Vulnerability management tickets"
    ]
   },
   {
    "level": 2,
    "name": "Developing",
    "description": "Basic security testing capabilities exist, but coverage, consistency, and remediation effectiveness vary significantly.",
    "key_characteristics": [
     "Security testing is performed on selected applications or release types.",
     "Automated scanning exists but is inconsistently applied.",
     "Security testing coverage differs across systems and repositories."
    ],
    "level_up_criteria": [
     "Integrate security testing into standard development and delivery workflows.",
     "Establish documented requirements for security testing activities based on system risk and…"
    ],
    "evidence_examples": [
     "Pipeline-integrated security scans",
     "Security quality gates",
     "Threat modeling outputs"
    ]
   },
   {
    "level": 3,
    "name": "Defined",
    "description": "Security testing practices are standardized, repeatable, and integrated into delivery workflows.",
    "key_characteristics": [
     "Security testing occurs as part of normal software delivery activities.",
     "Security requirements are documented and consistently applied.",
     "Security testing is tied to application risk."
    ],
    "level_up_criteria": [
     "Measure security testing effectiveness and vulnerability management performance.",
     "Track vulnerability trends, remediation timelines, and recurring security issues."
    ],
    "evidence_examples": [
     "Vulnerability dashboards",
     "Risk trend reporting",
     "Security metrics reviews"
    ]
   },
   {
    "level": 4,
    "name": "Measured",
    "description": "Security testing effectiveness and vulnerability management performance are measured and actively managed.",
    "key_characteristics": [
     "Security testing coverage and effectiveness are monitored.",
     "Vulnerability trends are tracked over time.",
     "Resolution performance is measured and managed."
    ],
    "level_up_criteria": [
     "Continuously adapt security testing based on evolving threats and risk exposure.",
     "Automate security validation wherever technically feasible."
    ],
    "evidence_examples": [
     "Risk-based security testing strategies",
     "Continuous security validation",
     "Automated policy enforcement"
    ]
   },
   {
    "level": 5,
    "name": "Optimizing",
    "description": "Security validation is continuously improved, risk-informed, and fully embedded in engineering practices.",
    "key_characteristics": [
     "Security testing evolves alongside emerging threats.",
     "Automated validation is extensively integrated throughout delivery workflows.",
     "Security controls adapt based on risk and context."
    ],
    "level_up_criteria": [],
    "evidence_examples": []
   }
  ]
 },
 {
  "id": "7",
  "title": "Testing & QE – Performance & Reliability Testing",
  "definition": "Load, scalability, and resilience testing that validates system behavior against defined SLOs and SLIs under stress and failure conditions to support predictable performance.",
  "na_description": "Not applicable if the team does not own software services, APIs, or workload-bearing systems. This includes teams that operate internal platforms without service-level traffic,…",
  "levels": [
   {
    "level": 0,
    "name": "Below Baseline",
    "description": "The team conducts no load, scalability, or resilience testing for their services.",
    "key_characteristics": [
     "None. System behavior under load, failure, scaling events, or dependency disruption is unknown."
    ],
    "level_up_criteria": [
     "Identify critical services, APIs, or user-facing workloads requiring performance validation.",
     "Execute at least one performance or reliability test against a production-relevant workload."
    ],
    "evidence_examples": [
     "Load test reports",
     "Performance test plans",
     "Initial capacity assessments"
    ]
   },
   {
    "level": 1,
    "name": "Initial",
    "description": "Performance and reliability testing is largely absent; behavior under load or failure is unknown.",
    "key_characteristics": [
     "SLOs and SLIs are undefined.",
     "No targets exist for latency, throughput, availability, or error rates.",
     "Testing occurs infrequently and often only after incidents."
    ],
    "level_up_criteria": [
     "Establish repeatable performance or reliability testing activities.",
     "Define basic performance scenarios aligned to expected usage patterns."
    ],
    "evidence_examples": [
     "Load testing scripts",
     "Reliability test suites",
     "Capacity planning documentation"
    ]
   },
   {
    "level": 2,
    "name": "Developing",
    "description": "Basic load or resilience checks exist but are inconsistent and not used in release decisions.",
    "key_characteristics": [
     "Testing scenarios are shallow and limited to basic load or smoke testing.",
     "Testing execution is largely manual.",
     "Workloads do not consistently reflect production traffic patterns."
    ],
    "level_up_criteria": [
     "Define and document SLOs and SLIs for key services.",
     "Establish performance thresholds supporting release readiness decisions."
    ],
    "evidence_examples": [
     "SLO and SLI documentation",
     "Performance testing standards",
     "Release readiness criteria"
    ]
   },
   {
    "level": 3,
    "name": "Defined",
    "description": "Performance expectations are documented and validated for key systems before promotion.",
    "key_characteristics": [
     "SLOs and SLIs are defined for critical services.",
     "Metrics such as p95 latency, p99 latency, throughput, availability, and error rates are documented.",
     "Standardized load, spike, and soak tests are executed."
    ],
    "level_up_criteria": [
     "Track performance and reliability trends across releases.",
     "Measure system behavior relative to established SLOs and SLIs."
    ],
    "evidence_examples": [
     "Performance dashboards",
     "Release-over-release trend reporting",
     "Capacity forecasting reports"
    ]
   },
   {
    "level": 4,
    "name": "Measured",
    "description": "Performance and reliability suites are repeatable, instrumented, and integrated into release decisions to reduce operational risk.",
    "key_characteristics": [
     "Trends are monitored across releases and environments.",
     "Performance regressions can be identified and measured.",
     "Execution is integrated into delivery workflows."
    ],
    "level_up_criteria": [
     "Continuously validate performance and resilience using production-informed testing strategies.",
     "Conduct routine resilience engineering activities, including fault injection or chaos…"
    ],
    "evidence_examples": [
     "Chaos engineering exercises",
     "Fault injection testing",
     "Error budget reviews"
    ]
   },
   {
    "level": 5,
    "name": "Optimizing",
    "description": "Testing is continuous, production-informed, and focused on preventing impact before it occurs.",
    "key_characteristics": [
     "Traffic patterns used in testing resemble real production conditions.",
     "Testing includes concurrency, peak demand, and downstream dependency variation.",
     "Chaos or fault-injection testing validates resiliency mechanisms."
    ],
    "level_up_criteria": [],
    "evidence_examples": []
   }
  ]
 },
 {
  "id": "8",
  "title": "Security Control SDLC & Code Review Practices",
  "definition": "Standardized, automated, and auditable security controls, code review guidelines, and threat-modeling practices applied throughout development.",
  "na_description": "Not applicable if the team does not develop or modify code, configuration, scripts, or Infrastructure-as-Code that requires secure design, threat modeling, or peer code review.",
  "levels": [
   {
    "level": 0,
    "name": "Below Baseline",
    "description": "Security checks and code reviews are not performed, and changes proceed without structured review or secure SDLC activities.",
    "key_characteristics": [
     "None. Changes can be introduced into systems without peer validation, security assessment, or secure…"
    ],
    "level_up_criteria": [
     "Establish a basic peer review process for code, configuration, scripts, or Infrastructure-as-Code…",
     "Identify individuals authorized to review and approve changes."
    ],
    "evidence_examples": [
     "Pull request reviews",
     "Merge request approvals",
     "Review checklists"
    ]
   },
   {
    "level": 1,
    "name": "Initial",
    "description": "Security and code review practices are informal, inconsistent, and dependent on individual judgment.",
    "key_characteristics": [
     "Reviews occur inconsistently without defined expectations regarding scope, depth, or evidence.",
     "Threat modeling is informal and performed only when initiated by individuals.",
     "Secure design considerations are ad hoc."
    ],
    "level_up_criteria": [
     "Define minimum review expectations across repositories and development teams.",
     "Require peer review for most changes prior to merge."
    ],
    "evidence_examples": [
     "Peer review standards",
     "Security review checklists",
     "Repository review policies"
    ]
   },
   {
    "level": 2,
    "name": "Developing",
    "description": "Basic security and review expectations exist, but adoption, depth, and documentation vary by repository or change type.",
    "key_characteristics": [
     "Peer review occurs, but review quality and consistency vary.",
     "Security checks exist for some changes, including SAST or dependency scanning.",
     "Threat modeling guidance is available but not consistently applied."
    ],
    "level_up_criteria": [
     "Document formal code review standards and reviewer expectations.",
     "Establish required security checkpoints for applicable changes."
    ],
    "evidence_examples": [
     "Secure SDLC standards",
     "Threat modeling documentation",
     "Protected branch configuration"
    ]
   },
   {
    "level": 3,
    "name": "Defined",
    "description": "Secure SDLC and code review practices are documented, repeatable, and consistently applied.",
    "key_characteristics": [
     "Review standards are documented.",
     "Expectations for security considerations, quality checks, and required reviewers are established.",
     "Threat modeling is applied predictably using structured methods."
    ],
    "level_up_criteria": [
     "Measure adherence to review and secure SDLC practices.",
     "Track security findings identified through reviews and security controls."
    ],
    "evidence_examples": [
     "Review quality dashboards",
     "Security findings reporting",
     "Review cycle-time metrics"
    ]
   },
   {
    "level": 4,
    "name": "Measured",
    "description": "Secure SDLC activities are integrated with delivery workflows and produce measurable signals.",
    "key_characteristics": [
     "Review quality is monitored through measurable indicators.",
     "Comment quality, defect discovery, and review cycle times are observed.",
     "Security findings are tracked and analyzed."
    ],
    "level_up_criteria": [
     "Automatically enforce review and security control requirements through tooling.",
     "Prevent qualifying changes from being merged when required reviews or security validations are…"
    ],
    "evidence_examples": [
     "Automated merge protection controls",
     "Policy-as-Code enforcement",
     "Risk-based security workflows"
    ]
   },
   {
    "level": 5,
    "name": "Optimizing",
    "description": "Secure engineering practices are embedded into behavior, tooling, and governance, reducing risk proactively.",
    "key_characteristics": [
     "Automated guardrails prevent merges when required reviews or security checks have not completed.",
     "Threat modeling is proactive and continuously revisited as systems evolve.",
     "Review practices continuously improve based on observed defects, vulnerabilities, and outcomes."
    ],
    "level_up_criteria": [],
    "evidence_examples": []
   }
  ]
 },
 {
  "id": "9",
  "title": "Engineering Governance",
  "definition": "Clear decision rights, guardrails, and oversight mechanisms that ensure predictable engineering outcomes through formal gates, risk controls, funding alignment, and governance forums that enforce consistency and…",
  "na_description": "Not applicable if the team does not make engineering or technical decisions requiring documented standards, approval gates, or governance participation.",
  "levels": [
   {
    "level": 0,
    "name": "Below Baseline",
    "description": "Engineering decisions occur informally without documented standards, gate criteria, or defined decision rights.",
    "key_characteristics": [
     "None. Engineering decisions are made without documented governance structures, approval requirements,…"
    ],
    "level_up_criteria": [
     "Identify individuals or groups responsible for engineering decision-making.",
     "Define at least one governance forum, approval mechanism, or escalation path."
    ],
    "evidence_examples": [
     "Architecture review meetings",
     "Approval records",
     "Engineering leadership forums"
    ]
   },
   {
    "level": 1,
    "name": "Initial",
    "description": "Engineering decisions are inconsistent and dependent on informal escalation or individual judgment.",
    "key_characteristics": [
     "Decision rights are unclear, creating ambiguity around who approves design, security, platform, or delivery…",
     "Guardrails are limited and poorly documented.",
     "Escalation paths rely heavily on personal networks and relationships."
    ],
    "level_up_criteria": [
     "Document governance processes for common engineering decisions.",
     "Define which engineering changes require review, approval, or escalation."
    ],
    "evidence_examples": [
     "Governance charters",
     "Engineering standards documentation",
     "Approval workflows"
    ]
   },
   {
    "level": 2,
    "name": "Developing",
    "description": "Some governance forums and standards exist, but expectations and decision pathways vary.",
    "key_characteristics": [
     "Standards are partially documented, but adoption varies across teams and work types.",
     "Governance forums exist, but engagement is inconsistent.",
     "Governance activities are not always tied to delivery outcomes."
    ],
    "level_up_criteria": [
     "Define clear decision rights and approval authorities.",
     "Establish documented governance standards covering engineering, security, release, and operational…"
    ],
    "evidence_examples": [
     "RACI or decision-rights matrix",
     "Architecture review standards",
     "Release governance requirements"
    ]
   },
   {
    "level": 3,
    "name": "Defined",
    "description": "Engineering governance is documented, repeatable, and aligned to clear decision rights and controls.",
    "key_characteristics": [
     "Decision rights are established and communicated.",
     "Governance processes define which decisions require approval, review, or escalation.",
     "Risk controls establish minimum safeguards for code, configuration, Infrastructure-as-Code, and environment…"
    ],
    "level_up_criteria": [
     "Measure governance effectiveness using defined indicators.",
     "Track governance exceptions and their outcomes."
    ],
    "evidence_examples": [
     "Governance dashboards",
     "Approval cycle reporting",
     "Exception trend analysis"
    ]
   },
   {
    "level": 4,
    "name": "Measured",
    "description": "Governance processes are monitored for effectiveness, timeliness, and delivery impact.",
    "key_characteristics": [
     "Decision quality is reviewed and evaluated.",
     "Governance evidence is assessed for completeness and usefulness.",
     "Exceptions are tracked and analyzed."
    ],
    "level_up_criteria": [
     "Automate governance controls wherever feasible.",
     "Enforce engineering standards through tooling and delivery workflows."
    ],
    "evidence_examples": [
     "Policy-as-Code controls",
     "Automated approval gates",
     "Governance quality metrics"
    ]
   },
   {
    "level": 5,
    "name": "Optimizing",
    "description": "Governance functions as enabling guardrails, with autonomy supported by clear standards and automated controls.",
    "key_characteristics": [
     "Guardrails are automated and embedded into tooling.",
     "Policy logic enforces governance expectations through workflows and controls.",
     "Teams are empowered to make local decisions when readiness signals and evidence requirements are satisfied."
    ],
    "level_up_criteria": [],
    "evidence_examples": []
   }
  ]
 },
 {
  "id": "10",
  "title": "Monitoring, Observability & Runtime Security",
  "definition": "Collection and use of metrics, logs, traces, and security signals to detect issues early, respond quickly, and continuously improve reliability. 【1-58c0fd】",
  "na_description": "Not applicable if the team does not own or operate software services, platforms, or infrastructure requiring system health monitoring, observability, or runtime security signals.…",
  "levels": [
   {
    "level": 0,
    "name": "Below Baseline",
    "description": "The team has no monitoring, logging, or alerting and relies entirely on user reports or manual checks to detect issues. 【1-58c0fd】",
    "key_characteristics": [
     "None. Operational visibility is absent and issue detection is entirely reactive."
    ],
    "level_up_criteria": [
     "Establish basic monitoring for at least one critical service, application, or platform component.",
     "Collect at least one operational signal (metrics, logs, or alerts)."
    ],
    "evidence_examples": [
     "Monitoring dashboards",
     "Alert configurations",
     "Log aggregation tools"
    ]
   },
   {
    "level": 1,
    "name": "Initial",
    "description": "System health visibility is minimal and reactive; issues are discovered after user impact. 【1-58c0fd】",
    "key_characteristics": [
     "Little health visibility exists.",
     "Issues are detected through user reports or manual checks rather than proactive monitoring.",
     "SLOs and SLIs are not defined."
    ],
    "level_up_criteria": [
     "Implement monitoring across multiple critical services or environments.",
     "Define alerting thresholds for key operational conditions."
    ],
    "evidence_examples": [
     "Alert policies",
     "Dashboard inventories",
     "Operational runbooks"
    ]
   },
   {
    "level": 2,
    "name": "Developing",
    "description": "Basic monitoring exists in some services, but coverage, alerting, and response vary widely. 【1-58c0fd】",
    "key_characteristics": [
     "Monitoring exists for selected systems but coverage is inconsistent.",
     "Metrics, logs, and traces are only partially implemented.",
     "Alerting reliability varies."
    ],
    "level_up_criteria": [
     "Define SLIs and SLOs for qualifying systems.",
     "Collect and retain required metrics, logs, and traces."
    ],
    "evidence_examples": [
     "SLO and SLI documentation",
     "Standard observability requirements",
     "Runbooks"
    ]
   },
   {
    "level": 3,
    "name": "Defined",
    "description": "Monitoring and observability expectations are documented and applied to critical services before promotion. 【1-58c0fd】",
    "key_characteristics": [
     "SLOs and SLIs are established for critical services.",
     "Metrics, logs, and traces are consistently collected.",
     "Operational signals are routed into approved observability platforms."
    ],
    "level_up_criteria": [
     "Measure operational performance using defined reliability indicators.",
     "Track MTTD, MTTR, incident trends, service reliability, and alert effectiveness."
    ],
    "evidence_examples": [
     "Reliability dashboards",
     "Incident trend reporting",
     "ServiceNow integrations"
    ]
   },
   {
    "level": 4,
    "name": "Measured",
    "description": "Observability data is repeatable, correlated, and integrated into incident response and release decisions. 【1-58c0fd】",
    "key_characteristics": [
     "Reliability indicators are monitored over time.",
     "Incident trends are visible and actionable.",
     "Alerts create tickets and operational actions automatically."
    ],
    "level_up_criteria": [
     "Implement predictive detection and anomaly identification capabilities.",
     "Automate correlation of operational, performance, and security signals."
    ],
    "evidence_examples": [
     "Anomaly detection capabilities",
     "Automated remediation workflows",
     "Runtime security monitoring"
    ]
   },
   {
    "level": 5,
    "name": "Optimizing",
    "description": "Monitoring, observability, and runtime security operate as a predictive, prevention-oriented capability. 【1-58c0fd】",
    "key_characteristics": [
     "Predictive detection surfaces anomalies before customer impact occurs.",
     "Automated response actions reduce operational risk.",
     "Runtime security is integrated into operational workflows."
    ],
    "level_up_criteria": [],
    "evidence_examples": []
   }
  ]
 },
 {
  "id": "11",
  "title": "Environment Management",
  "definition": "Consistency, lifecycle governance, and automation of non-production and production environments, including promotion paths and rollback readiness.",
  "na_description": "Not applicable if the team does not provision, manage, or operate any non-production or production environments.",
  "levels": [
   {
    "level": 0,
    "name": "Below Baseline",
    "description": "Environment setup, promotion, and rollback are fully manual with no defined workflow or criteria.",
    "key_characteristics": [
     "None. Environment management is entirely manual and dependent on individual effort."
    ],
    "level_up_criteria": [
     "Identify and document all environments used by the team.",
     "Establish ownership and support responsibilities for each environment."
    ],
    "evidence_examples": [
     "Environment inventory",
     "Environment ownership documentation",
     "Provisioning procedures"
    ]
   },
   {
    "level": 1,
    "name": "Initial",
    "description": "Environments are manually managed and inconsistent, dependent on individual knowledge, leading to drift, rework, and unreliable validation.",
    "key_characteristics": [
     "Environments are configured manually and rely on individual knowledge rather than documented standards.",
     "Development environments may require CRQs or production-level approvals for routine work.",
     "Environment drift occurs between non-production and production environments."
    ],
    "level_up_criteria": [
     "Establish baseline standards for environment configuration and management.",
     "Document environment promotion workflows."
    ],
    "evidence_examples": [
     "Environment standards",
     "Environment architecture documentation",
     "Promotion workflow documentation"
    ]
   },
   {
    "level": 2,
    "name": "Developing",
    "description": "Basic standards exist, but provisioning, refresh, and promotion practices vary widely across environments.",
    "key_characteristics": [
     "Partial environment standards are present.",
     "Environment setup differs across cloud, co-location, and on-prem environments.",
     "Development environments may still rely on production-style controls and approvals."
    ],
    "level_up_criteria": [
     "Define a standard promotion path across environments.",
     "Establish readiness criteria for environment promotion."
    ],
    "evidence_examples": [
     "Promotion path documentation",
     "Environment readiness checklists",
     "Environment lifecycle standards"
    ]
   },
   {
    "level": 3,
    "name": "Defined",
    "description": "Environment management is documented and repeatable, with clear promotion paths and meaningful separation of development and customer-facing…",
    "key_characteristics": [
     "Promotion paths are clearly defined.",
     "Standard progression exists across environments.",
     "Ownership and access management are documented."
    ],
    "level_up_criteria": [
     "Automate provisioning and configuration management where appropriate.",
     "Monitor environment health, availability, and configuration consistency."
    ],
    "evidence_examples": [
     "Automated provisioning workflows",
     "Environment health dashboards",
     "Drift reports"
    ]
   },
   {
    "level": 4,
    "name": "Measured",
    "description": "Provisioning, configuration, and promotion are automated and monitored, with drift and environment health tracked for predictability.",
    "key_characteristics": [
     "Provisioning and configuration activities are automated.",
     "Environment setup variation is reduced.",
     "Environment drift is measured and monitored."
    ],
    "level_up_criteria": [
     "Manage environments through Configuration-as-Code practices.",
     "Implement automated drift detection and remediation."
    ],
    "evidence_examples": [
     "Infrastructure-as-Code repositories",
     "Configuration-as-Code standards",
     "Automated drift remediation"
    ]
   },
   {
    "level": 5,
    "name": "Optimizing",
    "description": "Environments are self-service, Configuration-as-Code driven, and continuously remediated through automated controls.",
    "key_characteristics": [
     "Configuration-as-Code governs environment definitions.",
     "Environment consistency is enforced through automation.",
     "Drift is automatically detected and remediated."
    ],
    "level_up_criteria": [],
    "evidence_examples": []
   }
  ]
 },
 {
  "id": "12",
  "title": "Release Management & Operational Reliability",
  "definition": "Documented, automated, and tested operational processes—including runbooks, rollback procedures, readiness checks, incident learnings, and reliability engineering—to ensure predictable, resilient, production-safe…",
  "na_description": "This dimension does not apply if the team does not operate services or participate in production-related support, readiness, rollback, or operational processes.",
  "levels": [
   {
    "level": 0,
    "name": "Below Baseline",
    "description": "Operational delivery is manual, undocumented, and reactive, with no established runbooks, readiness checks, or rollback procedures.",
    "key_characteristics": [
     "None. Production readiness, recovery, and operational support are largely improvised and dependent on…"
    ],
    "level_up_criteria": [
     "Document basic operational support procedures.",
     "Identify ownership for operational readiness, support, and recovery activities."
    ],
    "evidence_examples": [
     "Operational procedures",
     "Production support documentation",
     "Initial runbooks"
    ]
   },
   {
    "level": 1,
    "name": "Initial",
    "description": "Operational delivery relies on informal knowledge, manual intervention, and reactive support.",
    "key_characteristics": [
     "Runbooks are limited, informal, or not maintained.",
     "Readiness checks occur through individual judgment.",
     "Rollback approaches are unclear and performed ad hoc."
    ],
    "level_up_criteria": [
     "Create runbooks for recurring operational activities.",
     "Establish standard readiness checklists before production changes."
    ],
    "evidence_examples": [
     "Runbooks",
     "Readiness checklists",
     "Rollback documentation"
    ]
   },
   {
    "level": 2,
    "name": "Developing",
    "description": "Basic operational documentation exists, but completeness, accuracy, and adoption vary.",
    "key_characteristics": [
     "Runbooks exist but may be outdated or inconsistently used.",
     "Readiness checklists are available but do not consistently govern production readiness decisions.",
     "Rollback procedures are documented but rarely rehearsed."
    ],
    "level_up_criteria": [
     "Establish maintained runbooks with clear ownership.",
     "Define readiness criteria covering environment health, service validation, and deployment readiness."
    ],
    "evidence_examples": [
     "Maintained runbooks",
     "Readiness standards",
     "Rollback validation records"
    ]
   },
   {
    "level": 3,
    "name": "Defined",
    "description": "Operational practices are documented, repeatable, and consistently applied for critical services.",
    "key_characteristics": [
     "Runbooks are maintained and include clear execution criteria.",
     "Readiness criteria cover environment health, configuration baselines, and service validation.",
     "Rollback procedures are validated in non-production environments."
    ],
    "level_up_criteria": [
     "Validate runbook execution through exercises, simulations, or automation.",
     "Measure readiness effectiveness and rollback effectiveness."
    ],
    "evidence_examples": [
     "Operational simulations",
     "Runbook execution testing",
     "Reliability dashboards"
    ]
   },
   {
    "level": 4,
    "name": "Measured",
    "description": "Operational practices are tested, automated where practical, and measured using reliability indicators.",
    "key_characteristics": [
     "Runbook execution is validated through exercises, simulations, or automation.",
     "Readiness effectiveness is measured.",
     "Rollback effectiveness is monitored."
    ],
    "level_up_criteria": [
     "Use telemetry and operational insights to continuously improve operational procedures.",
     "Automate rollback where appropriate."
    ],
    "evidence_examples": [
     "Telemetry-driven runbook improvements",
     "Automated rollback capabilities",
     "Automated readiness validations"
    ]
   },
   {
    "level": 5,
    "name": "Optimizing",
    "description": "Reliability engineering is embedded into delivery and operations, driving continuous improvement.",
    "key_characteristics": [
     "Runbooks evolve using telemetry, incident learnings, and operational feedback.",
     "Rollback capabilities are automated and predictable.",
     "Readiness checks proactively identify issues before production impact."
    ],
    "level_up_criteria": [],
    "evidence_examples": []
   }
  ]
 },
 {
  "id": "13",
  "title": "Platform Reusability & Patterns",
  "definition": "Availability and adoption of reusable internal platforms, golden paths, templates, and shared components that reduce duplication and accelerate delivery.",
  "na_description": "The team neither produces nor consumes reusable platform assets (golden paths, templates, shared components) and is not expected to do so for its scope of work.",
  "levels": [
   {
    "level": 0,
    "name": "Below Baseline",
    "description": "Reusable assets are not used or maintained; solutions are recreated from scratch for recurring needs.",
    "key_characteristics": [
     "None. Teams build independently and repeatedly solve the same problems without reusable engineering assets."
    ],
    "level_up_criteria": [
     "Identify common engineering activities that could benefit from reuse.",
     "Establish at least one reusable asset, template, or shared component."
    ],
    "evidence_examples": [
     "Shared templates",
     "Reusable scripts",
     "Common component libraries"
    ]
   },
   {
    "level": 1,
    "name": "Initial",
    "description": "Reuse is minimal and guidance is hard to find, leading to duplicate solutions and inconsistent patterns.",
    "key_characteristics": [
     "Reusable assets are scarce.",
     "Published templates, components, and golden paths are limited or unavailable.",
     "Discovery is difficult and relies on tribal knowledge."
    ],
    "level_up_criteria": [
     "Publish reusable assets in a common location.",
     "Introduce starter templates or shared engineering components."
    ],
    "evidence_examples": [
     "Shared repositories",
     "Internal templates",
     "Common engineering patterns"
    ]
   },
   {
    "level": 2,
    "name": "Developing",
    "description": "Some reusable assets exist, but adoption is voluntary and frequently customized or recreated.",
    "key_characteristics": [
     "Starter templates are available.",
     "Adoption depends on awareness and individual initiative.",
     "Teams frequently fork or customize reusable assets."
    ],
    "level_up_criteria": [
     "Publish documented golden paths.",
     "Establish clear guidance on when and how reusable assets should be used."
    ],
    "evidence_examples": [
     "Golden path documentation",
     "Component catalogs",
     "Versioned platform templates"
    ]
   },
   {
    "level": 3,
    "name": "Defined",
    "description": "Reusable patterns are documented, discoverable, and aligned to standard engineering practices with clear usage guidance.",
    "key_characteristics": [
     "Golden paths are published and maintained.",
     "Prerequisites and usage guidance are clearly documented.",
     "Reusable assets are discoverable through centralized indexes or catalogs."
    ],
    "level_up_criteria": [
     "Measure adoption of reusable assets.",
     "Track platform usage and variance from preferred patterns."
    ],
    "evidence_examples": [
     "Adoption dashboards",
     "Usage analytics",
     "Governance workflows"
    ]
   },
   {
    "level": 4,
    "name": "Measured",
    "description": "Reuse is actively promoted, measured, and improved through feedback loops that reduce variance.",
    "key_characteristics": [
     "Adoption of templates, patterns, and components is measured.",
     "Real-world usage data informs improvement priorities.",
     "Feedback loops refine documentation and implementation patterns."
    ],
    "level_up_criteria": [
     "Enable self-service consumption of platform capabilities.",
     "Implement telemetry-driven evolution of reusable assets."
    ],
    "evidence_examples": [
     "Self-service onboarding experiences",
     "Usage telemetry",
     "Platform analytics"
    ]
   },
   {
    "level": 5,
    "name": "Optimizing",
    "description": "Reusability operates as a platform capability offering well-governed, self-service patterns that evolve with measurable demand and outcomes.",
    "key_characteristics": [
     "Self-service consumption is the default experience.",
     "Discovery and onboarding are streamlined.",
     "Patterns evolve based on telemetry and operational feedback."
    ],
    "level_up_criteria": [],
    "evidence_examples": []
   }
  ]
 },
 {
  "id": "14",
  "title": "Software Development Mindset & Automation Culture",
  "definition": "Adoption of modern engineering principles, automation-first thinking, and developer enablement behaviors across the team.",
  "na_description": "This dimension is not applicable if the team does not build, configure, modify, or deliver technical solutions that require engineering discipline, automation, or consistent…",
  "levels": [
   {
    "level": 0,
    "name": "Below Baseline",
    "description": "The team relies entirely on manual work, task execution, and individual expertise, with no consistent engineering or automation behaviors.",
    "key_characteristics": [
     "None. Work is performed primarily through manual effort, tribal knowledge, and one-off execution patterns."
    ],
    "level_up_criteria": [
     "Establish basic engineering expectations and development standards.",
     "Identify repetitive manual activities suitable for automation."
    ],
    "evidence_examples": [
     "Engineering standards",
     "Team operating agreements",
     "Version-controlled assets"
    ]
   },
   {
    "level": 1,
    "name": "Initial",
    "description": "Work relies on manual effort and individual expertise, with limited evidence of modern engineering or automation-first behaviors.",
    "key_characteristics": [
     "Engineering mindset varies, with work frequently approached as one-off tasks rather than reusable, iterative…",
     "Automation is limited, with manual execution common and ClickOps patterns still present.",
     "Standards are applied inconsistently."
    ],
    "level_up_criteria": [
     "Adopt basic engineering principles across a majority of team members.",
     "Establish knowledge-sharing practices."
    ],
    "evidence_examples": [
     "Shared engineering documentation",
     "Team onboarding materials",
     "Knowledge-sharing sessions"
    ]
   },
   {
    "level": 2,
    "name": "Developing",
    "description": "Modern engineering practices are recognized as important, but adoption remains uneven or isolated.",
    "key_characteristics": [
     "Automation exists in pockets.",
     "Manual work remains common.",
     "Engineering principles are referenced but inconsistently applied."
    ],
    "level_up_criteria": [
     "Establish automation-first expectations.",
     "Define engineering work as code where appropriate (configuration, scripting, infrastructure,…"
    ],
    "evidence_examples": [
     "Team engineering playbook",
     "Shared automation standards",
     "Platform usage guidance"
    ]
   },
   {
    "level": 3,
    "name": "Defined",
    "description": "Modern engineering principles and automation-first behaviors are consistently applied and reinforced through team norms.",
    "key_characteristics": [
     "Automation-first behaviors reduce manual work.",
     "Shared expectations exist that engineering work should be treated as code where applicable.",
     "Reusable practices are maintained and encouraged."
    ],
    "level_up_criteria": [
     "Establish metrics related to automation adoption and engineering effectiveness.",
     "Track manual intervention frequency and recurring friction points."
    ],
    "evidence_examples": [
     "Engineering health metrics",
     "Coaching programs",
     "Platform adoption reports"
    ]
   },
   {
    "level": 4,
    "name": "Measured",
    "description": "Engineering behaviors are supported by metrics, coaching, and feedback loops that strengthen automation and reduce manual work.",
    "key_characteristics": [
     "Data guides engineering improvements.",
     "Coaching supports adoption of engineering practices.",
     "Manual work is systematically identified and targeted."
    ],
    "level_up_criteria": [
     "Proactively identify and automate manual activities.",
     "Contribute reusable patterns, templates, or platform assets."
    ],
    "evidence_examples": [
     "Automation adoption programs",
     "Golden path contributions",
     "Mentorship frameworks"
    ]
   },
   {
    "level": 5,
    "name": "Optimizing",
    "description": "Automation and engineering excellence are embedded into team culture and continuously improved.",
    "key_characteristics": [
     "Automation is proactive rather than reactive.",
     "Teams continuously convert manual activities into repeatable workflows.",
     "Engineering patterns are codified and shared."
    ],
    "level_up_criteria": [],
    "evidence_examples": []
   }
  ]
 },
 {
  "id": "15",
  "title": "Agile Planning & Backlog Management",
  "definition": "Consistency, transparency, and rigor in how work is planned, refined, prioritized, and executed using agile, team-level practices.",
  "na_description": "This dimension does not apply if the team does not plan or execute work using any structured backlog, agile routines, or prioritization processes.",
  "levels": [
   {
    "level": 0,
    "name": "Below Baseline",
    "description": "Work is unstructured and reactive, and the team does not maintain a backlog, defined intake, or consistent prioritization practices.",
    "key_characteristics": [
     "None. Work enters the system unpredictably and execution relies primarily on ad hoc requests, interruptions,…"
    ],
    "level_up_criteria": [
     "Establish a single location to track work.",
     "Define a basic intake process for new requests."
    ],
    "evidence_examples": [
     "Backlog tool",
     "Intake process",
     "Team work board"
    ]
   },
   {
    "level": 1,
    "name": "Initial",
    "description": "Work is reactive and intake is informal, with limited visibility into priorities or differentiation between planned work and operational…",
    "key_characteristics": [
     "Work is tracked inconsistently.",
     "Requests arrive through chat, email, meetings, and other informal channels.",
     "Backlog visibility is limited."
    ],
    "level_up_criteria": [
     "Establish and maintain a structured backlog.",
     "Define basic work item standards."
    ],
    "evidence_examples": [
     "Product backlog",
     "Refinement sessions",
     "Prioritization framework"
    ]
   },
   {
    "level": 2,
    "name": "Developing",
    "description": "Basic agile practices exist, but refinement, prioritization, and execution discipline vary across efforts.",
    "key_characteristics": [
     "A backlog exists but quality varies.",
     "Work items may lack acceptance criteria or clear outcomes.",
     "Refinement occurs but inconsistently."
    ],
    "level_up_criteria": [
     "Define backlog standards and readiness expectations.",
     "Establish predictable refinement and planning cadences."
    ],
    "evidence_examples": [
     "Definition of Ready",
     "Backlog standards",
     "Refinement cadence"
    ]
   },
   {
    "level": 3,
    "name": "Defined",
    "description": "Planning and backlog management are documented, repeatable, and aligned to transparent team-level routines.",
    "key_characteristics": [
     "The backlog is structured and actively maintained.",
     "Work items contain clear definitions, acceptance criteria, and outcomes.",
     "Refinement is predictable and recurring."
    ],
    "level_up_criteria": [
     "Measure planning effectiveness and delivery predictability.",
     "Track flow-based metrics such as cycle time, lead time, throughput, and WIP."
    ],
    "evidence_examples": [
     "Velocity metrics",
     "Burndown charts",
     "Cycle time reporting"
    ]
   },
   {
    "level": 4,
    "name": "Measured",
    "description": "Planning and execution are measured using flow, predictability, throughput, dependency, and delivery health indicators.",
    "key_characteristics": [
     "Flow metrics are actively used.",
     "Predictability is measured and discussed.",
     "Capacity balance is monitored."
    ],
    "level_up_criteria": [
     "Use objective prioritization methods to optimize value delivery.",
     "Continuously improve flow using operational and delivery telemetry."
    ],
    "evidence_examples": [
     "Value prioritization framework",
     "Flow optimization initiatives",
     "Dependency analytics"
    ]
   },
   {
    "level": 5,
    "name": "Optimizing",
    "description": "Agile planning functions as a continuous value-management capability that maximizes flow and strategic impact.",
    "key_characteristics": [
     "Prioritization is data-driven.",
     "Impact, risk, effort, operational load, and dependencies influence sequencing decisions.",
     "Teams continuously optimize flow."
    ],
    "level_up_criteria": [],
    "evidence_examples": []
   }
  ]
 },
 {
  "id": "16",
  "title": "Design Standards & Technical Decision Process",
  "definition": "Use of architecture patterns, decision frameworks such as Architectural Decision Records (ADRs), and design reviews to ensure scalable, secure, and well-reasoned technical choices.",
  "na_description": "This dimension does not apply if the team does not make technical or architectural decisions (e.g., purely operational support without design, development, or configuration…",
  "levels": [
   {
    "level": 0,
    "name": "Below Baseline",
    "description": "Technical decisions occur informally without documented standards, decision records, or consistent review expectations.",
    "key_characteristics": [
     "None. Design decisions are uncontrolled, poorly documented, and difficult to reconstruct."
    ],
    "level_up_criteria": [
     "Establish basic design review expectations.",
     "Define who can make and approve technical decisions."
    ],
    "evidence_examples": [
     "Architecture standards",
     "Solution design documentation",
     "Technical decision logs"
    ]
   },
   {
    "level": 1,
    "name": "Initial",
    "description": "Technical decisions are made informally, inconsistently documented, and dependent on individual experience.",
    "key_characteristics": [
     "Standards are minimally documented.",
     "Decisions are often driven by individual preference, experience, or familiarity.",
     "Decision rationale is rarely captured."
    ],
    "level_up_criteria": [
     "Establish reference architecture patterns.",
     "Begin capturing Architectural Decision Records (ADRs) or equivalent documentation."
    ],
    "evidence_examples": [
     "Reference architectures",
     "ADR templates",
     "Design review records"
    ]
   },
   {
    "level": 2,
    "name": "Developing",
    "description": "Some design standards or review practices exist, but adoption and documentation vary by system or stakeholder.",
    "key_characteristics": [
     "Reference patterns are available but not consistently applied.",
     "ADR adoption is partial.",
     "Design reviews occur inconsistently."
    ],
    "level_up_criteria": [
     "Define architecture and design standards.",
     "Standardize use of ADRs or equivalent decision frameworks."
    ],
    "evidence_examples": [
     "Architecture standards",
     "Design review procedures",
     "ADR repositories"
    ]
   },
   {
    "level": 3,
    "name": "Defined",
    "description": "Design standards, review practices, and decision records are documented and consistently applied for meaningful technical choices.",
    "key_characteristics": [
     "Standards exist for architecture, APIs, data models, configuration, and Infrastructure-as-Code.",
     "ADRs capture rationale, alternatives, tradeoffs, risks, and approvals.",
     "Architecture and design reviews occur predictably."
    ],
    "level_up_criteria": [
     "Measure compliance with design standards.",
     "Evaluate the quality and consistency of decision records."
    ],
    "evidence_examples": [
     "Architecture governance metrics",
     "ADR quality reviews",
     "Standards compliance reporting"
    ]
   },
   {
    "level": 4,
    "name": "Measured",
    "description": "Technical decision practices are governed and assessed for quality, consistency, risk reduction, and implementation outcomes.",
    "key_characteristics": [
     "Decision quality is evaluated.",
     "Architecture consistency is measurable.",
     "Pattern adoption is monitored."
    ],
    "level_up_criteria": [
     "Continuously evolve standards based on operational outcomes and telemetry.",
     "Use prior decision history to inform future architectural decisions."
    ],
    "evidence_examples": [
     "Architectural analytics",
     "Design telemetry",
     "Golden path libraries"
    ]
   },
   {
    "level": 5,
    "name": "Optimizing",
    "description": "Technical decision-making operates as a mature engineering capability, balancing autonomy with architectural guardrails.",
    "key_characteristics": [
     "Patterns are curated and continuously refined.",
     "Decision intelligence leverages prior ADRs and outcomes.",
     "Governance guardrails are embedded in platforms and delivery workflows."
    ],
    "level_up_criteria": [],
    "evidence_examples": []
   }
  ]
 },
 {
  "id": "17",
  "title": "Engineering Metrics & Continuous Improvement",
  "definition": "Use of engineering, delivery, quality, reliability, and operational metrics to drive continuous improvement, inform decisions, and improve engineering outcomes.",
  "na_description": "This dimension does not apply if the team does not produce, consume, review, or act upon engineering, delivery, operational, quality, or reliability metrics.",
  "levels": [
   {
    "level": 0,
    "name": "Below Baseline",
    "description": "The team does not collect, review, or use engineering metrics. Decisions are made based on anecdotes, assumptions, or subjective judgment.",
    "key_characteristics": [
     "None. Improvement activities are reactive and lack supporting data."
    ],
    "level_up_criteria": [
     "Identify a small set of engineering or delivery metrics.",
     "Establish a recurring review cadence."
    ],
    "evidence_examples": [
     "Team dashboards",
     "Metrics reports",
     "Engineering scorecards"
    ]
   },
   {
    "level": 1,
    "name": "Initial",
    "description": "Some metrics exist, but collection is inconsistent and they are rarely used to drive behavior or decisions.",
    "key_characteristics": [
     "Metrics are collected sporadically.",
     "Different teams track different measures.",
     "Data quality is inconsistent."
    ],
    "level_up_criteria": [
     "Define standard engineering metrics.",
     "Establish recurring metric reviews."
    ],
    "evidence_examples": [
     "Standard metric catalog",
     "Team scorecards",
     "Weekly or sprint reviews"
    ]
   },
   {
    "level": 2,
    "name": "Developing",
    "description": "Metrics are collected and reviewed, but adoption, interpretation, and usage vary across teams.",
    "key_characteristics": [
     "Standard metrics exist but are interpreted inconsistently.",
     "Trends are visible but not always actionable.",
     "Engineering decisions are only partially data driven."
    ],
    "level_up_criteria": [
     "Define engineering metrics that align with delivery goals.",
     "Establish ownership for metric review and actions."
    ],
    "evidence_examples": [
     "Engineering dashboards",
     "Trend analysis",
     "Improvement backlogs"
    ]
   },
   {
    "level": 3,
    "name": "Defined",
    "description": "Engineering metrics are documented, consistently reviewed, and used to support team-level decision making.",
    "key_characteristics": [
     "Teams understand their metrics.",
     "Dashboards provide actionable visibility.",
     "Trends drive improvement discussions."
    ],
    "level_up_criteria": [
     "Measure improvement effectiveness over time.",
     "Track engineering health, quality, reliability, and delivery performance."
    ],
    "evidence_examples": [
     "DORA metrics",
     "Reliability metrics",
     "Engineering health reports"
    ]
   },
   {
    "level": 4,
    "name": "Measured",
    "description": "Engineering, operational, and delivery metrics are actively used to improve outcomes and guide decisions.",
    "key_characteristics": [
     "Teams track performance trends over time.",
     "Improvement efforts are measurable.",
     "Metrics influence prioritization and planning."
    ],
    "level_up_criteria": [
     "Use predictive indicators to identify future risks or opportunities.",
     "Integrate delivery, quality, operational, and engineering metrics into a unified view."
    ],
    "evidence_examples": [
     "Predictive analytics",
     "Engineering effectiveness platforms",
     "Portfolio health dashboards"
    ]
   },
   {
    "level": 5,
    "name": "Optimizing",
    "description": "Engineering metrics operate as a continuous learning and optimization capability that drives strategic, operational, and engineering decisions.",
    "key_characteristics": [
     "Metrics are deeply integrated into engineering culture.",
     "Teams proactively identify improvement opportunities.",
     "Leading indicators help prevent future problems."
    ],
    "level_up_criteria": [],
    "evidence_examples": []
   }
  ]
 }
];

/**
 * Every rubric the mock knows, by version — one row per `(rubric_version, id)`
 * the table would hold. There is one today; a second is added here and nowhere
 * else, and `assessment_teams.rubric_version` is how a team picks between them.
 */
export const RUBRICS: Record<string, RubricDimensionDef[]> = {
  [DEFAULT_RUBRIC_VERSION]: stampRubric(DEFAULT_RUBRIC_VERSION, RUBRIC_V1_DIMENSIONS),
};

/** The current rubric's seventeen dimensions — what an un-versioned read means. */
export const RUBRIC_DIMENSIONS: RubricDimensionDef[] = RUBRICS[DEFAULT_RUBRIC_VERSION]!;

/** One rubric's dimensions, or none — an unknown version is not the default. */
export const rubricDimensions = (version: string): RubricDimensionDef[] => RUBRICS[version] ?? [];

/** Every row of `assessment_rubric_dimensions`, across every version. */
export const allRubricDimensions = (): RubricDimensionDef[] => Object.values(RUBRICS).flat();

export const DIMENSION_IDS: string[] = RUBRIC_DIMENSIONS.map((d) => d.id);

export function rubricDimension(id: string, version: string = DEFAULT_RUBRIC_VERSION): RubricDimensionDef | undefined {
  return rubricDimensions(version).find((d) => d.id === id);
}

export function levelName(dimensionId: string, level: number | null, version: string = DEFAULT_RUBRIC_VERSION): string | null {
  if (level === null) return null;
  const dim = rubricDimension(dimensionId, version);
  return dim?.levels.find((l) => l.level === level)?.name ?? null;
}

// ─── Provenance / Evidence / Follow-ups / History ──────────────────────────

export interface Provenance {
  provenance_id: string;
  source_uri: string;
  captured_by: string;
  captured_at: string;
}

export type EvidenceSourceType = 'survey' | 'transcript' | 'document' | 'artifact' | 'touchpoint';
export type EvidenceClass = 'attested' | 'documented' | 'observed';

/**
 * The vocabulary `assessment_evidence.status` CHECKs, spelled once here so the
 * TYPE refuses what the column would refuse. It was `string` on both evidence
 * interfaces, which is how the unreachable lowercase `'pending'` default sat in
 * the DDL for as long as it did: nothing in TypeScript could tell the two
 * spellings apart, and the parity harness only sees the values a fixture row
 * happens to hold — never the ones a future writer could type.
 */
export type EvidenceStatus = 'PENDING' | 'CLASSIFIED' | 'SCORED';

export interface Evidence {
  evidence_id: string;
  dimension_id: string;
  source_type: EvidenceSourceType;
  excerpt: string;
  supports_level: number | null;
  captured_at: string;
  source_ref: string;
  scored: boolean;
  status: EvidenceStatus;
}

export type FollowUpStatus = 'OPEN' | 'ANSWERED' | 'DROPPED';

export interface FollowUpQuestion {
  question_id: string;
  dimension_id: string;
  text: string;
  target_audience: string;
  status: FollowUpStatus;
}

export interface DimensionHistoryEntry {
  from_level: number | null;
  to_level: number | null;
  is_na: boolean;
  rationale: string;
  evidence_ids: string[];
  source_meeting: string;
  changed_at: string;
  changed_by: string;
  /** Whether N/A was claimed on this entry, independent of `is_na` — N/A is
   * never self-granting (docs/assessment-tenant.md), so a claim with no
   * approved exception yet leaves `is_na: false` here but `na_claimed: true`.
   * Optional for backward-compat with history written before this existed. */
  na_claimed?: boolean;
}

export type Confidence = 'low' | 'moderate' | 'high';

export interface MockDimensionScore {
  dimension_id: string;
  current_level: number | null;
  is_na: boolean;
  confidence: Confidence;
  self_claimed_level: number | null;
  evidence_class: EvidenceClass | null;
  cap_applied: boolean;
  evidence: Evidence[];
  follow_up_questions: FollowUpQuestion[];
  history: DimensionHistoryEntry[];
  updated_at: string;
}

export interface EvidenceLogItem {
  evidence_id: string;
  dimension_id: string | null;
  source_type: EvidenceSourceType;
  excerpt: string;
  supports_level: number | null;
  captured_at: string;
  source_ref: string;
  scored: boolean;
  status: EvidenceStatus;
  /** Optional intake metadata — carried through from the intake form
   *  (title of the note/document, who captured it) so the provenance
   *  ledger has something better than the raw excerpt to show. */
  title?: string;
  captured_by?: string;
}

// ─── Teams ──────────────────────────────────────────────────────────────────

export interface RepoRef {
  name: string;
  gitlab_url: string;
}

export type ExceptionStatus = 'requested' | 'approved' | 'denied';
export type ExceptionSource = 'archetype' | 'known_exception' | 'submission' | 'manual';

export interface TeamException {
  dimension_id: string;
  status: ExceptionStatus;
  source: ExceptionSource;
  reason: string;
  approved_by: string;
  approved_at: string;
  /** Who staged the claim that opened this exception (session sub, or
   * `agent:<command>` when an agent run opened it) — never the body.
   * Optional: seeded/legacy exceptions predate this field. Backs the
   * "never the assessor who proposed it" self-approval refusal in
   * providers/assessment.ts's patchException. */
  requested_by?: string;
}

export interface ArchetypeOption {
  key: string;
  description: string;
}

/** The three values `formatTeamStatus` (portal `assessmentFormat.ts`) knows
 * how to render: 'NEW' -> "New", 'IN_PROGRESS' -> "In progress",
 * 'ASSESSED' -> "Assessed". `MockTeam.status` stays plain `string` (matches
 * the wire, which never re-types it), but writers should only ever produce
 * one of these three. */
export type TeamStatus = 'NEW' | 'IN_PROGRESS' | 'ASSESSED';

/**
 * A team's workflow status is a pure function of its dimension scores, never
 * a value some other code path sets by hand — the bug this exists to fix was
 * exactly that: a team could read "17/17 assessed" while `status` sat wherever
 * it was left at intake. `dims` need not have all 17 keys present (the Aurora
 * path only rows a dimension once it has been scored/excepted at least once);
 * a missing entry is treated the same as a fresh, un-scored dimension.
 *
 * - No dimension touched yet (no level recorded, no N/A claimed) -> NEW.
 * - Every applicable (non-N/A) dimension has a level -> ASSESSED. (A team
 *   whose every dimension carries an approved N/A exception has nothing left
 *   to score, so it counts as fully assessed too.)
 * - Anything in between -> IN_PROGRESS.
 */
export function deriveTeamStatus(dims: Record<string, MockDimensionScore>): TeamStatus {
  const scores = DIMENSION_IDS.map((id) => dims[id]);
  const touched = scores.some((s) => s != null && (s.current_level !== null || s.is_na));
  if (!touched) return 'NEW';
  const applicable = scores.filter((s) => !s?.is_na);
  const assessed = applicable.filter((s) => s != null && s.current_level !== null);
  return assessed.length >= applicable.length ? 'ASSESSED' : 'IN_PROGRESS';
}

export interface MockTeam {
  id: string;
  name: string;
  cohort: Cohort;
  /**
   * NEVER stored by this fixture and never read to answer a request — it is
   * `deriveTeamStatus(dimensions)` at read time, in `teamSummaryFromDims` /
   * `assembleTeamDetail`. `assessment_teams.status` is a real Aurora column
   * (default `'active'`, which is not even one of the three the portal can
   * render), so the Aurora row-mapper still fills this in; nothing consumes
   * it. Typing it beside the scores is how a team shipped reading
   * "New · 17/17 assessed".
   */
  status?: string;
  workflow_step: number;
  assessment_lead: string;
  contacts: string[];
  repos: RepoRef[];
  archetype: string | null;
  /**
   * The rubric this team's scores are expressed against — a key of `RUBRICS`,
   * and the whole reason `assessment_rubric_dimensions` is keyed on
   * `(rubric_version, id)`. Without it a stored level is a number with no
   * question attached, and editing the rubric silently reinterprets every score
   * already taken. Required, because a team scored against "whichever rubric
   * happens to be compiled in" is the defect, not a default.
   */
  rubric_version: string;
  exceptions: TeamException[];
  created_at: string;
  updated_at: string;
  contributors: { initials: string; name: string }[];
}
const seedArchetypes = (): ArchetypeOption[] => [
 {
  "key": "internal-tooling-no-deploy",
  "description": "Internal tooling teams that never deploy a customer-facing release artifact."
 },
 {
  "key": "no-prod-service",
  "description": "Teams that own no production service (docs sites, internal scripts only)."
 },
 {
  "key": "data-only-pipeline",
  "description": "Batch/data pipeline teams with no interactive service or UI."
 }
];

// In-memory, mutated by create/patch/delete so the UI round-trips under mock.
const seedTeams = (): MockTeam[] => [
 {
  "id": "TEAM-001",
  "name": "Northstar Payments",
  "cohort": "white_glove",
  "workflow_step": 4,
  "assessment_lead": "Priya Natarajan",
  "contacts": [
   "priya.natarajan@example.com",
   "sam.diallo@example.com"
  ],
  "repos": [
   {
    "name": "northstar-payments-api",
    "gitlab_url": "https://gitlab.example.com/payments/northstar-payments-api"
   },
   {
    "name": "northstar-payments-infra",
    "gitlab_url": "https://gitlab.example.com/payments/northstar-payments-infra"
   }
  ],
  "archetype": "internal-tooling-no-deploy",
  "rubric_version": "v1",
  "exceptions": [
   {
    "dimension_id": "6",
    "status": "approved",
    "source": "archetype",
    "reason": "Archetype \"internal-tooling-no-deploy\": the team ships no customer-facing release artifact, so dedicated security-testing gates do not apply beyond what CI already runs.",
    "approved_by": "lead-assessor:priya",
    "approved_at": daysAgo(10)
   },
   {
    "dimension_id": "7",
    "status": "requested",
    "source": "manual",
    "reason": "Team states they own no internet-facing service (internal reconciliation batch only) and asks for N/A on performance/reliability testing.",
    "approved_by": "",
    "approved_at": ""
   }
  ],
  "created_at": daysAgo(45),
  "updated_at": daysAgo(2),
  "contributors": [
   {
    "initials": "PN",
    "name": "Priya Natarajan"
   },
   {
    "initials": "SD",
    "name": "Sam Diallo"
   }
  ]
 },
 {
  "id": "TEAM-002",
  "name": "Kubernetes Operator",
  "cohort": "general",
  "workflow_step": 5,
  "assessment_lead": "Jordan Lee",
  "contacts": [
   "jordan.lee@example.com"
  ],
  "repos": [
   {
    "name": "k8s-operator",
    "gitlab_url": "https://gitlab.example.com/platform/k8s-operator"
   }
  ],
  "archetype": null,
  "rubric_version": "v1",
  "exceptions": [],
  "created_at": daysAgo(60),
  "updated_at": hoursAgo(5),
  "contributors": [
   {
    "initials": "JL",
    "name": "Jordan Lee"
   },
   {
    "initials": "CH",
    "name": "Connor Hoehn"
   }
  ]
 },
 {
  "id": "TEAM-003",
  "name": "Checkout Experience",
  "cohort": "self_service",
  "workflow_step": 3,
  "assessment_lead": "Sam Okafor",
  "contacts": [
   "sam.okafor@example.com"
  ],
  "repos": [
   {
    "name": "checkout-web",
    "gitlab_url": "https://gitlab.example.com/commerce/checkout-web"
   }
  ],
  "archetype": null,
  "rubric_version": "v1",
  "exceptions": [],
  "created_at": daysAgo(20),
  "updated_at": daysAgo(3),
  "contributors": [
   {
    "initials": "SO",
    "name": "Sam Okafor"
   }
  ]
 },
 {
  "id": "TEAM-004",
  "name": "Data Platform",
  "cohort": "white_glove",
  "workflow_step": 3,
  "assessment_lead": "Elena Marsh",
  "contacts": [
   "elena.marsh@example.com",
   "tomas.vega@example.com"
  ],
  "repos": [
   {
    "name": "data-platform-pipelines",
    "gitlab_url": "https://gitlab.example.com/data/data-platform-pipelines"
   }
  ],
  "archetype": null,
  "rubric_version": "v1",
  "exceptions": [],
  "created_at": daysAgo(15),
  "updated_at": daysAgo(6),
  "contributors": [
   {
    "initials": "EM",
    "name": "Elena Marsh"
   },
   {
    "initials": "TV",
    "name": "Tomas Vega"
   }
  ]
 },
 {
  "id": "TEAM-005",
  "name": "Notifications Service",
  "cohort": "general",
  "workflow_step": 2,
  "assessment_lead": "Dana Whitfield",
  "contacts": [
   "dana.whitfield@example.com"
  ],
  "repos": [],
  "archetype": null,
  "rubric_version": "v1",
  "exceptions": [],
  "created_at": daysAgo(10),
  "updated_at": daysAgo(4),
  "contributors": [
   {
    "initials": "DW",
    "name": "Dana Whitfield"
   }
  ]
 },
 {
  "id": "TEAM-006",
  "name": "Fraud Detection ML",
  "cohort": "self_service",
  "workflow_step": 1,
  "assessment_lead": "",
  "contacts": [],
  "repos": [],
  "archetype": null,
  "rubric_version": "v1",
  "exceptions": [],
  "created_at": daysAgo(2),
  "updated_at": daysAgo(2),
  "contributors": []
 },
 {
  "id": "TEAM-007",
  "name": "Internal Tools",
  "cohort": "general",
  "workflow_step": 1,
  "assessment_lead": "",
  "contacts": [],
  "repos": [],
  "archetype": null,
  "rubric_version": "v1",
  "exceptions": [],
  "created_at": daysAgo(1),
  "updated_at": daysAgo(1),
  "contributors": []
 }
];

// team_id -> dimension_id ("1".."17") -> score. Mutated in place by
// applyScores/resetAssessment so the UI round-trips under mock.
const seedAssessments = (): Record<string, Record<string, MockDimensionScore>> => ({
 "TEAM-001": {
  "1": {
   "dimension_id": "1",
   "current_level": 2,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": 5,
   "evidence_class": "attested",
   "cap_applied": false,
   "evidence": [
    {
     "evidence_id": "EV-2b6f4a6ec16b",
     "dimension_id": "1",
     "source_type": "survey",
     "excerpt": "Continuous Integration (CI): our practice matches \"Developing\" — this is what the team told us in the self-assessment survey, nothing more.",
     "supports_level": 2,
     "captured_at": daysAgo(9),
     "source_ref": "PROV-639265a04bca",
     "scored": true,
     "status": "SCORED"
    }
   ],
   "follow_up_questions": [
    {
     "question_id": "Q-ea4eac03521a",
     "dimension_id": "1",
     "text": "You rated CI as \"Leading\" but the pipeline evidence you linked only shows manual, ad-hoc runs — can you share branch-protection settings and recent pipeline history so we can verify past Level 2?",
     "target_audience": "team",
     "status": "OPEN"
    },
    {
     "question_id": "Q-73d3d755b830",
     "dimension_id": "1",
     "text": "Is there a dashboard or export showing CI running automatically across all repositories, not just this one?",
     "target_audience": "team",
     "status": "OPEN"
    }
   ],
   "history": [
    {
     "from_level": null,
     "to_level": 2,
     "is_na": false,
     "rationale": "Self-claimed Level 5 (\"Leading\") is not supported by any linked evidence beyond the team's own account, and what was reviewed shows CI triggers automatically on push for only one of two repositories with no merge gate. Verification reaches Level 2 and stops there — the claim stays open.",
     "evidence_ids": [
      "EV-2b6f4a6ec16b"
     ],
     "source_meeting": "teams/TEAM-001 (artifact review)",
     "changed_at": daysAgo(9),
     "changed_by": "orgiq-assessment-scorer"
    }
   ],
   "updated_at": daysAgo(2)
  },
  "2": {
   "dimension_id": "2",
   "current_level": 3,
   "is_na": false,
   "confidence": "moderate",
   "self_claimed_level": 4,
   "evidence_class": "documented",
   "cap_applied": false,
   "evidence": [
    {
     "evidence_id": "EV-ef07e15d5c36",
     "dimension_id": "2",
     "source_type": "document",
     "excerpt": "Continuous Delivery (CD): our practice matches \"Defined\" — we pointed the assessor at a written runbook/standard covering this.",
     "supports_level": 3,
     "captured_at": daysAgo(9),
     "source_ref": "PROV-2356de9da12e",
     "scored": true,
     "status": "SCORED"
    }
   ],
   "follow_up_questions": [
    {
     "question_id": "Q-144a4feed8a3",
     "dimension_id": "2",
     "text": "Can you share a recent example (not just the standard doc) showing Continuous Delivery (CD) in practice this quarter?",
     "target_audience": "team",
     "status": "OPEN"
    }
   ],
   "history": [
    {
     "from_level": null,
     "to_level": 3,
     "is_na": false,
     "rationale": "Self-rating and evidence both point to \"Defined\" for Continuous Delivery (CD).",
     "evidence_ids": [
      "EV-ef07e15d5c36"
     ],
     "source_meeting": "teams/TEAM-001 (artifact review)",
     "changed_at": daysAgo(9),
     "changed_by": "orgiq-assessment-scorer"
    }
   ],
   "updated_at": daysAgo(2)
  },
  "3": {
   "dimension_id": "3",
   "current_level": 3,
   "is_na": false,
   "confidence": "moderate",
   "self_claimed_level": 3,
   "evidence_class": "documented",
   "cap_applied": false,
   "evidence": [
    {
     "evidence_id": "EV-623ce8d74c98",
     "dimension_id": "3",
     "source_type": "document",
     "excerpt": "Automation: our practice matches \"Defined\" — we pointed the assessor at a written runbook/standard covering this.",
     "supports_level": 3,
     "captured_at": daysAgo(8),
     "source_ref": "PROV-63a330928ddb",
     "scored": true,
     "status": "SCORED"
    }
   ],
   "follow_up_questions": [],
   "history": [
    {
     "from_level": null,
     "to_level": 3,
     "is_na": false,
     "rationale": "Self-rating and evidence both point to \"Defined\" for Automation.",
     "evidence_ids": [
      "EV-623ce8d74c98"
     ],
     "source_meeting": "teams/TEAM-001 (artifact review)",
     "changed_at": daysAgo(8),
     "changed_by": "orgiq-assessment-scorer"
    }
   ],
   "updated_at": daysAgo(3)
  },
  "4": {
   "dimension_id": "4",
   "current_level": 3,
   "is_na": false,
   "confidence": "moderate",
   "self_claimed_level": 3,
   "evidence_class": "documented",
   "cap_applied": false,
   "evidence": [
    {
     "evidence_id": "EV-0dc780353b6a",
     "dimension_id": "4",
     "source_type": "document",
     "excerpt": "Source Control & Traceability: our practice matches \"Defined\" — we pointed the assessor at a written runbook/standard covering this.",
     "supports_level": 3,
     "captured_at": daysAgo(7),
     "source_ref": "PROV-9c6711a58acf",
     "scored": true,
     "status": "SCORED"
    }
   ],
   "follow_up_questions": [
    {
     "question_id": "Q-8139f5d864b2",
     "dimension_id": "4",
     "text": "Can you share a recent example (not just the standard doc) showing Source Control & Traceability in practice this quarter?",
     "target_audience": "team",
     "status": "OPEN"
    }
   ],
   "history": [
    {
     "from_level": null,
     "to_level": 3,
     "is_na": false,
     "rationale": "Self-rating and evidence both point to \"Defined\" for Source Control & Traceability.",
     "evidence_ids": [
      "EV-0dc780353b6a"
     ],
     "source_meeting": "teams/TEAM-001 (artifact review)",
     "changed_at": daysAgo(7),
     "changed_by": "orgiq-assessment-scorer"
    }
   ],
   "updated_at": daysAgo(4)
  },
  "5": {
   "dimension_id": "5",
   "current_level": 3,
   "is_na": false,
   "confidence": "moderate",
   "self_claimed_level": 4,
   "evidence_class": "documented",
   "cap_applied": false,
   "evidence": [
    {
     "evidence_id": "EV-fe427da6c93c",
     "dimension_id": "5",
     "source_type": "document",
     "excerpt": "Testing & QE – Automated Testing: our practice matches \"Defined\" — we pointed the assessor at a written runbook/standard covering this.",
     "supports_level": 3,
     "captured_at": daysAgo(6),
     "source_ref": "PROV-5528573df5a1",
     "scored": true,
     "status": "SCORED"
    }
   ],
   "follow_up_questions": [],
   "history": [
    {
     "from_level": null,
     "to_level": 3,
     "is_na": false,
     "rationale": "Self-rating and evidence both point to \"Defined\" for Testing & QE – Automated Testing.",
     "evidence_ids": [
      "EV-fe427da6c93c"
     ],
     "source_meeting": "teams/TEAM-001 (artifact review)",
     "changed_at": daysAgo(6),
     "changed_by": "orgiq-assessment-scorer"
    }
   ],
   "updated_at": daysAgo(5)
  },
  "6": {
   "dimension_id": "6",
   "current_level": null,
   "is_na": true,
   "confidence": "low",
   "self_claimed_level": null,
   "evidence_class": null,
   "cap_applied": false,
   "evidence": [],
   "follow_up_questions": [],
   "history": [
    {
     "from_level": null,
     "to_level": null,
     "is_na": true,
     "rationale": "Not applicable if the team does not develop, modify, deploy, or maintain code, scripts, applications, APIs, Infrastructure-as-Code, or configuration that requires security… Approved under the internal-tooling-no-deploy archetype.",
     "evidence_ids": [],
     "source_meeting": "teams/TEAM-001 (exception review)",
     "changed_at": daysAgo(10),
     "changed_by": "lead-assessor:priya"
    }
   ],
   "updated_at": daysAgo(10)
  },
  "7": {
   "dimension_id": "7",
   "current_level": null,
   "is_na": true,
   "confidence": "low",
   "self_claimed_level": null,
   "evidence_class": null,
   "cap_applied": false,
   "evidence": [],
   "follow_up_questions": [],
   "history": [
    {
     "from_level": null,
     "to_level": null,
     "is_na": true,
     "rationale": "Team-requested N/A pending lead review: \"we own no internet-facing service, this is an internal batch reconciliation job.\"",
     "evidence_ids": [],
     "source_meeting": "teams/TEAM-001 (exception review)",
     "changed_at": daysAgo(4),
     "changed_by": "assessor:priya"
    }
   ],
   "updated_at": daysAgo(4)
  },
  "8": {
   "dimension_id": "8",
   "current_level": 3,
   "is_na": false,
   "confidence": "moderate",
   "self_claimed_level": 3,
   "evidence_class": "documented",
   "cap_applied": false,
   "evidence": [
    {
     "evidence_id": "EV-e2a8f5960450",
     "dimension_id": "8",
     "source_type": "document",
     "excerpt": "Security Control SDLC & Code Review Practices: our practice matches \"Defined\" — we pointed the assessor at a written runbook/standard covering this.",
     "supports_level": 3,
     "captured_at": daysAgo(5),
     "source_ref": "PROV-51872e462cb6",
     "scored": true,
     "status": "SCORED"
    }
   ],
   "follow_up_questions": [
    {
     "question_id": "Q-ea117076d178",
     "dimension_id": "8",
     "text": "Can you share a recent example (not just the standard doc) showing Security Control SDLC & Code Review Practices in practice this quarter?",
     "target_audience": "team",
     "status": "OPEN"
    }
   ],
   "history": [
    {
     "from_level": null,
     "to_level": 3,
     "is_na": false,
     "rationale": "Self-rating and evidence both point to \"Defined\" for Security Control SDLC & Code Review Practices.",
     "evidence_ids": [
      "EV-e2a8f5960450"
     ],
     "source_meeting": "teams/TEAM-001 (artifact review)",
     "changed_at": daysAgo(5),
     "changed_by": "orgiq-assessment-scorer"
    }
   ],
   "updated_at": daysAgo(2)
  },
  "9": {
   "dimension_id": "9",
   "current_level": 4,
   "is_na": false,
   "confidence": "high",
   "self_claimed_level": 4,
   "evidence_class": "observed",
   "cap_applied": false,
   "evidence": [
    {
     "evidence_id": "EV-c907e104f9af",
     "dimension_id": "9",
     "source_type": "document",
     "excerpt": "Engineering Governance: our practice matches \"Measured\" — the assessor opened the artifact directly (dashboard, pipeline run, or repo) and confirmed it.",
     "supports_level": 4,
     "captured_at": daysAgo(3),
     "source_ref": "PROV-c77c585fbdbc",
     "scored": true,
     "status": "SCORED"
    }
   ],
   "follow_up_questions": [],
   "history": [
    {
     "from_level": null,
     "to_level": 4,
     "is_na": false,
     "rationale": "The assessor opened the governance review minutes directly: decision rights are documented, a monthly architecture review board tracks decision quality, and two governance escapes were remediated with a documented process change. This is Observed evidence sustained over two review cycles, which is what Level 4 requires — verification reaches Level 4.",
     "evidence_ids": [
      "EV-c907e104f9af"
     ],
     "source_meeting": "teams/TEAM-001 (artifact review)",
     "changed_at": daysAgo(3),
     "changed_by": "orgiq-assessment-scorer"
    }
   ],
   "updated_at": daysAgo(2)
  },
  "10": {
   "dimension_id": "10",
   "current_level": 3,
   "is_na": false,
   "confidence": "moderate",
   "self_claimed_level": 3,
   "evidence_class": "documented",
   "cap_applied": false,
   "evidence": [
    {
     "evidence_id": "EV-9060cca68661",
     "dimension_id": "10",
     "source_type": "document",
     "excerpt": "Monitoring, Observability & Runtime Security: our practice matches \"Defined\" — we pointed the assessor at a written runbook/standard covering this.",
     "supports_level": 3,
     "captured_at": daysAgo(9),
     "source_ref": "PROV-147afd0bc006",
     "scored": true,
     "status": "SCORED"
    }
   ],
   "follow_up_questions": [],
   "history": [
    {
     "from_level": null,
     "to_level": 3,
     "is_na": false,
     "rationale": "Self-rating and evidence both point to \"Defined\" for Monitoring, Observability & Runtime Security.",
     "evidence_ids": [
      "EV-9060cca68661"
     ],
     "source_meeting": "teams/TEAM-001 (artifact review)",
     "changed_at": daysAgo(9),
     "changed_by": "orgiq-assessment-scorer"
    }
   ],
   "updated_at": daysAgo(3)
  },
  "11": {
   "dimension_id": "11",
   "current_level": 3,
   "is_na": false,
   "confidence": "moderate",
   "self_claimed_level": 4,
   "evidence_class": "documented",
   "cap_applied": false,
   "evidence": [
    {
     "evidence_id": "EV-eca0a2daee5d",
     "dimension_id": "11",
     "source_type": "document",
     "excerpt": "Environment Management: our practice matches \"Defined\" — we pointed the assessor at a written runbook/standard covering this.",
     "supports_level": 3,
     "captured_at": daysAgo(8),
     "source_ref": "PROV-796525ee482c",
     "scored": true,
     "status": "SCORED"
    }
   ],
   "follow_up_questions": [
    {
     "question_id": "Q-6295d92a06bb",
     "dimension_id": "11",
     "text": "Can you share a recent example (not just the standard doc) showing Environment Management in practice this quarter?",
     "target_audience": "team",
     "status": "OPEN"
    }
   ],
   "history": [
    {
     "from_level": null,
     "to_level": 3,
     "is_na": false,
     "rationale": "Self-rating and evidence both point to \"Defined\" for Environment Management.",
     "evidence_ids": [
      "EV-eca0a2daee5d"
     ],
     "source_meeting": "teams/TEAM-001 (artifact review)",
     "changed_at": daysAgo(8),
     "changed_by": "orgiq-assessment-scorer"
    }
   ],
   "updated_at": daysAgo(4)
  },
  "12": {
   "dimension_id": "12",
   "current_level": 3,
   "is_na": false,
   "confidence": "moderate",
   "self_claimed_level": 3,
   "evidence_class": "documented",
   "cap_applied": false,
   "evidence": [
    {
     "evidence_id": "EV-30f431f39bd3",
     "dimension_id": "12",
     "source_type": "document",
     "excerpt": "Release Management & Operational Reliability: our practice matches \"Defined\" — we pointed the assessor at a written runbook/standard covering this.",
     "supports_level": 3,
     "captured_at": daysAgo(7),
     "source_ref": "PROV-2be2c199d838",
     "scored": true,
     "status": "SCORED"
    }
   ],
   "follow_up_questions": [],
   "history": [
    {
     "from_level": null,
     "to_level": 3,
     "is_na": false,
     "rationale": "Self-rating and evidence both point to \"Defined\" for Release Management & Operational Reliability.",
     "evidence_ids": [
      "EV-30f431f39bd3"
     ],
     "source_meeting": "teams/TEAM-001 (artifact review)",
     "changed_at": daysAgo(7),
     "changed_by": "orgiq-assessment-scorer"
    }
   ],
   "updated_at": daysAgo(5)
  },
  "13": {
   "dimension_id": "13",
   "current_level": 3,
   "is_na": false,
   "confidence": "moderate",
   "self_claimed_level": 3,
   "evidence_class": "documented",
   "cap_applied": false,
   "evidence": [
    {
     "evidence_id": "EV-f80c1f7d15e4",
     "dimension_id": "13",
     "source_type": "document",
     "excerpt": "Platform Reusability & Patterns: our practice matches \"Defined\" — we pointed the assessor at a written runbook/standard covering this.",
     "supports_level": 3,
     "captured_at": daysAgo(6),
     "source_ref": "PROV-ceef7b956a48",
     "scored": true,
     "status": "SCORED"
    }
   ],
   "follow_up_questions": [
    {
     "question_id": "Q-c0c857913550",
     "dimension_id": "13",
     "text": "Can you share a recent example (not just the standard doc) showing Platform Reusability & Patterns in practice this quarter?",
     "target_audience": "team",
     "status": "OPEN"
    }
   ],
   "history": [
    {
     "from_level": null,
     "to_level": 3,
     "is_na": false,
     "rationale": "Self-rating and evidence both point to \"Defined\" for Platform Reusability & Patterns.",
     "evidence_ids": [
      "EV-f80c1f7d15e4"
     ],
     "source_meeting": "teams/TEAM-001 (artifact review)",
     "changed_at": daysAgo(6),
     "changed_by": "orgiq-assessment-scorer"
    }
   ],
   "updated_at": daysAgo(2)
  },
  "14": {
   "dimension_id": "14",
   "current_level": 3,
   "is_na": false,
   "confidence": "moderate",
   "self_claimed_level": 4,
   "evidence_class": "documented",
   "cap_applied": false,
   "evidence": [
    {
     "evidence_id": "EV-54d814db941d",
     "dimension_id": "14",
     "source_type": "document",
     "excerpt": "Software Development Mindset & Automation Culture: our practice matches \"Defined\" — we pointed the assessor at a written runbook/standard covering this.",
     "supports_level": 3,
     "captured_at": daysAgo(5),
     "source_ref": "PROV-366f7362260c",
     "scored": true,
     "status": "SCORED"
    }
   ],
   "follow_up_questions": [],
   "history": [
    {
     "from_level": null,
     "to_level": 3,
     "is_na": false,
     "rationale": "Self-rating and evidence both point to \"Defined\" for Software Development Mindset & Automation Culture.",
     "evidence_ids": [
      "EV-54d814db941d"
     ],
     "source_meeting": "teams/TEAM-001 (artifact review)",
     "changed_at": daysAgo(5),
     "changed_by": "orgiq-assessment-scorer"
    }
   ],
   "updated_at": daysAgo(3)
  },
  "15": {
   "dimension_id": "15",
   "current_level": 3,
   "is_na": false,
   "confidence": "moderate",
   "self_claimed_level": 3,
   "evidence_class": "documented",
   "cap_applied": false,
   "evidence": [
    {
     "evidence_id": "EV-44b04e59f26f",
     "dimension_id": "15",
     "source_type": "document",
     "excerpt": "Agile Planning & Backlog Management: our practice matches \"Defined\" — we pointed the assessor at a written runbook/standard covering this.",
     "supports_level": 3,
     "captured_at": daysAgo(9),
     "source_ref": "PROV-f908b9c2e59c",
     "scored": true,
     "status": "SCORED"
    }
   ],
   "follow_up_questions": [
    {
     "question_id": "Q-f987c11827dd",
     "dimension_id": "15",
     "text": "Can you share a recent example (not just the standard doc) showing Agile Planning & Backlog Management in practice this quarter?",
     "target_audience": "team",
     "status": "OPEN"
    }
   ],
   "history": [
    {
     "from_level": null,
     "to_level": 3,
     "is_na": false,
     "rationale": "Self-rating and evidence both point to \"Defined\" for Agile Planning & Backlog Management.",
     "evidence_ids": [
      "EV-44b04e59f26f"
     ],
     "source_meeting": "teams/TEAM-001 (artifact review)",
     "changed_at": daysAgo(9),
     "changed_by": "orgiq-assessment-scorer"
    }
   ],
   "updated_at": daysAgo(4)
  },
  "16": {
   "dimension_id": "16",
   "current_level": 3,
   "is_na": false,
   "confidence": "moderate",
   "self_claimed_level": 3,
   "evidence_class": "documented",
   "cap_applied": false,
   "evidence": [
    {
     "evidence_id": "EV-5e486171185a",
     "dimension_id": "16",
     "source_type": "document",
     "excerpt": "Design Standards & Technical Decision Process: our practice matches \"Defined\" — we pointed the assessor at a written runbook/standard covering this.",
     "supports_level": 3,
     "captured_at": daysAgo(8),
     "source_ref": "PROV-74def4982241",
     "scored": true,
     "status": "SCORED"
    }
   ],
   "follow_up_questions": [],
   "history": [
    {
     "from_level": null,
     "to_level": 3,
     "is_na": false,
     "rationale": "Self-rating and evidence both point to \"Defined\" for Design Standards & Technical Decision Process.",
     "evidence_ids": [
      "EV-5e486171185a"
     ],
     "source_meeting": "teams/TEAM-001 (artifact review)",
     "changed_at": daysAgo(8),
     "changed_by": "orgiq-assessment-scorer"
    }
   ],
   "updated_at": daysAgo(5)
  },
  "17": {
   "dimension_id": "17",
   "current_level": 3,
   "is_na": false,
   "confidence": "moderate",
   "self_claimed_level": 4,
   "evidence_class": "documented",
   "cap_applied": false,
   "evidence": [
    {
     "evidence_id": "EV-c9341bb57a61",
     "dimension_id": "17",
     "source_type": "document",
     "excerpt": "Engineering Metrics & Continuous Improvement: our practice matches \"Defined\" — we pointed the assessor at a written runbook/standard covering this.",
     "supports_level": 3,
     "captured_at": daysAgo(7),
     "source_ref": "PROV-2d4a9fd2bb88",
     "scored": true,
     "status": "SCORED"
    }
   ],
   "follow_up_questions": [
    {
     "question_id": "Q-e199bfbf9312",
     "dimension_id": "17",
     "text": "Can you share a recent example (not just the standard doc) showing Engineering Metrics & Continuous Improvement in practice this quarter?",
     "target_audience": "team",
     "status": "OPEN"
    }
   ],
   "history": [
    {
     "from_level": null,
     "to_level": 3,
     "is_na": false,
     "rationale": "Self-rating and evidence both point to \"Defined\" for Engineering Metrics & Continuous Improvement.",
     "evidence_ids": [
      "EV-c9341bb57a61"
     ],
     "source_meeting": "teams/TEAM-001 (artifact review)",
     "changed_at": daysAgo(7),
     "changed_by": "orgiq-assessment-scorer"
    }
   ],
   "updated_at": daysAgo(2)
  }
 },
 "TEAM-002": {
  "1": {
   "dimension_id": "1",
   "current_level": 3,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": 5,
   "evidence_class": "attested",
   "cap_applied": true,
   "evidence": [
    {
     "evidence_id": "EV-d34b959c7bca",
     "dimension_id": "1",
     "source_type": "survey",
     "excerpt": "Continuous Integration (CI): our practice matches \"Defined\" — this is what the team told us in the self-assessment survey, nothing more.",
     "supports_level": 3,
     "captured_at": daysAgo(14),
     "source_ref": "PROV-89a9a069e976",
     "scored": true,
     "status": "SCORED"
    },
    {
     "evidence_id": "EV-c18efde7cfc5",
     "dimension_id": "1",
     "source_type": "survey",
     "excerpt": "Same answer, reconfirmed on the follow-up revision of the Forms submission.",
     "supports_level": 3,
     "captured_at": daysAgo(5),
     "source_ref": "PROV-89a9a069e976",
     "scored": true,
     "status": "SCORED"
    }
   ],
   "follow_up_questions": [
    {
     "question_id": "Q-a893a635eb7b",
     "dimension_id": "1",
     "text": "Could you share the dashboard, pipeline run, or export backing your \"Continuous Integration (CI)\" answer so we can verify beyond the survey response?",
     "target_audience": "team",
     "status": "OPEN"
    }
   ],
   "history": [
    {
     "from_level": null,
     "to_level": 3,
     "is_na": false,
     "rationale": "Self-report alone claims higher than \"Defined\" for Continuous Integration (CI); a self-rating with no independent corroboration caps at Level 3 per the scoring stance, so verification stops at Level 3.",
     "evidence_ids": [
      "EV-d34b959c7bca"
     ],
     "source_meeting": "teams/TEAM-002 (artifact review)",
     "changed_at": daysAgo(14),
     "changed_by": "orgiq-assessment-scorer"
    }
   ],
   "updated_at": hoursAgo(5)
  },
  "2": {
   "dimension_id": "2",
   "current_level": 3,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": 5,
   "evidence_class": "attested",
   "cap_applied": true,
   "evidence": [
    {
     "evidence_id": "EV-9b86083a15f7",
     "dimension_id": "2",
     "source_type": "survey",
     "excerpt": "Continuous Delivery (CD): our practice matches \"Defined\" — this is what the team told us in the self-assessment survey, nothing more.",
     "supports_level": 3,
     "captured_at": daysAgo(14),
     "source_ref": "PROV-c6546af4199a",
     "scored": true,
     "status": "SCORED"
    },
    {
     "evidence_id": "EV-e09c7e78e1ef",
     "dimension_id": "2",
     "source_type": "survey",
     "excerpt": "Same answer, reconfirmed on the follow-up revision of the Forms submission.",
     "supports_level": 3,
     "captured_at": daysAgo(5),
     "source_ref": "PROV-c6546af4199a",
     "scored": true,
     "status": "SCORED"
    }
   ],
   "follow_up_questions": [
    {
     "question_id": "Q-12dc937d74b0",
     "dimension_id": "2",
     "text": "Could you share the dashboard, pipeline run, or export backing your \"Continuous Delivery (CD)\" answer so we can verify beyond the survey response?",
     "target_audience": "team",
     "status": "ANSWERED"
    }
   ],
   "history": [
    {
     "from_level": null,
     "to_level": 3,
     "is_na": false,
     "rationale": "Self-report alone claims higher than \"Defined\" for Continuous Delivery (CD); a self-rating with no independent corroboration caps at Level 3 per the scoring stance, so verification stops at Level 3.",
     "evidence_ids": [
      "EV-9b86083a15f7"
     ],
     "source_meeting": "teams/TEAM-002 (artifact review)",
     "changed_at": daysAgo(14),
     "changed_by": "orgiq-assessment-scorer"
    }
   ],
   "updated_at": hoursAgo(5)
  },
  "3": {
   "dimension_id": "3",
   "current_level": 3,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": 5,
   "evidence_class": "attested",
   "cap_applied": true,
   "evidence": [
    {
     "evidence_id": "EV-a648a6aa74d9",
     "dimension_id": "3",
     "source_type": "survey",
     "excerpt": "Automation: our practice matches \"Defined\" — this is what the team told us in the self-assessment survey, nothing more.",
     "supports_level": 3,
     "captured_at": daysAgo(14),
     "source_ref": "PROV-78f4ef0bdff1",
     "scored": true,
     "status": "SCORED"
    }
   ],
   "follow_up_questions": [
    {
     "question_id": "Q-5fe49ac7c220",
     "dimension_id": "3",
     "text": "Could you share the dashboard, pipeline run, or export backing your \"Automation\" answer so we can verify beyond the survey response?",
     "target_audience": "team",
     "status": "DROPPED"
    }
   ],
   "history": [
    {
     "from_level": null,
     "to_level": 3,
     "is_na": false,
     "rationale": "Self-report alone claims higher than \"Defined\" for Automation; a self-rating with no independent corroboration caps at Level 3 per the scoring stance, so verification stops at Level 3.",
     "evidence_ids": [
      "EV-a648a6aa74d9"
     ],
     "source_meeting": "teams/TEAM-002 (artifact review)",
     "changed_at": daysAgo(14),
     "changed_by": "orgiq-assessment-scorer"
    }
   ],
   "updated_at": hoursAgo(5)
  },
  "4": {
   "dimension_id": "4",
   "current_level": 3,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": 5,
   "evidence_class": "attested",
   "cap_applied": true,
   "evidence": [
    {
     "evidence_id": "EV-932543159ca5",
     "dimension_id": "4",
     "source_type": "survey",
     "excerpt": "Source Control & Traceability: our practice matches \"Defined\" — this is what the team told us in the self-assessment survey, nothing more.",
     "supports_level": 3,
     "captured_at": daysAgo(14),
     "source_ref": "PROV-7b96c064d838",
     "scored": true,
     "status": "SCORED"
    }
   ],
   "follow_up_questions": [
    {
     "question_id": "Q-8e59424bdf37",
     "dimension_id": "4",
     "text": "Could you share the dashboard, pipeline run, or export backing your \"Source Control & Traceability\" answer so we can verify beyond the survey response?",
     "target_audience": "team",
     "status": "OPEN"
    }
   ],
   "history": [
    {
     "from_level": null,
     "to_level": 3,
     "is_na": false,
     "rationale": "Self-report alone claims higher than \"Defined\" for Source Control & Traceability; a self-rating with no independent corroboration caps at Level 3 per the scoring stance, so verification stops at Level 3.",
     "evidence_ids": [
      "EV-932543159ca5"
     ],
     "source_meeting": "teams/TEAM-002 (artifact review)",
     "changed_at": daysAgo(14),
     "changed_by": "orgiq-assessment-scorer"
    }
   ],
   "updated_at": hoursAgo(5)
  },
  "5": {
   "dimension_id": "5",
   "current_level": 3,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": 5,
   "evidence_class": "attested",
   "cap_applied": true,
   "evidence": [
    {
     "evidence_id": "EV-1a08a1154e41",
     "dimension_id": "5",
     "source_type": "survey",
     "excerpt": "Testing & QE – Automated Testing: our practice matches \"Defined\" — this is what the team told us in the self-assessment survey, nothing more.",
     "supports_level": 3,
     "captured_at": daysAgo(14),
     "source_ref": "PROV-4f378dc1111e",
     "scored": true,
     "status": "SCORED"
    }
   ],
   "follow_up_questions": [
    {
     "question_id": "Q-a08bf7824b32",
     "dimension_id": "5",
     "text": "Could you share the dashboard, pipeline run, or export backing your \"Testing & QE – Automated Testing\" answer so we can verify beyond the survey response?",
     "target_audience": "team",
     "status": "OPEN"
    }
   ],
   "history": [
    {
     "from_level": null,
     "to_level": 3,
     "is_na": false,
     "rationale": "Self-report alone claims higher than \"Defined\" for Testing & QE – Automated Testing; a self-rating with no independent corroboration caps at Level 3 per the scoring stance, so verification stops at Level 3.",
     "evidence_ids": [
      "EV-1a08a1154e41"
     ],
     "source_meeting": "teams/TEAM-002 (artifact review)",
     "changed_at": daysAgo(14),
     "changed_by": "orgiq-assessment-scorer"
    }
   ],
   "updated_at": hoursAgo(5)
  },
  "6": {
   "dimension_id": "6",
   "current_level": 3,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": 5,
   "evidence_class": "attested",
   "cap_applied": true,
   "evidence": [
    {
     "evidence_id": "EV-3930cf74a2d0",
     "dimension_id": "6",
     "source_type": "survey",
     "excerpt": "Testing & QE – Security Testing: our practice matches \"Defined\" — this is what the team told us in the self-assessment survey, nothing more.",
     "supports_level": 3,
     "captured_at": daysAgo(14),
     "source_ref": "PROV-c1ce342691e7",
     "scored": true,
     "status": "SCORED"
    }
   ],
   "follow_up_questions": [
    {
     "question_id": "Q-9369529f4896",
     "dimension_id": "6",
     "text": "Could you share the dashboard, pipeline run, or export backing your \"Testing & QE – Security Testing\" answer so we can verify beyond the survey response?",
     "target_audience": "team",
     "status": "OPEN"
    }
   ],
   "history": [
    {
     "from_level": null,
     "to_level": 3,
     "is_na": false,
     "rationale": "Self-report alone claims higher than \"Defined\" for Testing & QE – Security Testing; a self-rating with no independent corroboration caps at Level 3 per the scoring stance, so verification stops at Level 3.",
     "evidence_ids": [
      "EV-3930cf74a2d0"
     ],
     "source_meeting": "teams/TEAM-002 (artifact review)",
     "changed_at": daysAgo(14),
     "changed_by": "orgiq-assessment-scorer"
    }
   ],
   "updated_at": hoursAgo(5)
  },
  "7": {
   "dimension_id": "7",
   "current_level": 3,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": 5,
   "evidence_class": "attested",
   "cap_applied": true,
   "evidence": [
    {
     "evidence_id": "EV-c155d6df9372",
     "dimension_id": "7",
     "source_type": "survey",
     "excerpt": "Testing & QE – Performance & Reliability Testing: our practice matches \"Defined\" — this is what the team told us in the self-assessment survey, nothing more.",
     "supports_level": 3,
     "captured_at": daysAgo(14),
     "source_ref": "PROV-e20d5b134fe4",
     "scored": true,
     "status": "SCORED"
    }
   ],
   "follow_up_questions": [
    {
     "question_id": "Q-81e93df94dbe",
     "dimension_id": "7",
     "text": "Could you share the dashboard, pipeline run, or export backing your \"Testing & QE – Performance & Reliability Testing\" answer so we can verify beyond the survey response?",
     "target_audience": "team",
     "status": "OPEN"
    }
   ],
   "history": [
    {
     "from_level": null,
     "to_level": 3,
     "is_na": false,
     "rationale": "Self-report alone claims higher than \"Defined\" for Testing & QE – Performance & Reliability Testing; a self-rating with no independent corroboration caps at Level 3 per the scoring stance, so verification stops at Level 3.",
     "evidence_ids": [
      "EV-c155d6df9372"
     ],
     "source_meeting": "teams/TEAM-002 (artifact review)",
     "changed_at": daysAgo(14),
     "changed_by": "orgiq-assessment-scorer"
    }
   ],
   "updated_at": hoursAgo(5)
  },
  "8": {
   "dimension_id": "8",
   "current_level": 3,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": 5,
   "evidence_class": "attested",
   "cap_applied": true,
   "evidence": [
    {
     "evidence_id": "EV-b300901fc0b2",
     "dimension_id": "8",
     "source_type": "survey",
     "excerpt": "Security Control SDLC & Code Review Practices: our practice matches \"Defined\" — this is what the team told us in the self-assessment survey, nothing more.",
     "supports_level": 3,
     "captured_at": daysAgo(14),
     "source_ref": "PROV-0fa41af38bbb",
     "scored": true,
     "status": "SCORED"
    }
   ],
   "follow_up_questions": [
    {
     "question_id": "Q-11c28f0570e2",
     "dimension_id": "8",
     "text": "Could you share the dashboard, pipeline run, or export backing your \"Security Control SDLC & Code Review Practices\" answer so we can verify beyond the survey response?",
     "target_audience": "team",
     "status": "OPEN"
    }
   ],
   "history": [
    {
     "from_level": null,
     "to_level": 3,
     "is_na": false,
     "rationale": "Self-report alone claims higher than \"Defined\" for Security Control SDLC & Code Review Practices; a self-rating with no independent corroboration caps at Level 3 per the scoring stance, so verification stops at Level 3.",
     "evidence_ids": [
      "EV-b300901fc0b2"
     ],
     "source_meeting": "teams/TEAM-002 (artifact review)",
     "changed_at": daysAgo(14),
     "changed_by": "orgiq-assessment-scorer"
    }
   ],
   "updated_at": hoursAgo(5)
  },
  "9": {
   "dimension_id": "9",
   "current_level": 3,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": 5,
   "evidence_class": "attested",
   "cap_applied": true,
   "evidence": [
    {
     "evidence_id": "EV-3a209e83c1ff",
     "dimension_id": "9",
     "source_type": "survey",
     "excerpt": "Engineering Governance: our practice matches \"Defined\" — this is what the team told us in the self-assessment survey, nothing more.",
     "supports_level": 3,
     "captured_at": daysAgo(14),
     "source_ref": "PROV-6146078f6173",
     "scored": true,
     "status": "SCORED"
    }
   ],
   "follow_up_questions": [
    {
     "question_id": "Q-28e86054561e",
     "dimension_id": "9",
     "text": "Could you share the dashboard, pipeline run, or export backing your \"Engineering Governance\" answer so we can verify beyond the survey response?",
     "target_audience": "team",
     "status": "OPEN"
    }
   ],
   "history": [
    {
     "from_level": null,
     "to_level": 3,
     "is_na": false,
     "rationale": "Self-report alone claims higher than \"Defined\" for Engineering Governance; a self-rating with no independent corroboration caps at Level 3 per the scoring stance, so verification stops at Level 3.",
     "evidence_ids": [
      "EV-3a209e83c1ff"
     ],
     "source_meeting": "teams/TEAM-002 (artifact review)",
     "changed_at": daysAgo(14),
     "changed_by": "orgiq-assessment-scorer"
    }
   ],
   "updated_at": hoursAgo(5)
  },
  "10": {
   "dimension_id": "10",
   "current_level": 3,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": 5,
   "evidence_class": "attested",
   "cap_applied": true,
   "evidence": [
    {
     "evidence_id": "EV-86093df82bc4",
     "dimension_id": "10",
     "source_type": "survey",
     "excerpt": "Monitoring, Observability & Runtime Security: our practice matches \"Defined\" — this is what the team told us in the self-assessment survey, nothing more.",
     "supports_level": 3,
     "captured_at": daysAgo(14),
     "source_ref": "PROV-c7475c9dd614",
     "scored": true,
     "status": "SCORED"
    }
   ],
   "follow_up_questions": [
    {
     "question_id": "Q-12c96a7f6eeb",
     "dimension_id": "10",
     "text": "Could you share the dashboard, pipeline run, or export backing your \"Monitoring, Observability & Runtime Security\" answer so we can verify beyond the survey response?",
     "target_audience": "team",
     "status": "OPEN"
    }
   ],
   "history": [
    {
     "from_level": null,
     "to_level": 3,
     "is_na": false,
     "rationale": "Self-report alone claims higher than \"Defined\" for Monitoring, Observability & Runtime Security; a self-rating with no independent corroboration caps at Level 3 per the scoring stance, so verification stops at Level 3.",
     "evidence_ids": [
      "EV-86093df82bc4"
     ],
     "source_meeting": "teams/TEAM-002 (artifact review)",
     "changed_at": daysAgo(14),
     "changed_by": "orgiq-assessment-scorer"
    }
   ],
   "updated_at": hoursAgo(5)
  },
  "11": {
   "dimension_id": "11",
   "current_level": 3,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": 5,
   "evidence_class": "attested",
   "cap_applied": true,
   "evidence": [
    {
     "evidence_id": "EV-f0130ee1cc27",
     "dimension_id": "11",
     "source_type": "survey",
     "excerpt": "Environment Management: our practice matches \"Defined\" — this is what the team told us in the self-assessment survey, nothing more.",
     "supports_level": 3,
     "captured_at": daysAgo(14),
     "source_ref": "PROV-fe07c7b53027",
     "scored": true,
     "status": "SCORED"
    }
   ],
   "follow_up_questions": [
    {
     "question_id": "Q-4b09cb25bd32",
     "dimension_id": "11",
     "text": "Could you share the dashboard, pipeline run, or export backing your \"Environment Management\" answer so we can verify beyond the survey response?",
     "target_audience": "team",
     "status": "OPEN"
    }
   ],
   "history": [
    {
     "from_level": null,
     "to_level": 3,
     "is_na": false,
     "rationale": "Self-report alone claims higher than \"Defined\" for Environment Management; a self-rating with no independent corroboration caps at Level 3 per the scoring stance, so verification stops at Level 3.",
     "evidence_ids": [
      "EV-f0130ee1cc27"
     ],
     "source_meeting": "teams/TEAM-002 (artifact review)",
     "changed_at": daysAgo(14),
     "changed_by": "orgiq-assessment-scorer"
    }
   ],
   "updated_at": hoursAgo(5)
  },
  "12": {
   "dimension_id": "12",
   "current_level": 3,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": 5,
   "evidence_class": "attested",
   "cap_applied": true,
   "evidence": [
    {
     "evidence_id": "EV-4cc582c6ad0f",
     "dimension_id": "12",
     "source_type": "survey",
     "excerpt": "Release Management & Operational Reliability: our practice matches \"Defined\" — this is what the team told us in the self-assessment survey, nothing more.",
     "supports_level": 3,
     "captured_at": daysAgo(14),
     "source_ref": "PROV-bbd3a6800c85",
     "scored": true,
     "status": "SCORED"
    }
   ],
   "follow_up_questions": [
    {
     "question_id": "Q-54004a9f8f03",
     "dimension_id": "12",
     "text": "Could you share the dashboard, pipeline run, or export backing your \"Release Management & Operational Reliability\" answer so we can verify beyond the survey response?",
     "target_audience": "team",
     "status": "OPEN"
    }
   ],
   "history": [
    {
     "from_level": null,
     "to_level": 3,
     "is_na": false,
     "rationale": "Self-report alone claims higher than \"Defined\" for Release Management & Operational Reliability; a self-rating with no independent corroboration caps at Level 3 per the scoring stance, so verification stops at Level 3.",
     "evidence_ids": [
      "EV-4cc582c6ad0f"
     ],
     "source_meeting": "teams/TEAM-002 (artifact review)",
     "changed_at": daysAgo(14),
     "changed_by": "orgiq-assessment-scorer"
    }
   ],
   "updated_at": hoursAgo(5)
  },
  "13": {
   "dimension_id": "13",
   "current_level": 3,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": 5,
   "evidence_class": "attested",
   "cap_applied": true,
   "evidence": [
    {
     "evidence_id": "EV-f01d2ed701a4",
     "dimension_id": "13",
     "source_type": "survey",
     "excerpt": "Platform Reusability & Patterns: our practice matches \"Defined\" — this is what the team told us in the self-assessment survey, nothing more.",
     "supports_level": 3,
     "captured_at": daysAgo(14),
     "source_ref": "PROV-b67d05d52d79",
     "scored": true,
     "status": "SCORED"
    }
   ],
   "follow_up_questions": [
    {
     "question_id": "Q-44e289024316",
     "dimension_id": "13",
     "text": "Could you share the dashboard, pipeline run, or export backing your \"Platform Reusability & Patterns\" answer so we can verify beyond the survey response?",
     "target_audience": "team",
     "status": "OPEN"
    }
   ],
   "history": [
    {
     "from_level": null,
     "to_level": 3,
     "is_na": false,
     "rationale": "Self-report alone claims higher than \"Defined\" for Platform Reusability & Patterns; a self-rating with no independent corroboration caps at Level 3 per the scoring stance, so verification stops at Level 3.",
     "evidence_ids": [
      "EV-f01d2ed701a4"
     ],
     "source_meeting": "teams/TEAM-002 (artifact review)",
     "changed_at": daysAgo(14),
     "changed_by": "orgiq-assessment-scorer"
    }
   ],
   "updated_at": hoursAgo(5)
  },
  "14": {
   "dimension_id": "14",
   "current_level": 3,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": 5,
   "evidence_class": "attested",
   "cap_applied": true,
   "evidence": [
    {
     "evidence_id": "EV-9a23725dd0e3",
     "dimension_id": "14",
     "source_type": "survey",
     "excerpt": "Software Development Mindset & Automation Culture: our practice matches \"Defined\" — this is what the team told us in the self-assessment survey, nothing more.",
     "supports_level": 3,
     "captured_at": daysAgo(14),
     "source_ref": "PROV-3abf92f26cfd",
     "scored": true,
     "status": "SCORED"
    }
   ],
   "follow_up_questions": [
    {
     "question_id": "Q-3e6eaca68c9c",
     "dimension_id": "14",
     "text": "Could you share the dashboard, pipeline run, or export backing your \"Software Development Mindset & Automation Culture\" answer so we can verify beyond the survey response?",
     "target_audience": "team",
     "status": "OPEN"
    }
   ],
   "history": [
    {
     "from_level": null,
     "to_level": 3,
     "is_na": false,
     "rationale": "Self-report alone claims higher than \"Defined\" for Software Development Mindset & Automation Culture; a self-rating with no independent corroboration caps at Level 3 per the scoring stance, so verification stops at Level 3.",
     "evidence_ids": [
      "EV-9a23725dd0e3"
     ],
     "source_meeting": "teams/TEAM-002 (artifact review)",
     "changed_at": daysAgo(14),
     "changed_by": "orgiq-assessment-scorer"
    }
   ],
   "updated_at": hoursAgo(5)
  },
  "15": {
   "dimension_id": "15",
   "current_level": 3,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": 5,
   "evidence_class": "attested",
   "cap_applied": true,
   "evidence": [
    {
     "evidence_id": "EV-8668e76fd10d",
     "dimension_id": "15",
     "source_type": "survey",
     "excerpt": "Agile Planning & Backlog Management: our practice matches \"Defined\" — this is what the team told us in the self-assessment survey, nothing more.",
     "supports_level": 3,
     "captured_at": daysAgo(14),
     "source_ref": "PROV-0c1aacab1895",
     "scored": true,
     "status": "SCORED"
    }
   ],
   "follow_up_questions": [
    {
     "question_id": "Q-e1639da834ed",
     "dimension_id": "15",
     "text": "Could you share the dashboard, pipeline run, or export backing your \"Agile Planning & Backlog Management\" answer so we can verify beyond the survey response?",
     "target_audience": "team",
     "status": "OPEN"
    }
   ],
   "history": [
    {
     "from_level": null,
     "to_level": 3,
     "is_na": false,
     "rationale": "Self-report alone claims higher than \"Defined\" for Agile Planning & Backlog Management; a self-rating with no independent corroboration caps at Level 3 per the scoring stance, so verification stops at Level 3.",
     "evidence_ids": [
      "EV-8668e76fd10d"
     ],
     "source_meeting": "teams/TEAM-002 (artifact review)",
     "changed_at": daysAgo(14),
     "changed_by": "orgiq-assessment-scorer"
    }
   ],
   "updated_at": hoursAgo(5)
  },
  "16": {
   "dimension_id": "16",
   "current_level": 3,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": 5,
   "evidence_class": "attested",
   "cap_applied": true,
   "evidence": [
    {
     "evidence_id": "EV-2b7a90c6823b",
     "dimension_id": "16",
     "source_type": "survey",
     "excerpt": "Design Standards & Technical Decision Process: our practice matches \"Defined\" — this is what the team told us in the self-assessment survey, nothing more.",
     "supports_level": 3,
     "captured_at": daysAgo(14),
     "source_ref": "PROV-1f4e3be695b9",
     "scored": true,
     "status": "SCORED"
    }
   ],
   "follow_up_questions": [
    {
     "question_id": "Q-a97b6c5b0bd5",
     "dimension_id": "16",
     "text": "Could you share the dashboard, pipeline run, or export backing your \"Design Standards & Technical Decision Process\" answer so we can verify beyond the survey response?",
     "target_audience": "team",
     "status": "OPEN"
    }
   ],
   "history": [
    {
     "from_level": null,
     "to_level": 3,
     "is_na": false,
     "rationale": "Self-report alone claims higher than \"Defined\" for Design Standards & Technical Decision Process; a self-rating with no independent corroboration caps at Level 3 per the scoring stance, so verification stops at Level 3.",
     "evidence_ids": [
      "EV-2b7a90c6823b"
     ],
     "source_meeting": "teams/TEAM-002 (artifact review)",
     "changed_at": daysAgo(14),
     "changed_by": "orgiq-assessment-scorer"
    }
   ],
   "updated_at": hoursAgo(5)
  },
  "17": {
   "dimension_id": "17",
   "current_level": 3,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": 5,
   "evidence_class": "attested",
   "cap_applied": true,
   "evidence": [
    {
     "evidence_id": "EV-3790c3fce6c1",
     "dimension_id": "17",
     "source_type": "survey",
     "excerpt": "Engineering Metrics & Continuous Improvement: our practice matches \"Defined\" — this is what the team told us in the self-assessment survey, nothing more.",
     "supports_level": 3,
     "captured_at": daysAgo(14),
     "source_ref": "PROV-bde1040c6c92",
     "scored": true,
     "status": "SCORED"
    }
   ],
   "follow_up_questions": [
    {
     "question_id": "Q-4a0df454a858",
     "dimension_id": "17",
     "text": "Could you share the dashboard, pipeline run, or export backing your \"Engineering Metrics & Continuous Improvement\" answer so we can verify beyond the survey response?",
     "target_audience": "team",
     "status": "OPEN"
    }
   ],
   "history": [
    {
     "from_level": null,
     "to_level": 3,
     "is_na": false,
     "rationale": "Self-report alone claims higher than \"Defined\" for Engineering Metrics & Continuous Improvement; a self-rating with no independent corroboration caps at Level 3 per the scoring stance, so verification stops at Level 3.",
     "evidence_ids": [
      "EV-3790c3fce6c1"
     ],
     "source_meeting": "teams/TEAM-002 (artifact review)",
     "changed_at": daysAgo(14),
     "changed_by": "orgiq-assessment-scorer"
    }
   ],
   "updated_at": hoursAgo(5)
  }
 },
 "TEAM-003": {
  "1": {
   "dimension_id": "1",
   "current_level": 2,
   "is_na": false,
   "confidence": "moderate",
   "self_claimed_level": 2,
   "evidence_class": "documented",
   "cap_applied": false,
   "evidence": [
    {
     "evidence_id": "EV-3cd07fb4f85b",
     "dimension_id": "1",
     "source_type": "transcript",
     "excerpt": "Continuous Integration (CI): our practice matches \"Developing\" — we pointed the assessor at a written runbook/standard covering this.",
     "supports_level": 2,
     "captured_at": daysAgo(4),
     "source_ref": "PROV-342578dcb7c7",
     "scored": true,
     "status": "SCORED"
    }
   ],
   "follow_up_questions": [],
   "history": [
    {
     "from_level": null,
     "to_level": 2,
     "is_na": false,
     "rationale": "Self-rating and evidence both point to \"Developing\" for Continuous Integration (CI).",
     "evidence_ids": [
      "EV-3cd07fb4f85b"
     ],
     "source_meeting": "teams/TEAM-003 (artifact review)",
     "changed_at": daysAgo(4),
     "changed_by": "orgiq-assessment-scorer"
    }
   ],
   "updated_at": daysAgo(3)
  },
  "2": {
   "dimension_id": "2",
   "current_level": 2,
   "is_na": false,
   "confidence": "moderate",
   "self_claimed_level": 2,
   "evidence_class": "documented",
   "cap_applied": false,
   "evidence": [
    {
     "evidence_id": "EV-b34c78e166a3",
     "dimension_id": "2",
     "source_type": "transcript",
     "excerpt": "Continuous Delivery (CD): our practice matches \"Developing\" — we pointed the assessor at a written runbook/standard covering this.",
     "supports_level": 2,
     "captured_at": daysAgo(4),
     "source_ref": "PROV-9b4465783c6c",
     "scored": true,
     "status": "SCORED"
    }
   ],
   "follow_up_questions": [],
   "history": [
    {
     "from_level": null,
     "to_level": 2,
     "is_na": false,
     "rationale": "Self-rating and evidence both point to \"Developing\" for Continuous Delivery (CD).",
     "evidence_ids": [
      "EV-b34c78e166a3"
     ],
     "source_meeting": "teams/TEAM-003 (artifact review)",
     "changed_at": daysAgo(4),
     "changed_by": "orgiq-assessment-scorer"
    }
   ],
   "updated_at": daysAgo(3)
  },
  "3": {
   "dimension_id": "3",
   "current_level": 2,
   "is_na": false,
   "confidence": "moderate",
   "self_claimed_level": 2,
   "evidence_class": "documented",
   "cap_applied": false,
   "evidence": [
    {
     "evidence_id": "EV-f40eaf0b1ca9",
     "dimension_id": "3",
     "source_type": "transcript",
     "excerpt": "Automation: our practice matches \"Developing\" — we pointed the assessor at a written runbook/standard covering this.",
     "supports_level": 2,
     "captured_at": daysAgo(4),
     "source_ref": "PROV-13115395c10b",
     "scored": true,
     "status": "SCORED"
    }
   ],
   "follow_up_questions": [],
   "history": [
    {
     "from_level": null,
     "to_level": 2,
     "is_na": false,
     "rationale": "Self-rating and evidence both point to \"Developing\" for Automation.",
     "evidence_ids": [
      "EV-f40eaf0b1ca9"
     ],
     "source_meeting": "teams/TEAM-003 (artifact review)",
     "changed_at": daysAgo(4),
     "changed_by": "orgiq-assessment-scorer"
    }
   ],
   "updated_at": daysAgo(3)
  },
  "4": {
   "dimension_id": "4",
   "current_level": 2,
   "is_na": false,
   "confidence": "moderate",
   "self_claimed_level": 2,
   "evidence_class": "documented",
   "cap_applied": false,
   "evidence": [
    {
     "evidence_id": "EV-88796e887ad2",
     "dimension_id": "4",
     "source_type": "transcript",
     "excerpt": "Source Control & Traceability: our practice matches \"Developing\" — we pointed the assessor at a written runbook/standard covering this.",
     "supports_level": 2,
     "captured_at": daysAgo(4),
     "source_ref": "PROV-1ede93ff19ee",
     "scored": true,
     "status": "SCORED"
    }
   ],
   "follow_up_questions": [],
   "history": [
    {
     "from_level": null,
     "to_level": 2,
     "is_na": false,
     "rationale": "Self-rating and evidence both point to \"Developing\" for Source Control & Traceability.",
     "evidence_ids": [
      "EV-88796e887ad2"
     ],
     "source_meeting": "teams/TEAM-003 (artifact review)",
     "changed_at": daysAgo(4),
     "changed_by": "orgiq-assessment-scorer"
    }
   ],
   "updated_at": daysAgo(3)
  },
  "5": {
   "dimension_id": "5",
   "current_level": 2,
   "is_na": false,
   "confidence": "moderate",
   "self_claimed_level": 2,
   "evidence_class": "documented",
   "cap_applied": false,
   "evidence": [
    {
     "evidence_id": "EV-60d1003874d1",
     "dimension_id": "5",
     "source_type": "transcript",
     "excerpt": "Testing & QE – Automated Testing: our practice matches \"Developing\" — we pointed the assessor at a written runbook/standard covering this.",
     "supports_level": 2,
     "captured_at": daysAgo(4),
     "source_ref": "PROV-598e2b7955c7",
     "scored": true,
     "status": "SCORED"
    }
   ],
   "follow_up_questions": [],
   "history": [
    {
     "from_level": null,
     "to_level": 2,
     "is_na": false,
     "rationale": "Self-rating and evidence both point to \"Developing\" for Testing & QE – Automated Testing.",
     "evidence_ids": [
      "EV-60d1003874d1"
     ],
     "source_meeting": "teams/TEAM-003 (artifact review)",
     "changed_at": daysAgo(4),
     "changed_by": "orgiq-assessment-scorer"
    }
   ],
   "updated_at": daysAgo(3)
  },
  "6": {
   "dimension_id": "6",
   "current_level": 2,
   "is_na": false,
   "confidence": "moderate",
   "self_claimed_level": 2,
   "evidence_class": "documented",
   "cap_applied": false,
   "evidence": [
    {
     "evidence_id": "EV-f69815af98bf",
     "dimension_id": "6",
     "source_type": "transcript",
     "excerpt": "Testing & QE – Security Testing: our practice matches \"Developing\" — we pointed the assessor at a written runbook/standard covering this.",
     "supports_level": 2,
     "captured_at": daysAgo(4),
     "source_ref": "PROV-ce5f8e791d4f",
     "scored": true,
     "status": "SCORED"
    }
   ],
   "follow_up_questions": [],
   "history": [
    {
     "from_level": null,
     "to_level": 2,
     "is_na": false,
     "rationale": "Self-rating and evidence both point to \"Developing\" for Testing & QE – Security Testing.",
     "evidence_ids": [
      "EV-f69815af98bf"
     ],
     "source_meeting": "teams/TEAM-003 (artifact review)",
     "changed_at": daysAgo(4),
     "changed_by": "orgiq-assessment-scorer"
    }
   ],
   "updated_at": daysAgo(3)
  },
  "7": {
   "dimension_id": "7",
   "current_level": 2,
   "is_na": false,
   "confidence": "moderate",
   "self_claimed_level": 2,
   "evidence_class": "documented",
   "cap_applied": false,
   "evidence": [
    {
     "evidence_id": "EV-c487efca7d18",
     "dimension_id": "7",
     "source_type": "transcript",
     "excerpt": "Testing & QE – Performance & Reliability Testing: our practice matches \"Developing\" — we pointed the assessor at a written runbook/standard covering this.",
     "supports_level": 2,
     "captured_at": daysAgo(4),
     "source_ref": "PROV-e13cf00642b6",
     "scored": true,
     "status": "SCORED"
    }
   ],
   "follow_up_questions": [],
   "history": [
    {
     "from_level": null,
     "to_level": 2,
     "is_na": false,
     "rationale": "Self-rating and evidence both point to \"Developing\" for Testing & QE – Performance & Reliability Testing.",
     "evidence_ids": [
      "EV-c487efca7d18"
     ],
     "source_meeting": "teams/TEAM-003 (artifact review)",
     "changed_at": daysAgo(4),
     "changed_by": "orgiq-assessment-scorer"
    }
   ],
   "updated_at": daysAgo(3)
  },
  "8": {
   "dimension_id": "8",
   "current_level": 2,
   "is_na": false,
   "confidence": "moderate",
   "self_claimed_level": 2,
   "evidence_class": "documented",
   "cap_applied": false,
   "evidence": [
    {
     "evidence_id": "EV-dae9725db8b0",
     "dimension_id": "8",
     "source_type": "transcript",
     "excerpt": "Security Control SDLC & Code Review Practices: our practice matches \"Developing\" — we pointed the assessor at a written runbook/standard covering this.",
     "supports_level": 2,
     "captured_at": daysAgo(4),
     "source_ref": "PROV-dfb7c7d39bdf",
     "scored": true,
     "status": "SCORED"
    }
   ],
   "follow_up_questions": [],
   "history": [
    {
     "from_level": null,
     "to_level": 2,
     "is_na": false,
     "rationale": "Self-rating and evidence both point to \"Developing\" for Security Control SDLC & Code Review Practices.",
     "evidence_ids": [
      "EV-dae9725db8b0"
     ],
     "source_meeting": "teams/TEAM-003 (artifact review)",
     "changed_at": daysAgo(4),
     "changed_by": "orgiq-assessment-scorer"
    }
   ],
   "updated_at": daysAgo(3)
  },
  "9": {
   "dimension_id": "9",
   "current_level": null,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": null,
   "evidence_class": null,
   "cap_applied": false,
   "evidence": [],
   "follow_up_questions": [],
   "history": [],
   "updated_at": daysAgo(30)
  },
  "10": {
   "dimension_id": "10",
   "current_level": null,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": null,
   "evidence_class": null,
   "cap_applied": false,
   "evidence": [],
   "follow_up_questions": [],
   "history": [],
   "updated_at": daysAgo(30)
  },
  "11": {
   "dimension_id": "11",
   "current_level": null,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": null,
   "evidence_class": null,
   "cap_applied": false,
   "evidence": [],
   "follow_up_questions": [],
   "history": [],
   "updated_at": daysAgo(30)
  },
  "12": {
   "dimension_id": "12",
   "current_level": null,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": null,
   "evidence_class": null,
   "cap_applied": false,
   "evidence": [],
   "follow_up_questions": [],
   "history": [],
   "updated_at": daysAgo(30)
  },
  "13": {
   "dimension_id": "13",
   "current_level": null,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": null,
   "evidence_class": null,
   "cap_applied": false,
   "evidence": [],
   "follow_up_questions": [],
   "history": [],
   "updated_at": daysAgo(30)
  },
  "14": {
   "dimension_id": "14",
   "current_level": null,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": null,
   "evidence_class": null,
   "cap_applied": false,
   "evidence": [],
   "follow_up_questions": [],
   "history": [],
   "updated_at": daysAgo(30)
  },
  "15": {
   "dimension_id": "15",
   "current_level": null,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": null,
   "evidence_class": null,
   "cap_applied": false,
   "evidence": [],
   "follow_up_questions": [],
   "history": [],
   "updated_at": daysAgo(30)
  },
  "16": {
   "dimension_id": "16",
   "current_level": null,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": null,
   "evidence_class": null,
   "cap_applied": false,
   "evidence": [],
   "follow_up_questions": [],
   "history": [],
   "updated_at": daysAgo(30)
  },
  "17": {
   "dimension_id": "17",
   "current_level": null,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": null,
   "evidence_class": null,
   "cap_applied": false,
   "evidence": [],
   "follow_up_questions": [],
   "history": [],
   "updated_at": daysAgo(30)
  }
 },
 "TEAM-004": {
  "1": {
   "dimension_id": "1",
   "current_level": 3,
   "is_na": false,
   "confidence": "moderate",
   "self_claimed_level": 3,
   "evidence_class": "documented",
   "cap_applied": false,
   "evidence": [
    {
     "evidence_id": "EV-da882d8f0a1a",
     "dimension_id": "1",
     "source_type": "artifact",
     "excerpt": "Continuous Integration (CI): our practice matches \"Defined\" — we pointed the assessor at a written runbook/standard covering this.",
     "supports_level": 3,
     "captured_at": daysAgo(7),
     "source_ref": "PROV-84f5691ed841",
     "scored": true,
     "status": "SCORED"
    }
   ],
   "follow_up_questions": [],
   "history": [
    {
     "from_level": null,
     "to_level": 3,
     "is_na": false,
     "rationale": "Self-rating and evidence both point to \"Defined\" for Continuous Integration (CI).",
     "evidence_ids": [
      "EV-da882d8f0a1a"
     ],
     "source_meeting": "teams/TEAM-004 (artifact review)",
     "changed_at": daysAgo(7),
     "changed_by": "orgiq-assessment-scorer"
    }
   ],
   "updated_at": daysAgo(6)
  },
  "2": {
   "dimension_id": "2",
   "current_level": 3,
   "is_na": false,
   "confidence": "moderate",
   "self_claimed_level": 3,
   "evidence_class": "documented",
   "cap_applied": false,
   "evidence": [
    {
     "evidence_id": "EV-2a9eda00d164",
     "dimension_id": "2",
     "source_type": "artifact",
     "excerpt": "Continuous Delivery (CD): our practice matches \"Defined\" — we pointed the assessor at a written runbook/standard covering this.",
     "supports_level": 3,
     "captured_at": daysAgo(7),
     "source_ref": "PROV-46f114888a81",
     "scored": true,
     "status": "SCORED"
    }
   ],
   "follow_up_questions": [],
   "history": [
    {
     "from_level": null,
     "to_level": 3,
     "is_na": false,
     "rationale": "Self-rating and evidence both point to \"Defined\" for Continuous Delivery (CD).",
     "evidence_ids": [
      "EV-2a9eda00d164"
     ],
     "source_meeting": "teams/TEAM-004 (artifact review)",
     "changed_at": daysAgo(7),
     "changed_by": "orgiq-assessment-scorer"
    }
   ],
   "updated_at": daysAgo(6)
  },
  "3": {
   "dimension_id": "3",
   "current_level": 3,
   "is_na": false,
   "confidence": "moderate",
   "self_claimed_level": 3,
   "evidence_class": "documented",
   "cap_applied": false,
   "evidence": [
    {
     "evidence_id": "EV-8944704f391b",
     "dimension_id": "3",
     "source_type": "artifact",
     "excerpt": "Automation: our practice matches \"Defined\" — we pointed the assessor at a written runbook/standard covering this.",
     "supports_level": 3,
     "captured_at": daysAgo(7),
     "source_ref": "PROV-295d9d8874e2",
     "scored": true,
     "status": "SCORED"
    }
   ],
   "follow_up_questions": [],
   "history": [
    {
     "from_level": null,
     "to_level": 3,
     "is_na": false,
     "rationale": "Self-rating and evidence both point to \"Defined\" for Automation.",
     "evidence_ids": [
      "EV-8944704f391b"
     ],
     "source_meeting": "teams/TEAM-004 (artifact review)",
     "changed_at": daysAgo(7),
     "changed_by": "orgiq-assessment-scorer"
    }
   ],
   "updated_at": daysAgo(6)
  },
  "4": {
   "dimension_id": "4",
   "current_level": 3,
   "is_na": false,
   "confidence": "moderate",
   "self_claimed_level": 3,
   "evidence_class": "documented",
   "cap_applied": false,
   "evidence": [
    {
     "evidence_id": "EV-35e660b8e799",
     "dimension_id": "4",
     "source_type": "artifact",
     "excerpt": "Source Control & Traceability: our practice matches \"Defined\" — we pointed the assessor at a written runbook/standard covering this.",
     "supports_level": 3,
     "captured_at": daysAgo(7),
     "source_ref": "PROV-0c5aa2fe9a6a",
     "scored": true,
     "status": "SCORED"
    }
   ],
   "follow_up_questions": [],
   "history": [
    {
     "from_level": null,
     "to_level": 3,
     "is_na": false,
     "rationale": "Self-rating and evidence both point to \"Defined\" for Source Control & Traceability.",
     "evidence_ids": [
      "EV-35e660b8e799"
     ],
     "source_meeting": "teams/TEAM-004 (artifact review)",
     "changed_at": daysAgo(7),
     "changed_by": "orgiq-assessment-scorer"
    }
   ],
   "updated_at": daysAgo(6)
  },
  "5": {
   "dimension_id": "5",
   "current_level": 3,
   "is_na": false,
   "confidence": "moderate",
   "self_claimed_level": 3,
   "evidence_class": "documented",
   "cap_applied": false,
   "evidence": [
    {
     "evidence_id": "EV-ab1a3f138c69",
     "dimension_id": "5",
     "source_type": "artifact",
     "excerpt": "Testing & QE – Automated Testing: our practice matches \"Defined\" — we pointed the assessor at a written runbook/standard covering this.",
     "supports_level": 3,
     "captured_at": daysAgo(7),
     "source_ref": "PROV-679855ce2de4",
     "scored": true,
     "status": "SCORED"
    }
   ],
   "follow_up_questions": [],
   "history": [
    {
     "from_level": null,
     "to_level": 3,
     "is_na": false,
     "rationale": "Self-rating and evidence both point to \"Defined\" for Testing & QE – Automated Testing.",
     "evidence_ids": [
      "EV-ab1a3f138c69"
     ],
     "source_meeting": "teams/TEAM-004 (artifact review)",
     "changed_at": daysAgo(7),
     "changed_by": "orgiq-assessment-scorer"
    }
   ],
   "updated_at": daysAgo(6)
  },
  "6": {
   "dimension_id": "6",
   "current_level": 3,
   "is_na": false,
   "confidence": "moderate",
   "self_claimed_level": 3,
   "evidence_class": "documented",
   "cap_applied": false,
   "evidence": [
    {
     "evidence_id": "EV-a5ce2e0f8f3e",
     "dimension_id": "6",
     "source_type": "artifact",
     "excerpt": "Testing & QE – Security Testing: our practice matches \"Defined\" — we pointed the assessor at a written runbook/standard covering this.",
     "supports_level": 3,
     "captured_at": daysAgo(7),
     "source_ref": "PROV-fda6dc68fcea",
     "scored": true,
     "status": "SCORED"
    }
   ],
   "follow_up_questions": [],
   "history": [
    {
     "from_level": null,
     "to_level": 3,
     "is_na": false,
     "rationale": "Self-rating and evidence both point to \"Defined\" for Testing & QE – Security Testing.",
     "evidence_ids": [
      "EV-a5ce2e0f8f3e"
     ],
     "source_meeting": "teams/TEAM-004 (artifact review)",
     "changed_at": daysAgo(7),
     "changed_by": "orgiq-assessment-scorer"
    }
   ],
   "updated_at": daysAgo(6)
  },
  "7": {
   "dimension_id": "7",
   "current_level": 3,
   "is_na": false,
   "confidence": "moderate",
   "self_claimed_level": 3,
   "evidence_class": "documented",
   "cap_applied": false,
   "evidence": [
    {
     "evidence_id": "EV-3faf1e80fec6",
     "dimension_id": "7",
     "source_type": "artifact",
     "excerpt": "Testing & QE – Performance & Reliability Testing: our practice matches \"Defined\" — we pointed the assessor at a written runbook/standard covering this.",
     "supports_level": 3,
     "captured_at": daysAgo(7),
     "source_ref": "PROV-1abb9825c1b0",
     "scored": true,
     "status": "SCORED"
    }
   ],
   "follow_up_questions": [],
   "history": [
    {
     "from_level": null,
     "to_level": 3,
     "is_na": false,
     "rationale": "Self-rating and evidence both point to \"Defined\" for Testing & QE – Performance & Reliability Testing.",
     "evidence_ids": [
      "EV-3faf1e80fec6"
     ],
     "source_meeting": "teams/TEAM-004 (artifact review)",
     "changed_at": daysAgo(7),
     "changed_by": "orgiq-assessment-scorer"
    }
   ],
   "updated_at": daysAgo(6)
  },
  "8": {
   "dimension_id": "8",
   "current_level": 3,
   "is_na": false,
   "confidence": "moderate",
   "self_claimed_level": 3,
   "evidence_class": "documented",
   "cap_applied": false,
   "evidence": [
    {
     "evidence_id": "EV-889430d7ed7b",
     "dimension_id": "8",
     "source_type": "artifact",
     "excerpt": "Security Control SDLC & Code Review Practices: our practice matches \"Defined\" — we pointed the assessor at a written runbook/standard covering this.",
     "supports_level": 3,
     "captured_at": daysAgo(7),
     "source_ref": "PROV-8a6df453e866",
     "scored": true,
     "status": "SCORED"
    }
   ],
   "follow_up_questions": [],
   "history": [
    {
     "from_level": null,
     "to_level": 3,
     "is_na": false,
     "rationale": "Self-rating and evidence both point to \"Defined\" for Security Control SDLC & Code Review Practices.",
     "evidence_ids": [
      "EV-889430d7ed7b"
     ],
     "source_meeting": "teams/TEAM-004 (artifact review)",
     "changed_at": daysAgo(7),
     "changed_by": "orgiq-assessment-scorer"
    }
   ],
   "updated_at": daysAgo(6)
  },
  "9": {
   "dimension_id": "9",
   "current_level": 3,
   "is_na": false,
   "confidence": "moderate",
   "self_claimed_level": 3,
   "evidence_class": "documented",
   "cap_applied": false,
   "evidence": [
    {
     "evidence_id": "EV-c1ad35f9cbd4",
     "dimension_id": "9",
     "source_type": "artifact",
     "excerpt": "Engineering Governance: our practice matches \"Defined\" — we pointed the assessor at a written runbook/standard covering this.",
     "supports_level": 3,
     "captured_at": daysAgo(7),
     "source_ref": "PROV-d61b65784cbd",
     "scored": true,
     "status": "SCORED"
    }
   ],
   "follow_up_questions": [],
   "history": [
    {
     "from_level": null,
     "to_level": 3,
     "is_na": false,
     "rationale": "Self-rating and evidence both point to \"Defined\" for Engineering Governance.",
     "evidence_ids": [
      "EV-c1ad35f9cbd4"
     ],
     "source_meeting": "teams/TEAM-004 (artifact review)",
     "changed_at": daysAgo(7),
     "changed_by": "orgiq-assessment-scorer"
    }
   ],
   "updated_at": daysAgo(6)
  },
  "10": {
   "dimension_id": "10",
   "current_level": 3,
   "is_na": false,
   "confidence": "moderate",
   "self_claimed_level": 3,
   "evidence_class": "documented",
   "cap_applied": false,
   "evidence": [
    {
     "evidence_id": "EV-3e897ba69d04",
     "dimension_id": "10",
     "source_type": "artifact",
     "excerpt": "Monitoring, Observability & Runtime Security: our practice matches \"Defined\" — we pointed the assessor at a written runbook/standard covering this.",
     "supports_level": 3,
     "captured_at": daysAgo(7),
     "source_ref": "PROV-2058862e7a58",
     "scored": true,
     "status": "SCORED"
    }
   ],
   "follow_up_questions": [],
   "history": [
    {
     "from_level": null,
     "to_level": 3,
     "is_na": false,
     "rationale": "Self-rating and evidence both point to \"Defined\" for Monitoring, Observability & Runtime Security.",
     "evidence_ids": [
      "EV-3e897ba69d04"
     ],
     "source_meeting": "teams/TEAM-004 (artifact review)",
     "changed_at": daysAgo(7),
     "changed_by": "orgiq-assessment-scorer"
    }
   ],
   "updated_at": daysAgo(6)
  },
  "11": {
   "dimension_id": "11",
   "current_level": null,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": null,
   "evidence_class": null,
   "cap_applied": false,
   "evidence": [],
   "follow_up_questions": [],
   "history": [],
   "updated_at": daysAgo(30)
  },
  "12": {
   "dimension_id": "12",
   "current_level": null,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": null,
   "evidence_class": null,
   "cap_applied": false,
   "evidence": [],
   "follow_up_questions": [],
   "history": [],
   "updated_at": daysAgo(30)
  },
  "13": {
   "dimension_id": "13",
   "current_level": null,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": null,
   "evidence_class": null,
   "cap_applied": false,
   "evidence": [],
   "follow_up_questions": [],
   "history": [],
   "updated_at": daysAgo(30)
  },
  "14": {
   "dimension_id": "14",
   "current_level": null,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": null,
   "evidence_class": null,
   "cap_applied": false,
   "evidence": [],
   "follow_up_questions": [],
   "history": [],
   "updated_at": daysAgo(30)
  },
  "15": {
   "dimension_id": "15",
   "current_level": null,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": null,
   "evidence_class": null,
   "cap_applied": false,
   "evidence": [],
   "follow_up_questions": [],
   "history": [],
   "updated_at": daysAgo(30)
  },
  "16": {
   "dimension_id": "16",
   "current_level": null,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": null,
   "evidence_class": null,
   "cap_applied": false,
   "evidence": [],
   "follow_up_questions": [],
   "history": [],
   "updated_at": daysAgo(30)
  },
  "17": {
   "dimension_id": "17",
   "current_level": null,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": null,
   "evidence_class": null,
   "cap_applied": false,
   "evidence": [],
   "follow_up_questions": [],
   "history": [],
   "updated_at": daysAgo(30)
  }
 },
 "TEAM-005": {
  "1": {
   "dimension_id": "1",
   "current_level": 1,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": 2,
   "evidence_class": "attested",
   "cap_applied": false,
   "evidence": [
    {
     "evidence_id": "EV-ce02ed1dae17",
     "dimension_id": "1",
     "source_type": "survey",
     "excerpt": "Continuous Integration (CI): our practice matches \"Initial\" — this is what the team told us in the self-assessment survey, nothing more.",
     "supports_level": 1,
     "captured_at": daysAgo(6),
     "source_ref": "PROV-ff1ac004cfac",
     "scored": true,
     "status": "SCORED"
    }
   ],
   "follow_up_questions": [],
   "history": [
    {
     "from_level": null,
     "to_level": 1,
     "is_na": false,
     "rationale": "Self-rating and evidence both point to \"Initial\" for Continuous Integration (CI).",
     "evidence_ids": [
      "EV-ce02ed1dae17"
     ],
     "source_meeting": "teams/TEAM-005 (artifact review)",
     "changed_at": daysAgo(6),
     "changed_by": "orgiq-assessment-scorer"
    }
   ],
   "updated_at": daysAgo(4)
  },
  "2": {
   "dimension_id": "2",
   "current_level": 1,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": 2,
   "evidence_class": "attested",
   "cap_applied": false,
   "evidence": [
    {
     "evidence_id": "EV-fdbb4554984b",
     "dimension_id": "2",
     "source_type": "survey",
     "excerpt": "Continuous Delivery (CD): our practice matches \"Initial\" — this is what the team told us in the self-assessment survey, nothing more.",
     "supports_level": 1,
     "captured_at": daysAgo(6),
     "source_ref": "PROV-60e7d542fa1b",
     "scored": true,
     "status": "SCORED"
    }
   ],
   "follow_up_questions": [],
   "history": [
    {
     "from_level": null,
     "to_level": 1,
     "is_na": false,
     "rationale": "Self-rating and evidence both point to \"Initial\" for Continuous Delivery (CD).",
     "evidence_ids": [
      "EV-fdbb4554984b"
     ],
     "source_meeting": "teams/TEAM-005 (artifact review)",
     "changed_at": daysAgo(6),
     "changed_by": "orgiq-assessment-scorer"
    }
   ],
   "updated_at": daysAgo(4)
  },
  "3": {
   "dimension_id": "3",
   "current_level": 1,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": 2,
   "evidence_class": "attested",
   "cap_applied": false,
   "evidence": [
    {
     "evidence_id": "EV-690056ec6d27",
     "dimension_id": "3",
     "source_type": "survey",
     "excerpt": "Automation: our practice matches \"Initial\" — this is what the team told us in the self-assessment survey, nothing more.",
     "supports_level": 1,
     "captured_at": daysAgo(6),
     "source_ref": "PROV-2ae3f783bbe9",
     "scored": true,
     "status": "SCORED"
    }
   ],
   "follow_up_questions": [],
   "history": [
    {
     "from_level": null,
     "to_level": 1,
     "is_na": false,
     "rationale": "Self-rating and evidence both point to \"Initial\" for Automation.",
     "evidence_ids": [
      "EV-690056ec6d27"
     ],
     "source_meeting": "teams/TEAM-005 (artifact review)",
     "changed_at": daysAgo(6),
     "changed_by": "orgiq-assessment-scorer"
    }
   ],
   "updated_at": daysAgo(4)
  },
  "4": {
   "dimension_id": "4",
   "current_level": 1,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": 2,
   "evidence_class": "attested",
   "cap_applied": false,
   "evidence": [
    {
     "evidence_id": "EV-a83d5537497e",
     "dimension_id": "4",
     "source_type": "survey",
     "excerpt": "Source Control & Traceability: our practice matches \"Initial\" — this is what the team told us in the self-assessment survey, nothing more.",
     "supports_level": 1,
     "captured_at": daysAgo(6),
     "source_ref": "PROV-1502af09c3e8",
     "scored": true,
     "status": "SCORED"
    }
   ],
   "follow_up_questions": [],
   "history": [
    {
     "from_level": null,
     "to_level": 1,
     "is_na": false,
     "rationale": "Self-rating and evidence both point to \"Initial\" for Source Control & Traceability.",
     "evidence_ids": [
      "EV-a83d5537497e"
     ],
     "source_meeting": "teams/TEAM-005 (artifact review)",
     "changed_at": daysAgo(6),
     "changed_by": "orgiq-assessment-scorer"
    }
   ],
   "updated_at": daysAgo(4)
  },
  "5": {
   "dimension_id": "5",
   "current_level": 1,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": 2,
   "evidence_class": "attested",
   "cap_applied": false,
   "evidence": [
    {
     "evidence_id": "EV-9d34501f965f",
     "dimension_id": "5",
     "source_type": "survey",
     "excerpt": "Testing & QE – Automated Testing: our practice matches \"Initial\" — this is what the team told us in the self-assessment survey, nothing more.",
     "supports_level": 1,
     "captured_at": daysAgo(6),
     "source_ref": "PROV-e003e15b6b5e",
     "scored": true,
     "status": "SCORED"
    }
   ],
   "follow_up_questions": [],
   "history": [
    {
     "from_level": null,
     "to_level": 1,
     "is_na": false,
     "rationale": "Self-rating and evidence both point to \"Initial\" for Testing & QE – Automated Testing.",
     "evidence_ids": [
      "EV-9d34501f965f"
     ],
     "source_meeting": "teams/TEAM-005 (artifact review)",
     "changed_at": daysAgo(6),
     "changed_by": "orgiq-assessment-scorer"
    }
   ],
   "updated_at": daysAgo(4)
  },
  "6": {
   "dimension_id": "6",
   "current_level": null,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": null,
   "evidence_class": null,
   "cap_applied": false,
   "evidence": [],
   "follow_up_questions": [],
   "history": [],
   "updated_at": daysAgo(30)
  },
  "7": {
   "dimension_id": "7",
   "current_level": null,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": null,
   "evidence_class": null,
   "cap_applied": false,
   "evidence": [],
   "follow_up_questions": [],
   "history": [],
   "updated_at": daysAgo(30)
  },
  "8": {
   "dimension_id": "8",
   "current_level": null,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": null,
   "evidence_class": null,
   "cap_applied": false,
   "evidence": [],
   "follow_up_questions": [],
   "history": [],
   "updated_at": daysAgo(30)
  },
  "9": {
   "dimension_id": "9",
   "current_level": null,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": null,
   "evidence_class": null,
   "cap_applied": false,
   "evidence": [],
   "follow_up_questions": [],
   "history": [],
   "updated_at": daysAgo(30)
  },
  "10": {
   "dimension_id": "10",
   "current_level": null,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": null,
   "evidence_class": null,
   "cap_applied": false,
   "evidence": [],
   "follow_up_questions": [],
   "history": [],
   "updated_at": daysAgo(30)
  },
  "11": {
   "dimension_id": "11",
   "current_level": null,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": null,
   "evidence_class": null,
   "cap_applied": false,
   "evidence": [],
   "follow_up_questions": [],
   "history": [],
   "updated_at": daysAgo(30)
  },
  "12": {
   "dimension_id": "12",
   "current_level": null,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": null,
   "evidence_class": null,
   "cap_applied": false,
   "evidence": [],
   "follow_up_questions": [],
   "history": [],
   "updated_at": daysAgo(30)
  },
  "13": {
   "dimension_id": "13",
   "current_level": null,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": null,
   "evidence_class": null,
   "cap_applied": false,
   "evidence": [],
   "follow_up_questions": [],
   "history": [],
   "updated_at": daysAgo(30)
  },
  "14": {
   "dimension_id": "14",
   "current_level": null,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": null,
   "evidence_class": null,
   "cap_applied": false,
   "evidence": [],
   "follow_up_questions": [],
   "history": [],
   "updated_at": daysAgo(30)
  },
  "15": {
   "dimension_id": "15",
   "current_level": null,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": null,
   "evidence_class": null,
   "cap_applied": false,
   "evidence": [],
   "follow_up_questions": [],
   "history": [],
   "updated_at": daysAgo(30)
  },
  "16": {
   "dimension_id": "16",
   "current_level": null,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": null,
   "evidence_class": null,
   "cap_applied": false,
   "evidence": [],
   "follow_up_questions": [],
   "history": [],
   "updated_at": daysAgo(30)
  },
  "17": {
   "dimension_id": "17",
   "current_level": null,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": null,
   "evidence_class": null,
   "cap_applied": false,
   "evidence": [],
   "follow_up_questions": [],
   "history": [],
   "updated_at": daysAgo(30)
  }
 },
 "TEAM-006": {
  "1": {
   "dimension_id": "1",
   "current_level": null,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": null,
   "evidence_class": null,
   "cap_applied": false,
   "evidence": [],
   "follow_up_questions": [],
   "history": [],
   "updated_at": daysAgo(30)
  },
  "2": {
   "dimension_id": "2",
   "current_level": null,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": null,
   "evidence_class": null,
   "cap_applied": false,
   "evidence": [],
   "follow_up_questions": [],
   "history": [],
   "updated_at": daysAgo(30)
  },
  "3": {
   "dimension_id": "3",
   "current_level": null,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": null,
   "evidence_class": null,
   "cap_applied": false,
   "evidence": [],
   "follow_up_questions": [],
   "history": [],
   "updated_at": daysAgo(30)
  },
  "4": {
   "dimension_id": "4",
   "current_level": null,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": null,
   "evidence_class": null,
   "cap_applied": false,
   "evidence": [],
   "follow_up_questions": [],
   "history": [],
   "updated_at": daysAgo(30)
  },
  "5": {
   "dimension_id": "5",
   "current_level": null,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": null,
   "evidence_class": null,
   "cap_applied": false,
   "evidence": [],
   "follow_up_questions": [],
   "history": [],
   "updated_at": daysAgo(30)
  },
  "6": {
   "dimension_id": "6",
   "current_level": null,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": null,
   "evidence_class": null,
   "cap_applied": false,
   "evidence": [],
   "follow_up_questions": [],
   "history": [],
   "updated_at": daysAgo(30)
  },
  "7": {
   "dimension_id": "7",
   "current_level": null,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": null,
   "evidence_class": null,
   "cap_applied": false,
   "evidence": [],
   "follow_up_questions": [],
   "history": [],
   "updated_at": daysAgo(30)
  },
  "8": {
   "dimension_id": "8",
   "current_level": null,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": null,
   "evidence_class": null,
   "cap_applied": false,
   "evidence": [],
   "follow_up_questions": [],
   "history": [],
   "updated_at": daysAgo(30)
  },
  "9": {
   "dimension_id": "9",
   "current_level": null,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": null,
   "evidence_class": null,
   "cap_applied": false,
   "evidence": [],
   "follow_up_questions": [],
   "history": [],
   "updated_at": daysAgo(30)
  },
  "10": {
   "dimension_id": "10",
   "current_level": null,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": null,
   "evidence_class": null,
   "cap_applied": false,
   "evidence": [],
   "follow_up_questions": [],
   "history": [],
   "updated_at": daysAgo(30)
  },
  "11": {
   "dimension_id": "11",
   "current_level": null,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": null,
   "evidence_class": null,
   "cap_applied": false,
   "evidence": [],
   "follow_up_questions": [],
   "history": [],
   "updated_at": daysAgo(30)
  },
  "12": {
   "dimension_id": "12",
   "current_level": null,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": null,
   "evidence_class": null,
   "cap_applied": false,
   "evidence": [],
   "follow_up_questions": [],
   "history": [],
   "updated_at": daysAgo(30)
  },
  "13": {
   "dimension_id": "13",
   "current_level": null,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": null,
   "evidence_class": null,
   "cap_applied": false,
   "evidence": [],
   "follow_up_questions": [],
   "history": [],
   "updated_at": daysAgo(30)
  },
  "14": {
   "dimension_id": "14",
   "current_level": null,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": null,
   "evidence_class": null,
   "cap_applied": false,
   "evidence": [],
   "follow_up_questions": [],
   "history": [],
   "updated_at": daysAgo(30)
  },
  "15": {
   "dimension_id": "15",
   "current_level": null,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": null,
   "evidence_class": null,
   "cap_applied": false,
   "evidence": [],
   "follow_up_questions": [],
   "history": [],
   "updated_at": daysAgo(30)
  },
  "16": {
   "dimension_id": "16",
   "current_level": null,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": null,
   "evidence_class": null,
   "cap_applied": false,
   "evidence": [],
   "follow_up_questions": [],
   "history": [],
   "updated_at": daysAgo(30)
  },
  "17": {
   "dimension_id": "17",
   "current_level": null,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": null,
   "evidence_class": null,
   "cap_applied": false,
   "evidence": [],
   "follow_up_questions": [],
   "history": [],
   "updated_at": daysAgo(30)
  }
 },
 "TEAM-007": {
  "1": {
   "dimension_id": "1",
   "current_level": null,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": null,
   "evidence_class": null,
   "cap_applied": false,
   "evidence": [],
   "follow_up_questions": [],
   "history": [],
   "updated_at": daysAgo(30)
  },
  "2": {
   "dimension_id": "2",
   "current_level": null,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": null,
   "evidence_class": null,
   "cap_applied": false,
   "evidence": [],
   "follow_up_questions": [],
   "history": [],
   "updated_at": daysAgo(30)
  },
  "3": {
   "dimension_id": "3",
   "current_level": null,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": null,
   "evidence_class": null,
   "cap_applied": false,
   "evidence": [],
   "follow_up_questions": [],
   "history": [],
   "updated_at": daysAgo(30)
  },
  "4": {
   "dimension_id": "4",
   "current_level": null,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": null,
   "evidence_class": null,
   "cap_applied": false,
   "evidence": [],
   "follow_up_questions": [],
   "history": [],
   "updated_at": daysAgo(30)
  },
  "5": {
   "dimension_id": "5",
   "current_level": null,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": null,
   "evidence_class": null,
   "cap_applied": false,
   "evidence": [],
   "follow_up_questions": [],
   "history": [],
   "updated_at": daysAgo(30)
  },
  "6": {
   "dimension_id": "6",
   "current_level": null,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": null,
   "evidence_class": null,
   "cap_applied": false,
   "evidence": [],
   "follow_up_questions": [],
   "history": [],
   "updated_at": daysAgo(30)
  },
  "7": {
   "dimension_id": "7",
   "current_level": null,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": null,
   "evidence_class": null,
   "cap_applied": false,
   "evidence": [],
   "follow_up_questions": [],
   "history": [],
   "updated_at": daysAgo(30)
  },
  "8": {
   "dimension_id": "8",
   "current_level": null,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": null,
   "evidence_class": null,
   "cap_applied": false,
   "evidence": [],
   "follow_up_questions": [],
   "history": [],
   "updated_at": daysAgo(30)
  },
  "9": {
   "dimension_id": "9",
   "current_level": null,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": null,
   "evidence_class": null,
   "cap_applied": false,
   "evidence": [],
   "follow_up_questions": [],
   "history": [],
   "updated_at": daysAgo(30)
  },
  "10": {
   "dimension_id": "10",
   "current_level": null,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": null,
   "evidence_class": null,
   "cap_applied": false,
   "evidence": [],
   "follow_up_questions": [],
   "history": [],
   "updated_at": daysAgo(30)
  },
  "11": {
   "dimension_id": "11",
   "current_level": null,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": null,
   "evidence_class": null,
   "cap_applied": false,
   "evidence": [],
   "follow_up_questions": [],
   "history": [],
   "updated_at": daysAgo(30)
  },
  "12": {
   "dimension_id": "12",
   "current_level": null,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": null,
   "evidence_class": null,
   "cap_applied": false,
   "evidence": [],
   "follow_up_questions": [],
   "history": [],
   "updated_at": daysAgo(30)
  },
  "13": {
   "dimension_id": "13",
   "current_level": null,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": null,
   "evidence_class": null,
   "cap_applied": false,
   "evidence": [],
   "follow_up_questions": [],
   "history": [],
   "updated_at": daysAgo(30)
  },
  "14": {
   "dimension_id": "14",
   "current_level": null,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": null,
   "evidence_class": null,
   "cap_applied": false,
   "evidence": [],
   "follow_up_questions": [],
   "history": [],
   "updated_at": daysAgo(30)
  },
  "15": {
   "dimension_id": "15",
   "current_level": null,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": null,
   "evidence_class": null,
   "cap_applied": false,
   "evidence": [],
   "follow_up_questions": [],
   "history": [],
   "updated_at": daysAgo(30)
  },
  "16": {
   "dimension_id": "16",
   "current_level": null,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": null,
   "evidence_class": null,
   "cap_applied": false,
   "evidence": [],
   "follow_up_questions": [],
   "history": [],
   "updated_at": daysAgo(30)
  },
  "17": {
   "dimension_id": "17",
   "current_level": null,
   "is_na": false,
   "confidence": "low",
   "self_claimed_level": null,
   "evidence_class": null,
   "cap_applied": false,
   "evidence": [],
   "follow_up_questions": [],
   "history": [],
   "updated_at": daysAgo(30)
  }
 }
});

// team_id -> provenance records referenced by evidence[].source_ref above.
const seedProvenance = (): Record<string, Provenance[]> => ({
 "TEAM-001": [
  {
   "provenance_id": "PROV-639265a04bca",
   "source_uri": "forms://submission/sub-team001-ci-survey",
   "captured_by": "Priya Natarajan",
   "captured_at": daysAgo(9)
  },
  {
   "provenance_id": "PROV-c77c585fbdbc",
   "source_uri": "upload://team-001/governance-review-minutes.pdf",
   "captured_by": "orgiq-assessment-scorer",
   "captured_at": daysAgo(3)
  },
  {
   "provenance_id": "PROV-2356de9da12e",
   "source_uri": "confluence://space/PAY/pages/200000",
   "captured_by": "Priya Natarajan",
   "captured_at": daysAgo(9)
  },
  {
   "provenance_id": "PROV-63a330928ddb",
   "source_uri": "confluence://space/PAY/pages/200001",
   "captured_by": "Priya Natarajan",
   "captured_at": daysAgo(8)
  },
  {
   "provenance_id": "PROV-9c6711a58acf",
   "source_uri": "confluence://space/PAY/pages/200002",
   "captured_by": "Priya Natarajan",
   "captured_at": daysAgo(7)
  },
  {
   "provenance_id": "PROV-5528573df5a1",
   "source_uri": "confluence://space/PAY/pages/200003",
   "captured_by": "Priya Natarajan",
   "captured_at": daysAgo(6)
  },
  {
   "provenance_id": "PROV-51872e462cb6",
   "source_uri": "confluence://space/PAY/pages/200004",
   "captured_by": "Priya Natarajan",
   "captured_at": daysAgo(5)
  },
  {
   "provenance_id": "PROV-147afd0bc006",
   "source_uri": "confluence://space/PAY/pages/200005",
   "captured_by": "Priya Natarajan",
   "captured_at": daysAgo(9)
  },
  {
   "provenance_id": "PROV-796525ee482c",
   "source_uri": "confluence://space/PAY/pages/200006",
   "captured_by": "Priya Natarajan",
   "captured_at": daysAgo(8)
  },
  {
   "provenance_id": "PROV-2be2c199d838",
   "source_uri": "confluence://space/PAY/pages/200007",
   "captured_by": "Priya Natarajan",
   "captured_at": daysAgo(7)
  },
  {
   "provenance_id": "PROV-ceef7b956a48",
   "source_uri": "confluence://space/PAY/pages/200008",
   "captured_by": "Priya Natarajan",
   "captured_at": daysAgo(6)
  },
  {
   "provenance_id": "PROV-366f7362260c",
   "source_uri": "confluence://space/PAY/pages/200009",
   "captured_by": "Priya Natarajan",
   "captured_at": daysAgo(5)
  },
  {
   "provenance_id": "PROV-f908b9c2e59c",
   "source_uri": "confluence://space/PAY/pages/200010",
   "captured_by": "Priya Natarajan",
   "captured_at": daysAgo(9)
  },
  {
   "provenance_id": "PROV-74def4982241",
   "source_uri": "confluence://space/PAY/pages/200011",
   "captured_by": "Priya Natarajan",
   "captured_at": daysAgo(8)
  },
  {
   "provenance_id": "PROV-2d4a9fd2bb88",
   "source_uri": "confluence://space/PAY/pages/200012",
   "captured_by": "Priya Natarajan",
   "captured_at": daysAgo(7)
  }
 ],
 "TEAM-002": [
  {
   "provenance_id": "PROV-89a9a069e976",
   "source_uri": "forms://submission/sub-20260810T091500Z-form5-jordan-lee-r3",
   "captured_by": "Jordan Lee",
   "captured_at": daysAgo(14)
  },
  {
   "provenance_id": "PROV-c6546af4199a",
   "source_uri": "forms://submission/sub-20260810T091500Z-form5-jordan-lee-r3",
   "captured_by": "Jordan Lee",
   "captured_at": daysAgo(14)
  },
  {
   "provenance_id": "PROV-78f4ef0bdff1",
   "source_uri": "forms://submission/sub-20260810T091500Z-form5-jordan-lee-r3",
   "captured_by": "Jordan Lee",
   "captured_at": daysAgo(14)
  },
  {
   "provenance_id": "PROV-7b96c064d838",
   "source_uri": "forms://submission/sub-20260810T091500Z-form5-jordan-lee-r3",
   "captured_by": "Jordan Lee",
   "captured_at": daysAgo(14)
  },
  {
   "provenance_id": "PROV-4f378dc1111e",
   "source_uri": "forms://submission/sub-20260810T091500Z-form5-jordan-lee-r3",
   "captured_by": "Jordan Lee",
   "captured_at": daysAgo(14)
  },
  {
   "provenance_id": "PROV-c1ce342691e7",
   "source_uri": "forms://submission/sub-20260810T091500Z-form5-jordan-lee-r3",
   "captured_by": "Jordan Lee",
   "captured_at": daysAgo(14)
  },
  {
   "provenance_id": "PROV-e20d5b134fe4",
   "source_uri": "forms://submission/sub-20260810T091500Z-form5-jordan-lee-r3",
   "captured_by": "Jordan Lee",
   "captured_at": daysAgo(14)
  },
  {
   "provenance_id": "PROV-0fa41af38bbb",
   "source_uri": "forms://submission/sub-20260810T091500Z-form5-jordan-lee-r3",
   "captured_by": "Jordan Lee",
   "captured_at": daysAgo(14)
  },
  {
   "provenance_id": "PROV-6146078f6173",
   "source_uri": "forms://submission/sub-20260810T091500Z-form5-jordan-lee-r3",
   "captured_by": "Jordan Lee",
   "captured_at": daysAgo(14)
  },
  {
   "provenance_id": "PROV-c7475c9dd614",
   "source_uri": "forms://submission/sub-20260810T091500Z-form5-jordan-lee-r3",
   "captured_by": "Jordan Lee",
   "captured_at": daysAgo(14)
  },
  {
   "provenance_id": "PROV-fe07c7b53027",
   "source_uri": "forms://submission/sub-20260810T091500Z-form5-jordan-lee-r3",
   "captured_by": "Jordan Lee",
   "captured_at": daysAgo(14)
  },
  {
   "provenance_id": "PROV-bbd3a6800c85",
   "source_uri": "forms://submission/sub-20260810T091500Z-form5-jordan-lee-r3",
   "captured_by": "Jordan Lee",
   "captured_at": daysAgo(14)
  },
  {
   "provenance_id": "PROV-b67d05d52d79",
   "source_uri": "forms://submission/sub-20260810T091500Z-form5-jordan-lee-r3",
   "captured_by": "Jordan Lee",
   "captured_at": daysAgo(14)
  },
  {
   "provenance_id": "PROV-3abf92f26cfd",
   "source_uri": "forms://submission/sub-20260810T091500Z-form5-jordan-lee-r3",
   "captured_by": "Jordan Lee",
   "captured_at": daysAgo(14)
  },
  {
   "provenance_id": "PROV-0c1aacab1895",
   "source_uri": "forms://submission/sub-20260810T091500Z-form5-jordan-lee-r3",
   "captured_by": "Jordan Lee",
   "captured_at": daysAgo(14)
  },
  {
   "provenance_id": "PROV-1f4e3be695b9",
   "source_uri": "forms://submission/sub-20260810T091500Z-form5-jordan-lee-r3",
   "captured_by": "Jordan Lee",
   "captured_at": daysAgo(14)
  },
  {
   "provenance_id": "PROV-bde1040c6c92",
   "source_uri": "forms://submission/sub-20260810T091500Z-form5-jordan-lee-r3",
   "captured_by": "Jordan Lee",
   "captured_at": daysAgo(14)
  }
 ],
 "TEAM-003": [
  {
   "provenance_id": "PROV-342578dcb7c7",
   "source_uri": "transcript://team-003/interview-2026-08-11.md",
   "captured_by": "Sam Okafor",
   "captured_at": daysAgo(4)
  },
  {
   "provenance_id": "PROV-9b4465783c6c",
   "source_uri": "transcript://team-003/interview-2026-08-12.md",
   "captured_by": "Sam Okafor",
   "captured_at": daysAgo(4)
  },
  {
   "provenance_id": "PROV-13115395c10b",
   "source_uri": "transcript://team-003/interview-2026-08-13.md",
   "captured_by": "Sam Okafor",
   "captured_at": daysAgo(4)
  },
  {
   "provenance_id": "PROV-1ede93ff19ee",
   "source_uri": "transcript://team-003/interview-2026-08-14.md",
   "captured_by": "Sam Okafor",
   "captured_at": daysAgo(4)
  },
  {
   "provenance_id": "PROV-598e2b7955c7",
   "source_uri": "transcript://team-003/interview-2026-08-15.md",
   "captured_by": "Sam Okafor",
   "captured_at": daysAgo(4)
  },
  {
   "provenance_id": "PROV-ce5f8e791d4f",
   "source_uri": "transcript://team-003/interview-2026-08-16.md",
   "captured_by": "Sam Okafor",
   "captured_at": daysAgo(4)
  },
  {
   "provenance_id": "PROV-e13cf00642b6",
   "source_uri": "transcript://team-003/interview-2026-08-17.md",
   "captured_by": "Sam Okafor",
   "captured_at": daysAgo(4)
  },
  {
   "provenance_id": "PROV-dfb7c7d39bdf",
   "source_uri": "transcript://team-003/interview-2026-08-18.md",
   "captured_by": "Sam Okafor",
   "captured_at": daysAgo(4)
  }
 ],
 "TEAM-004": [
  {
   "provenance_id": "PROV-84f5691ed841",
   "source_uri": "upload://team-004/evidence-dim1.png",
   "captured_by": "Elena Marsh",
   "captured_at": daysAgo(7)
  },
  {
   "provenance_id": "PROV-46f114888a81",
   "source_uri": "upload://team-004/evidence-dim2.png",
   "captured_by": "Elena Marsh",
   "captured_at": daysAgo(7)
  },
  {
   "provenance_id": "PROV-295d9d8874e2",
   "source_uri": "upload://team-004/evidence-dim3.png",
   "captured_by": "Elena Marsh",
   "captured_at": daysAgo(7)
  },
  {
   "provenance_id": "PROV-0c5aa2fe9a6a",
   "source_uri": "upload://team-004/evidence-dim4.png",
   "captured_by": "Elena Marsh",
   "captured_at": daysAgo(7)
  },
  {
   "provenance_id": "PROV-679855ce2de4",
   "source_uri": "upload://team-004/evidence-dim5.png",
   "captured_by": "Elena Marsh",
   "captured_at": daysAgo(7)
  },
  {
   "provenance_id": "PROV-fda6dc68fcea",
   "source_uri": "upload://team-004/evidence-dim6.png",
   "captured_by": "Elena Marsh",
   "captured_at": daysAgo(7)
  },
  {
   "provenance_id": "PROV-1abb9825c1b0",
   "source_uri": "upload://team-004/evidence-dim7.png",
   "captured_by": "Elena Marsh",
   "captured_at": daysAgo(7)
  },
  {
   "provenance_id": "PROV-8a6df453e866",
   "source_uri": "upload://team-004/evidence-dim8.png",
   "captured_by": "Elena Marsh",
   "captured_at": daysAgo(7)
  },
  {
   "provenance_id": "PROV-d61b65784cbd",
   "source_uri": "upload://team-004/evidence-dim9.png",
   "captured_by": "Elena Marsh",
   "captured_at": daysAgo(7)
  },
  {
   "provenance_id": "PROV-2058862e7a58",
   "source_uri": "upload://team-004/evidence-dim10.png",
   "captured_by": "Elena Marsh",
   "captured_at": daysAgo(7)
  }
 ],
 "TEAM-005": [
  {
   "provenance_id": "PROV-ff1ac004cfac",
   "source_uri": "forms://submission/sub-20260819T134500Z-form9-dana-whitfield",
   "captured_by": "Dana Whitfield",
   "captured_at": daysAgo(6)
  },
  {
   "provenance_id": "PROV-60e7d542fa1b",
   "source_uri": "forms://submission/sub-20260819T134500Z-form9-dana-whitfield",
   "captured_by": "Dana Whitfield",
   "captured_at": daysAgo(6)
  },
  {
   "provenance_id": "PROV-2ae3f783bbe9",
   "source_uri": "forms://submission/sub-20260819T134500Z-form9-dana-whitfield",
   "captured_by": "Dana Whitfield",
   "captured_at": daysAgo(6)
  },
  {
   "provenance_id": "PROV-1502af09c3e8",
   "source_uri": "forms://submission/sub-20260819T134500Z-form9-dana-whitfield",
   "captured_by": "Dana Whitfield",
   "captured_at": daysAgo(6)
  },
  {
   "provenance_id": "PROV-e003e15b6b5e",
   "source_uri": "forms://submission/sub-20260819T134500Z-form9-dana-whitfield",
   "captured_by": "Dana Whitfield",
   "captured_at": daysAgo(6)
  }
 ],
 "TEAM-006": [],
 "TEAM-007": []
});

// team_id -> raw ingested evidence items linked to a dimension at intake but
// not yet scored (Evidence.scored === false in the wire contract).
const seedEvidenceLog = (): Record<string, EvidenceLogItem[]> => ({
 "TEAM-003": [
  {
   "evidence_id": "EV-8d0d58d1db4f",
   "dimension_id": "9",
   "source_type": "document",
   "excerpt": "Governance charter draft uploaded by the team; not yet reviewed against the rubric.",
   "supports_level": null,
   "captured_at": daysAgo(2),
   "source_ref": "PROV-55b4b5a9a866",
   "scored": false,
   "status": "PENDING"
  },
  {
   "evidence_id": "EV-4aee83814b0f",
   "dimension_id": "10",
   "source_type": "artifact",
   "excerpt": "Screenshot of a Grafana dashboard, classified as monitoring evidence but not yet scored.",
   "supports_level": null,
   "captured_at": daysAgo(1),
   "source_ref": "PROV-28598ee17502",
   "scored": false,
   "status": "CLASSIFIED"
  }
 ],
 "TEAM-004": [
  {
   "evidence_id": "EV-a4ac49aea940",
   "dimension_id": "11",
   "source_type": "document",
   "excerpt": "Environment promotion runbook, submitted for dimension 11 but still queued for scoring.",
   "supports_level": null,
   "captured_at": daysAgo(2),
   "source_ref": "PROV-eeb01a2fd482",
   "scored": false,
   "status": "CLASSIFIED"
  }
 ]
});

// ─── Submissions (Forms envelopes) ─────────────────────────────────────────

export interface DimensionHint {
  dimension_id: string;
  main_answer: string;
  matched_level: number | null;
  follow_up_answer: string | null;
  evidence_context: string;
  self_rating: string;
  self_rating_aspect: string;
  claimed_na: boolean;
}

// `staged`/`committed`/`superseded` are the persisted values — the only ones
// `schema/assessment_schema.sql`'s CHECK constraint on `assessment_submissions.status`
// allows, so the DB row (and the aurora `envelope->status` mirror) never holds
// anything else. `processed` is wire-only: computed at read time by
// `isSubmissionProcessed` below and substituted for `committed` on the way
// out, never written to a row. See providers/assessment.ts's `wireSubmissionStatus`.
export type SubmissionStatus = 'staged' | 'committed' | 'superseded' | 'processed';

// A link an envelope carries evidence for — a URL pulled from a Forms answer at
// commit time, awaiting the (not-yet-implemented) fetch/skip worker. `status`
// mirrors the PATCH /submissions/:team/:envelope/links contract.
export type LinkStatus = 'pending' | 'fetched' | 'skipped';
export interface EnvelopeLink {
  url: string;
  label: string;
  dimension_id: string | null;
  status: LinkStatus;
}

export interface SubmissionEnvelope {
  schema_version: string;
  envelope_id: string;
  source: { kind: string; system: string; origin_file: string; origin_row: number; form_submission_id: string };
  team_id: string;
  team_name_raw: string;
  submitter: { name: string; email: string; is_primary_contact: boolean };
  submitted_at: string;
  ingested_at: string;
  assessment_date: string;
  self_certified: boolean;
  supersedes: string | null;
  dimension_hints: DimensionHint[];
  // Optional — the seeded fixture predates evidence links; envelopes minted by
  // POST /submissions/commit always populate it (see providers/assessment.ts).
  links?: EnvelopeLink[];
  status: SubmissionStatus;
  revision: number;
}

/**
 * True once every dimension this submission's self-assessment hinted at has
 * actually been WORKED — a scoring pass recorded against it — SINCE this
 * envelope was ingested, regardless of what that pass concluded. "Worked"
 * means `MockDimensionScore.history` carries an entry timestamped at or
 * after this envelope's `ingested_at`: `applyScores` always appends one,
 * whether the outcome is a verified level, an approved N/A, or "documented /
 * pending" (moderate confidence, no level set — not enough evidence yet,
 * but the dimension was reviewed). That last outcome is done being worked,
 * not still queued, so it must count: checking `current_level`/`is_na`
 * instead conflated "no verified level" with "never looked at" and made a
 * fully-processed submission with an inconclusive dimension read as
 * "Unprocessed" forever — and attaching more evidence without changing the
 * level couldn't fix it either. A dimension with no history at all (never
 * touched, or reset by `resetAssessment`, which clears history rather than
 * appending to it) still fails this check, exactly as it should.
 *
 * The recency check matters for a different reason: dimension scores are
 * team-scoped, so a team that was fully assessed before a NEW revision came
 * in (a resubmission) must not have that fresh, not-yet-processed revision
 * read as "processed" just because the team's older scoring history happens
 * to cover the same dimension ids. Only a `committed` envelope can ever
 * become processed: a `staged` one hasn't been ingested yet, and a
 * `superseded` one no longer represents the team's live answers. An
 * envelope with no hints at all (never happens via the commit path, but
 * true of some hand-authored fixtures) can never be "processed" either —
 * there's nothing to check off.
 */
export function isSubmissionProcessed(
  env: Pick<SubmissionEnvelope, 'status' | 'dimension_hints' | 'ingested_at'>,
  dims: Record<string, MockDimensionScore>,
): boolean {
  if (env.status !== 'committed') return false;
  const hints = env.dimension_hints ?? [];
  if (hints.length === 0) return false;
  return hints.every((h) => {
    const score = dims[h.dimension_id];
    if (score == null) return false;
    return score.history.some((entry) => entry.changed_at >= env.ingested_at);
  });
}

// team_id -> envelope_id -> envelope. Mutated by parse/commit/clear.
const seedSubmissions = (): Record<string, Record<string, SubmissionEnvelope>> => ({
 "TEAM-002": {
  "sub-20260810T091500Z-form5-jordan-lee": {
   "schema_version": "1.0",
   "envelope_id": "sub-20260810T091500Z-form5-jordan-lee",
   "source": {
    "kind": "ms_forms_export",
    "system": "microsoft_forms",
    "origin_file": "assessment-2026-08.csv",
    "origin_row": 5,
    "form_submission_id": "5"
   },
   "team_id": "TEAM-002",
   "team_name_raw": "Kubernetes Operator",
   "submitter": {
    "name": "Jordan Lee",
    "email": "jordan.lee@example.com",
    "is_primary_contact": true
   },
   "submitted_at": "8/10/2026 09:15",
   "ingested_at": daysAgo(28),
   "assessment_date": "8/10/2026",
   "self_certified": true,
   "supersedes": null,
   "dimension_hints": [
    {
     "dimension_id": "1",
     "main_answer": "CI runs on push for most repos.",
     "matched_level": null,
     "follow_up_answer": null,
     "evidence_context": "See linked repos and dashboards.",
     "self_rating": "Leading",
     "self_rating_aspect": "Continuous Integration (CI)",
     "claimed_na": false
    },
    {
     "dimension_id": "2",
     "main_answer": "We deploy via a manual runbook today.",
     "matched_level": null,
     "follow_up_answer": null,
     "evidence_context": "See linked repos and dashboards.",
     "self_rating": "Developing",
     "self_rating_aspect": "Continuous Delivery (CD)",
     "claimed_na": false
    }
   ],
   "status": "superseded",
   "revision": 1
  },
  "sub-20260810T091500Z-form5-jordan-lee-r2": {
   "schema_version": "1.0",
   "envelope_id": "sub-20260810T091500Z-form5-jordan-lee-r2",
   "source": {
    "kind": "ms_forms_export",
    "system": "microsoft_forms",
    "origin_file": "assessment-2026-08.csv",
    "origin_row": 5,
    "form_submission_id": "5"
   },
   "team_id": "TEAM-002",
   "team_name_raw": "Kubernetes Operator",
   "submitter": {
    "name": "Jordan Lee",
    "email": "jordan.lee@example.com",
    "is_primary_contact": true
   },
   "submitted_at": "8/16/2026 10:02",
   "ingested_at": daysAgo(22),
   "assessment_date": "8/16/2026",
   "self_certified": true,
   "supersedes": "sub-20260810T091500Z-form5-jordan-lee",
   "dimension_hints": [
    {
     "dimension_id": "1",
     "main_answer": "CI runs automatically on all our repositories, and a passing build+test is required before code can be merged.",
     "matched_level": null,
     "follow_up_answer": null,
     "evidence_context": "See linked repos and dashboards.",
     "self_rating": "Leading",
     "self_rating_aspect": "Continuous Integration (CI)",
     "claimed_na": false
    },
    {
     "dimension_id": "2",
     "main_answer": "We track release metrics (success rate, change failures, rollbacks) and validate our rollback procedures regularly.",
     "matched_level": null,
     "follow_up_answer": null,
     "evidence_context": "See linked repos and dashboards.",
     "self_rating": "Leading",
     "self_rating_aspect": "Continuous Delivery (CD)",
     "claimed_na": false
    },
    {
     "dimension_id": "3",
     "main_answer": "We track automation coverage and secret rotation; automated remediation detects secrets in code.",
     "matched_level": null,
     "follow_up_answer": null,
     "evidence_context": "See linked repos and dashboards.",
     "self_rating": "Leading",
     "self_rating_aspect": "Automation",
     "claimed_na": false
    }
   ],
   "status": "superseded",
   "revision": 2
  },
  "sub-20260810T091500Z-form5-jordan-lee-r3": {
   "schema_version": "1.0",
   "envelope_id": "sub-20260810T091500Z-form5-jordan-lee-r3",
   "source": {
    "kind": "ms_forms_export",
    "system": "microsoft_forms",
    "origin_file": "assessment-2026-08.csv",
    "origin_row": 5,
    "form_submission_id": "5"
   },
   "team_id": "TEAM-002",
   "team_name_raw": "Kubernetes Operator",
   "submitter": {
    "name": "Jordan Lee",
    "email": "jordan.lee@example.com",
    "is_primary_contact": true
   },
   "submitted_at": "8/20/2026 13:26",
   // daysAgo(13), not daysAgo(14), and the day matters more than it looks.
   //
   // TEAM-002's dimension history is stamped daysAgo(14) throughout, so this
   // envelope used to be ingested at the SAME nominal instant as the scoring
   // pass that would mark it processed. `isSubmissionProcessed` compares them
   // with `>=`, and each stamp is sampled independently when its own fixture
   // materializes — so which side of the boundary this landed on was decided by
   // milliseconds of fixture-materialization order, not by the story. The wire
   // capture caught it: `envelopes[].status` held "committed" in one run and
   // dropped it in the next with nothing in the repo changed between them.
   //
   // Deciding it also fills a real gap. TEAM-005's envelope already covers
   // "processed" strictly (ingested daysAgo(6), scored daysAgo(5)), so with this
   // one processed too, `committed` appeared NOWHERE on the wire — the state a
   // resubmission sits in while it waits to be rescored had no fixture, which is
   // exactly the recency case `isSubmissionProcessed` was written for and the one
   // the DEFECTS.md filing was about. r3 supersedes r2 and arrived a day after
   // the team was last scored: the team reads ASSESSED, its latest submission
   // reads Committed, and someone has to look at it. That is the honest world.
   "ingested_at": daysAgo(13),
   "assessment_date": "8/20/2026",
   "self_certified": true,
   "supersedes": "sub-20260810T091500Z-form5-jordan-lee-r2",
   "dimension_hints": [
    {
     "dimension_id": "1",
     "main_answer": "CI runs automatically on all our repositories, and a passing build+test is required before code can be merged.",
     "matched_level": null,
     "follow_up_answer": null,
     "evidence_context": "See linked repos and dashboards.",
     "self_rating": "Leading",
     "self_rating_aspect": "Continuous Integration (CI)",
     "claimed_na": false
    },
    {
     "dimension_id": "2",
     "main_answer": "We track release metrics (success rate, change failures, rollbacks) and validate our rollback procedures regularly.",
     "matched_level": null,
     "follow_up_answer": null,
     "evidence_context": "See linked repos and dashboards.",
     "self_rating": "Leading",
     "self_rating_aspect": "Continuous Delivery (CD)",
     "claimed_na": false
    },
    {
     "dimension_id": "3",
     "main_answer": "We track automation coverage and secret rotation; automated remediation detects secrets in code.",
     "matched_level": null,
     "follow_up_answer": null,
     "evidence_context": "See linked repos and dashboards.",
     "self_rating": "Leading",
     "self_rating_aspect": "Automation",
     "claimed_na": false
    },
    {
     "dimension_id": "4",
     "main_answer": "Traceability is fully automated; we detect infrastructure drift in real-time.",
     "matched_level": null,
     "follow_up_answer": null,
     "evidence_context": "See linked repos and dashboards.",
     "self_rating": "Leading",
     "self_rating_aspect": "Source Control & Traceability",
     "claimed_na": false
    },
    {
     "dimension_id": "5",
     "main_answer": "We track test coverage, stability, and failure trends; test results influence release decisions.",
     "matched_level": null,
     "follow_up_answer": null,
     "evidence_context": "See linked repos and dashboards.",
     "self_rating": "Leading",
     "self_rating_aspect": "Testing & QE – Automated Testing",
     "claimed_na": false
    },
    {
     "dimension_id": "6",
     "main_answer": "Security validation is continuous, preventative, and embedded in our workflows.",
     "matched_level": null,
     "follow_up_answer": null,
     "evidence_context": "See linked repos and dashboards.",
     "self_rating": "Leading",
     "self_rating_aspect": "Testing & QE – Security Testing",
     "claimed_na": false
    }
   ],
   "status": "committed",
   "revision": 3
  }
 },
 "TEAM-003": {
  "sub-20260828T101500Z-form12-sam-okafor": {
   "schema_version": "1.0",
   "envelope_id": "sub-20260828T101500Z-form12-sam-okafor",
   "source": {
    "kind": "ms_forms_export",
    "system": "microsoft_forms",
    "origin_file": "assessment-2026-08.csv",
    "origin_row": 12,
    "form_submission_id": "12"
   },
   "team_id": "TEAM-003",
   "team_name_raw": "Checkout Experience",
   "submitter": {
    "name": "Sam Okafor",
    "email": "sam.okafor@example.com",
    "is_primary_contact": true
   },
   "submitted_at": "8/28/2026 10:15",
   "ingested_at": daysAgo(6),
   "assessment_date": "8/28/2026",
   "self_certified": true,
   "supersedes": null,
   "dimension_hints": [
    {
     "dimension_id": "1",
     "main_answer": "We have a pipeline but it's triggered manually most of the time.",
     "matched_level": null,
     "follow_up_answer": null,
     "evidence_context": "See linked repos and dashboards.",
     "self_rating": "Developing",
     "self_rating_aspect": "Continuous Integration (CI)",
     "claimed_na": false
    },
    {
     "dimension_id": "2",
     "main_answer": "Releases follow a documented runbook.",
     "matched_level": null,
     "follow_up_answer": null,
     "evidence_context": "See linked repos and dashboards.",
     "self_rating": "Initial",
     "self_rating_aspect": "Continuous Delivery (CD)",
     "claimed_na": false
    },
    {
     "dimension_id": "3",
     "main_answer": "Some Terraform exists but changes are often made by hand.",
     "matched_level": null,
     "follow_up_answer": null,
     "evidence_context": "See linked repos and dashboards.",
     "self_rating": "Initial",
     "self_rating_aspect": "Automation",
     "claimed_na": false
    },
    {
     "dimension_id": "4",
     "main_answer": "Most code is in version control; scripts sometimes live outside it.",
     "matched_level": null,
     "follow_up_answer": null,
     "evidence_context": "See linked repos and dashboards.",
     "self_rating": "Developing",
     "self_rating_aspect": "Source Control & Traceability",
     "claimed_na": false
    }
   ],
   "status": "staged",
   "revision": 1
  }
 },
 "TEAM-005": {
  "sub-20260819T134500Z-form9-dana-whitfield": {
   "schema_version": "1.0",
   "envelope_id": "sub-20260819T134500Z-form9-dana-whitfield",
   "source": {
    "kind": "ms_forms_export",
    "system": "microsoft_forms",
    "origin_file": "assessment-2026-08.csv",
    "origin_row": 9,
    "form_submission_id": "9"
   },
   "team_id": "TEAM-005",
   "team_name_raw": "Notifications Service",
   "submitter": {
    "name": "Dana Whitfield",
    "email": "dana.whitfield@example.com",
    "is_primary_contact": true
   },
   "submitted_at": "8/19/2026 13:45",
   "ingested_at": daysAgo(8),
   "assessment_date": "8/19/2026",
   "self_certified": true,
   "supersedes": null,
   "dimension_hints": [
    {
     "dimension_id": "1",
     "main_answer": "No CI pipeline yet; we build and test locally.",
     "matched_level": null,
     "follow_up_answer": null,
     "evidence_context": "See linked repos and dashboards.",
     "self_rating": "Below Baseline",
     "self_rating_aspect": "Continuous Integration (CI)",
     "claimed_na": false
    },
    {
     "dimension_id": "2",
     "main_answer": "Releases are manual, no runbook.",
     "matched_level": null,
     "follow_up_answer": null,
     "evidence_context": "See linked repos and dashboards.",
     "self_rating": "Below Baseline",
     "self_rating_aspect": "Continuous Delivery (CD)",
     "claimed_na": false
    },
    {
     "dimension_id": "3",
     "main_answer": "No automation; everything is console changes.",
     "matched_level": null,
     "follow_up_answer": null,
     "evidence_context": "See linked repos and dashboards.",
     "self_rating": "Below Baseline",
     "self_rating_aspect": "Automation",
     "claimed_na": false
    }
   ],
   "status": "committed",
   "revision": 1
  }
 }
});

// ─── Runs ───────────────────────────────────────────────────────────────────

export type RunStatus = 'running' | 'completed' | 'failed';

export interface MockRun {
  id: string;
  command: string;
  team_id: string | null;
  args: Record<string, unknown>;
  status: RunStatus;
  source: string;
  started_at: string;
  finished_at: string | null;
  summary: string;
  error: string | null;
  files_written: string[];
}

// Mutated in place: launchRun() pushes new records and a mock timer advances
// running -> completed after ~8s.
const seedRuns = (): MockRun[] => [
 {
  "id": "run-20260828T090211Z-classify-transcript-4f21ab5c9d10",
  "command": "classify-transcript",
  "team_id": "TEAM-003",
  "args": {},
  "status": "completed",
  "source": "agent",
  "started_at": daysAgo(7),
  "finished_at": daysAgo(7),
  "summary": "Classified 1 interview transcript into 8 dimension-tagged excerpts.",
  "error": null,
  "files_written": [
   "workspace/teams/TEAM-003/lineage/classify_20260828T090211Z.json"
  ]
 },
 {
  "id": "run-20260828T093310Z-score-dimensions-9c02de11aa3f",
  "command": "score-dimensions",
  "team_id": "TEAM-003",
  "args": {},
  "status": "completed",
  "source": "agent",
  "started_at": daysAgo(7),
  "finished_at": daysAgo(7),
  "summary": "Scored 8 dimensions from classified transcript evidence.",
  "error": null,
  "files_written": [
   "workspace/teams/TEAM-003/reports/scoring_log_20260828T093310Z.json"
  ]
 },
 {
  "id": "run-20260830T114502Z-process-self-assessment-1a77f0c3",
  "command": "process-self-assessment",
  "team_id": "TEAM-002",
  "args": {
   "envelope_id": "sub-20260810T091500Z-form5-jordan-lee-r3"
  },
  "status": "completed",
  "source": "agent",
  "started_at": daysAgo(5),
  "finished_at": daysAgo(5),
  "summary": "Scored revision r3 of the Forms submission across 17 dimensions; self-rating-only cap applied everywhere.",
  "error": null,
  "files_written": [
   "workspace/teams/TEAM-002/reports/scoring_log_20260830T114502Z.json"
  ]
 },
 {
  "id": "run-20260831T080015Z-score-dimensions-6b41cdaa02e7",
  "command": "score-dimensions",
  "team_id": "TEAM-001",
  "args": {},
  "status": "completed",
  "source": "agent",
  "started_at": daysAgo(4),
  "finished_at": daysAgo(4),
  "summary": "Re-scored 15 dimensions after the governance review minutes were uploaded.",
  "error": null,
  "files_written": [
   "workspace/teams/TEAM-001/reports/scoring_log_20260831T080015Z.json"
  ]
 },
 {
  "id": "run-20260901T101233Z-extract-enterprise-context-e30a9188",
  "command": "extract-enterprise-context",
  "team_id": null,
  "args": {},
  "status": "completed",
  "source": "agent",
  "started_at": daysAgo(3),
  "finished_at": daysAgo(3),
  "summary": "Extracted 4 governance facts into the enterprise-context knowledge tree.",
  "error": null,
  "files_written": [
   "workspace/enterprise_context/organization/raci.md"
  ]
 },
 {
  "id": "run-20260902T133340Z-develop-jira-story-77bdf2aa11cc",
  "command": "develop-jira-story",
  "team_id": "TEAM-001",
  "args": {
   "dimension": "1"
  },
  "status": "completed",
  "source": "agent",
  "started_at": daysAgo(2),
  "finished_at": daysAgo(2),
  "summary": "Drafted a story for dimension 1 (close the open CI claim).",
  "error": null,
  "files_written": [
   "workspace/teams/TEAM-001/reports/stories/story-dim1-ci-evidence.md"
  ]
 },
 {
  "id": "run-20260902T140102Z-draft-confluence-page-0c9a4eff33aa",
  "command": "draft-confluence-page",
  "team_id": "TEAM-002",
  "args": {},
  "status": "completed",
  "source": "agent",
  "started_at": daysAgo(2),
  "finished_at": daysAgo(2),
  "summary": "Drafted a Confluence page summarizing the team's certification status.",
  "error": null,
  "files_written": [
   "workspace/teams/TEAM-002/reports/drafts/certification-summary.md"
  ]
 },
 {
  "id": "run-20260903T091500Z-suggest-confluence-content-55e6aa21bb",
  "command": "suggest-confluence-content",
  "team_id": "TEAM-004",
  "args": {
   "space": "ENG-DATA"
  },
  "status": "failed",
  "source": "agent",
  "started_at": daysAgo(1),
  "finished_at": daysAgo(1),
  "summary": "",
  "error": "Confluence space ENG-DATA is not yet linked for this team.",
  "files_written": []
 },
 {
  "id": "run-20260903T150213Z-validate-outputs-3d88f1cc09ee",
  "command": "validate-outputs",
  "team_id": "TEAM-002",
  "args": {},
  "status": "completed",
  "source": "agent",
  "started_at": hoursAgo(20),
  "finished_at": hoursAgo(20),
  "summary": "Validated scoring_log_20260830T114502Z.json against the rubric schema — no violations.",
  "error": null,
  "files_written": [
   "workspace/teams/TEAM-002/reports/validation_20260903T150213Z.json"
  ]
 },
 {
  "id": "run-20260903T160500Z-draw-diagram-a204be009911",
  "command": "draw-diagram",
  "team_id": "TEAM-001",
  "args": {},
  "status": "completed",
  "source": "agent",
  "started_at": hoursAgo(15),
  "finished_at": hoursAgo(15),
  "summary": "Rendered the payment-reconciliation sequence diagram referenced in dimension 9 evidence.",
  "error": null,
  "files_written": [
   "workspace/teams/TEAM-001/reports/diagrams/reconciliation-sequence.drawio"
  ]
 },
 {
  "id": "run-20260904T070211Z-process-self-assessment-9be301aa44",
  "command": "process-self-assessment",
  "team_id": "TEAM-005",
  "args": {
   "envelope_id": "sub-20260819T134500Z-form9-dana-whitfield"
  },
  "status": "failed",
  "source": "agent",
  "started_at": hoursAgo(9),
  "finished_at": hoursAgo(9),
  "summary": "",
  "error": "Forms export row 9 is missing a team_id mapping; ingestion halted before scoring.",
  "files_written": []
 },
 {
  "id": "run-20260904T091140Z-score-dimensions-cc10aa77ff02",
  "command": "score-dimensions",
  "team_id": "TEAM-003",
  "args": {},
  "status": "running",
  "source": "agent",
  "started_at": minutesAgo(6),
  "finished_at": null,
  "summary": "Scoring dimensions 1-8 from the newly parsed submission.",
  "error": null,
  "files_written": []
 }
];

// Terminal runs are seeded with finished_at == started_at (both `hoursAgo(n)`),
// so every duration in the ledger read "0m 00s" — a fleet of instant agents,
// which is not a plausible thing. Give each terminal run a deterministic
// duration derived from its id, so the same run always reports the same
// length across reloads and tests. This runs INSIDE the rows factory: as a
// module-scope loop it stamped durations onto the one array built at import.
function withRunDurations(runs: MockRun[]): MockRun[] {
  for (const r of runs) {
    if (r.finished_at !== null && r.finished_at === r.started_at) {
      const seed = [...r.id].reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) >>> 0, 7);
      const seconds = 90 + (seed % 480);                       // 1m30s .. 9m29s
      r.finished_at = new Date(Date.parse(r.started_at) + seconds * 1000).toISOString();
    }
  }
  return runs;
}

// ─── Scoring logs (reasoning-log sidecars) ─────────────────────────────────

export interface ScoringLogEntry {
  dimension_id: string;
  is_na: boolean;
  suggested_level: number | null;
  confidence: Confidence;
  rationale: string;
  evidence_excerpts: string[];
  follow_up_questions: string[];
  na_claimed: boolean;
  self_claimed_level: number | null;
  evidence_class: EvidenceClass | null;
  cap_applied: boolean;
}

export interface ScoringLog {
  team_id: string;
  envelope_id: string | null;
  stamp: string;
  source: string;
  scores: ScoringLogEntry[];
  /** The agent run that produced this log, when there was one — optional so
   * seeded/manual logs (none of which have a run behind them) stay valid. */
  run_id?: string;
}

// team_id -> logs, newest first.
const seedScoringLogs = (): Record<string, ScoringLog[]> => ({
 "TEAM-001": [
  {
   "team_id": "TEAM-001",
   "envelope_id": null,
   "stamp": "20260831T080015Z",
   "source": "agent",
   "scores": [
    {
     "dimension_id": "1",
     "is_na": false,
     "suggested_level": 2,
     "confidence": "low",
     "rationale": "Self-claimed Level 5 (\"Leading\") is not supported by any linked evidence beyond the team's own account, and what was reviewed shows CI triggers automatically on push for only one of two repositories with no merge gate. Verification reaches Level 2 and stops there — the claim stays open.",
     "evidence_excerpts": [
      "Continuous Integration (CI): our practice matches \"Developing\" — this is what the team told us in the self-assessment survey, nothing more."
     ],
     "follow_up_questions": [
      "You rated CI as \"Leading\" but the pipeline evidence you linked only shows manual, ad-hoc runs — can you share branch-protection settings and recent pipeline history so we can verify past Level 2?",
      "Is there a dashboard or export showing CI running automatically across all repositories, not just this one?"
     ],
     "na_claimed": false,
     "self_claimed_level": 5,
     "evidence_class": "attested",
     "cap_applied": false
    },
    {
     "dimension_id": "2",
     "is_na": false,
     "suggested_level": 3,
     "confidence": "moderate",
     "rationale": "Self-rating and evidence both point to \"Defined\" for Continuous Delivery (CD).",
     "evidence_excerpts": [
      "Continuous Delivery (CD): our practice matches \"Defined\" — we pointed the assessor at a written runbook/standard covering this."
     ],
     "follow_up_questions": [
      "Can you share a recent example (not just the standard doc) showing Continuous Delivery (CD) in practice this quarter?"
     ],
     "na_claimed": false,
     "self_claimed_level": 4,
     "evidence_class": "documented",
     "cap_applied": false
    },
    {
     "dimension_id": "3",
     "is_na": false,
     "suggested_level": 3,
     "confidence": "moderate",
     "rationale": "Self-rating and evidence both point to \"Defined\" for Automation.",
     "evidence_excerpts": [
      "Automation: our practice matches \"Defined\" — we pointed the assessor at a written runbook/standard covering this."
     ],
     "follow_up_questions": [],
     "na_claimed": false,
     "self_claimed_level": 3,
     "evidence_class": "documented",
     "cap_applied": false
    },
    {
     "dimension_id": "4",
     "is_na": false,
     "suggested_level": 3,
     "confidence": "moderate",
     "rationale": "Self-rating and evidence both point to \"Defined\" for Source Control & Traceability.",
     "evidence_excerpts": [
      "Source Control & Traceability: our practice matches \"Defined\" — we pointed the assessor at a written runbook/standard covering this."
     ],
     "follow_up_questions": [
      "Can you share a recent example (not just the standard doc) showing Source Control & Traceability in practice this quarter?"
     ],
     "na_claimed": false,
     "self_claimed_level": 3,
     "evidence_class": "documented",
     "cap_applied": false
    },
    {
     "dimension_id": "5",
     "is_na": false,
     "suggested_level": 3,
     "confidence": "moderate",
     "rationale": "Self-rating and evidence both point to \"Defined\" for Testing & QE – Automated Testing.",
     "evidence_excerpts": [
      "Testing & QE – Automated Testing: our practice matches \"Defined\" — we pointed the assessor at a written runbook/standard covering this."
     ],
     "follow_up_questions": [],
     "na_claimed": false,
     "self_claimed_level": 4,
     "evidence_class": "documented",
     "cap_applied": false
    },
    {
     "dimension_id": "6",
     "is_na": true,
     "suggested_level": null,
     "confidence": "low",
     "rationale": "Not applicable if the team does not develop, modify, deploy, or maintain code, scripts, applications, APIs, Infrastructure-as-Code, or configuration that requires security… Approved under the internal-tooling-no-deploy archetype.",
     "evidence_excerpts": [],
     "follow_up_questions": [],
     "na_claimed": true,
     "self_claimed_level": null,
     "evidence_class": null,
     "cap_applied": false
    },
    {
     "dimension_id": "7",
     "is_na": true,
     "suggested_level": null,
     "confidence": "low",
     "rationale": "Team-requested N/A pending lead review: \"we own no internet-facing service, this is an internal batch reconciliation job.\"",
     "evidence_excerpts": [],
     "follow_up_questions": [],
     "na_claimed": true,
     "self_claimed_level": null,
     "evidence_class": null,
     "cap_applied": false
    },
    {
     "dimension_id": "8",
     "is_na": false,
     "suggested_level": 3,
     "confidence": "moderate",
     "rationale": "Self-rating and evidence both point to \"Defined\" for Security Control SDLC & Code Review Practices.",
     "evidence_excerpts": [
      "Security Control SDLC & Code Review Practices: our practice matches \"Defined\" — we pointed the assessor at a written runbook/standard covering this."
     ],
     "follow_up_questions": [
      "Can you share a recent example (not just the standard doc) showing Security Control SDLC & Code Review Practices in practice this quarter?"
     ],
     "na_claimed": false,
     "self_claimed_level": 3,
     "evidence_class": "documented",
     "cap_applied": false
    },
    {
     "dimension_id": "9",
     "is_na": false,
     "suggested_level": 4,
     "confidence": "high",
     "rationale": "The assessor opened the governance review minutes directly: decision rights are documented, a monthly architecture review board tracks decision quality, and two governance escapes were remediated with a documented process change. This is Observed evidence sustained over two review cycles, which is what Level 4 requires — verification reaches Level 4.",
     "evidence_excerpts": [
      "Engineering Governance: our practice matches \"Measured\" — the assessor opened the artifact directly (dashboard, pipeline run, or repo) and confirmed it."
     ],
     "follow_up_questions": [],
     "na_claimed": false,
     "self_claimed_level": 4,
     "evidence_class": "observed",
     "cap_applied": false
    },
    {
     "dimension_id": "10",
     "is_na": false,
     "suggested_level": 3,
     "confidence": "moderate",
     "rationale": "Self-rating and evidence both point to \"Defined\" for Monitoring, Observability & Runtime Security.",
     "evidence_excerpts": [
      "Monitoring, Observability & Runtime Security: our practice matches \"Defined\" — we pointed the assessor at a written runbook/standard covering this."
     ],
     "follow_up_questions": [],
     "na_claimed": false,
     "self_claimed_level": 3,
     "evidence_class": "documented",
     "cap_applied": false
    },
    {
     "dimension_id": "11",
     "is_na": false,
     "suggested_level": 3,
     "confidence": "moderate",
     "rationale": "Self-rating and evidence both point to \"Defined\" for Environment Management.",
     "evidence_excerpts": [
      "Environment Management: our practice matches \"Defined\" — we pointed the assessor at a written runbook/standard covering this."
     ],
     "follow_up_questions": [
      "Can you share a recent example (not just the standard doc) showing Environment Management in practice this quarter?"
     ],
     "na_claimed": false,
     "self_claimed_level": 4,
     "evidence_class": "documented",
     "cap_applied": false
    },
    {
     "dimension_id": "12",
     "is_na": false,
     "suggested_level": 3,
     "confidence": "moderate",
     "rationale": "Self-rating and evidence both point to \"Defined\" for Release Management & Operational Reliability.",
     "evidence_excerpts": [
      "Release Management & Operational Reliability: our practice matches \"Defined\" — we pointed the assessor at a written runbook/standard covering this."
     ],
     "follow_up_questions": [],
     "na_claimed": false,
     "self_claimed_level": 3,
     "evidence_class": "documented",
     "cap_applied": false
    },
    {
     "dimension_id": "13",
     "is_na": false,
     "suggested_level": 3,
     "confidence": "moderate",
     "rationale": "Self-rating and evidence both point to \"Defined\" for Platform Reusability & Patterns.",
     "evidence_excerpts": [
      "Platform Reusability & Patterns: our practice matches \"Defined\" — we pointed the assessor at a written runbook/standard covering this."
     ],
     "follow_up_questions": [
      "Can you share a recent example (not just the standard doc) showing Platform Reusability & Patterns in practice this quarter?"
     ],
     "na_claimed": false,
     "self_claimed_level": 3,
     "evidence_class": "documented",
     "cap_applied": false
    },
    {
     "dimension_id": "14",
     "is_na": false,
     "suggested_level": 3,
     "confidence": "moderate",
     "rationale": "Self-rating and evidence both point to \"Defined\" for Software Development Mindset & Automation Culture.",
     "evidence_excerpts": [
      "Software Development Mindset & Automation Culture: our practice matches \"Defined\" — we pointed the assessor at a written runbook/standard covering this."
     ],
     "follow_up_questions": [],
     "na_claimed": false,
     "self_claimed_level": 4,
     "evidence_class": "documented",
     "cap_applied": false
    },
    {
     "dimension_id": "15",
     "is_na": false,
     "suggested_level": 3,
     "confidence": "moderate",
     "rationale": "Self-rating and evidence both point to \"Defined\" for Agile Planning & Backlog Management.",
     "evidence_excerpts": [
      "Agile Planning & Backlog Management: our practice matches \"Defined\" — we pointed the assessor at a written runbook/standard covering this."
     ],
     "follow_up_questions": [
      "Can you share a recent example (not just the standard doc) showing Agile Planning & Backlog Management in practice this quarter?"
     ],
     "na_claimed": false,
     "self_claimed_level": 3,
     "evidence_class": "documented",
     "cap_applied": false
    },
    {
     "dimension_id": "16",
     "is_na": false,
     "suggested_level": 3,
     "confidence": "moderate",
     "rationale": "Self-rating and evidence both point to \"Defined\" for Design Standards & Technical Decision Process.",
     "evidence_excerpts": [
      "Design Standards & Technical Decision Process: our practice matches \"Defined\" — we pointed the assessor at a written runbook/standard covering this."
     ],
     "follow_up_questions": [],
     "na_claimed": false,
     "self_claimed_level": 3,
     "evidence_class": "documented",
     "cap_applied": false
    },
    {
     "dimension_id": "17",
     "is_na": false,
     "suggested_level": 3,
     "confidence": "moderate",
     "rationale": "Self-rating and evidence both point to \"Defined\" for Engineering Metrics & Continuous Improvement.",
     "evidence_excerpts": [
      "Engineering Metrics & Continuous Improvement: our practice matches \"Defined\" — we pointed the assessor at a written runbook/standard covering this."
     ],
     "follow_up_questions": [
      "Can you share a recent example (not just the standard doc) showing Engineering Metrics & Continuous Improvement in practice this quarter?"
     ],
     "na_claimed": false,
     "self_claimed_level": 4,
     "evidence_class": "documented",
     "cap_applied": false
    }
   ]
  }
 ],
 "TEAM-002": [
  {
   "team_id": "TEAM-002",
   "envelope_id": "sub-20260810T091500Z-form5-jordan-lee-r3",
   "stamp": "20260830T114502Z",
   "source": "agent",
   "scores": [
    {
     "dimension_id": "1",
     "is_na": false,
     "suggested_level": 3,
     "confidence": "low",
     "rationale": "Self-report alone claims higher than \"Defined\" for Continuous Integration (CI); a self-rating with no independent corroboration caps at Level 3 per the scoring stance, so verification stops at Level 3.",
     "evidence_excerpts": [
      "Continuous Integration (CI): our practice matches \"Defined\" — this is what the team told us in the self-assessment survey, nothing more.",
      "Same answer, reconfirmed on the follow-up revision of the Forms submission."
     ],
     "follow_up_questions": [
      "Could you share the dashboard, pipeline run, or export backing your \"Continuous Integration (CI)\" answer so we can verify beyond the survey response?"
     ],
     "na_claimed": false,
     "self_claimed_level": 5,
     "evidence_class": "attested",
     "cap_applied": true
    },
    {
     "dimension_id": "2",
     "is_na": false,
     "suggested_level": 3,
     "confidence": "low",
     "rationale": "Self-report alone claims higher than \"Defined\" for Continuous Delivery (CD); a self-rating with no independent corroboration caps at Level 3 per the scoring stance, so verification stops at Level 3.",
     "evidence_excerpts": [
      "Continuous Delivery (CD): our practice matches \"Defined\" — this is what the team told us in the self-assessment survey, nothing more.",
      "Same answer, reconfirmed on the follow-up revision of the Forms submission."
     ],
     "follow_up_questions": [
      "Could you share the dashboard, pipeline run, or export backing your \"Continuous Delivery (CD)\" answer so we can verify beyond the survey response?"
     ],
     "na_claimed": false,
     "self_claimed_level": 5,
     "evidence_class": "attested",
     "cap_applied": true
    },
    {
     "dimension_id": "3",
     "is_na": false,
     "suggested_level": 3,
     "confidence": "low",
     "rationale": "Self-report alone claims higher than \"Defined\" for Automation; a self-rating with no independent corroboration caps at Level 3 per the scoring stance, so verification stops at Level 3.",
     "evidence_excerpts": [
      "Automation: our practice matches \"Defined\" — this is what the team told us in the self-assessment survey, nothing more."
     ],
     "follow_up_questions": [
      "Could you share the dashboard, pipeline run, or export backing your \"Automation\" answer so we can verify beyond the survey response?"
     ],
     "na_claimed": false,
     "self_claimed_level": 5,
     "evidence_class": "attested",
     "cap_applied": true
    },
    {
     "dimension_id": "4",
     "is_na": false,
     "suggested_level": 3,
     "confidence": "low",
     "rationale": "Self-report alone claims higher than \"Defined\" for Source Control & Traceability; a self-rating with no independent corroboration caps at Level 3 per the scoring stance, so verification stops at Level 3.",
     "evidence_excerpts": [
      "Source Control & Traceability: our practice matches \"Defined\" — this is what the team told us in the self-assessment survey, nothing more."
     ],
     "follow_up_questions": [
      "Could you share the dashboard, pipeline run, or export backing your \"Source Control & Traceability\" answer so we can verify beyond the survey response?"
     ],
     "na_claimed": false,
     "self_claimed_level": 5,
     "evidence_class": "attested",
     "cap_applied": true
    },
    {
     "dimension_id": "5",
     "is_na": false,
     "suggested_level": 3,
     "confidence": "low",
     "rationale": "Self-report alone claims higher than \"Defined\" for Testing & QE – Automated Testing; a self-rating with no independent corroboration caps at Level 3 per the scoring stance, so verification stops at Level 3.",
     "evidence_excerpts": [
      "Testing & QE – Automated Testing: our practice matches \"Defined\" — this is what the team told us in the self-assessment survey, nothing more."
     ],
     "follow_up_questions": [
      "Could you share the dashboard, pipeline run, or export backing your \"Testing & QE – Automated Testing\" answer so we can verify beyond the survey response?"
     ],
     "na_claimed": false,
     "self_claimed_level": 5,
     "evidence_class": "attested",
     "cap_applied": true
    },
    {
     "dimension_id": "6",
     "is_na": false,
     "suggested_level": 3,
     "confidence": "low",
     "rationale": "Self-report alone claims higher than \"Defined\" for Testing & QE – Security Testing; a self-rating with no independent corroboration caps at Level 3 per the scoring stance, so verification stops at Level 3.",
     "evidence_excerpts": [
      "Testing & QE – Security Testing: our practice matches \"Defined\" — this is what the team told us in the self-assessment survey, nothing more."
     ],
     "follow_up_questions": [
      "Could you share the dashboard, pipeline run, or export backing your \"Testing & QE – Security Testing\" answer so we can verify beyond the survey response?"
     ],
     "na_claimed": false,
     "self_claimed_level": 5,
     "evidence_class": "attested",
     "cap_applied": true
    },
    {
     "dimension_id": "7",
     "is_na": false,
     "suggested_level": 3,
     "confidence": "low",
     "rationale": "Self-report alone claims higher than \"Defined\" for Testing & QE – Performance & Reliability Testing; a self-rating with no independent corroboration caps at Level 3 per the scoring stance, so verification stops at Level 3.",
     "evidence_excerpts": [
      "Testing & QE – Performance & Reliability Testing: our practice matches \"Defined\" — this is what the team told us in the self-assessment survey, nothing more."
     ],
     "follow_up_questions": [
      "Could you share the dashboard, pipeline run, or export backing your \"Testing & QE – Performance & Reliability Testing\" answer so we can verify beyond the survey response?"
     ],
     "na_claimed": false,
     "self_claimed_level": 5,
     "evidence_class": "attested",
     "cap_applied": true
    },
    {
     "dimension_id": "8",
     "is_na": false,
     "suggested_level": 3,
     "confidence": "low",
     "rationale": "Self-report alone claims higher than \"Defined\" for Security Control SDLC & Code Review Practices; a self-rating with no independent corroboration caps at Level 3 per the scoring stance, so verification stops at Level 3.",
     "evidence_excerpts": [
      "Security Control SDLC & Code Review Practices: our practice matches \"Defined\" — this is what the team told us in the self-assessment survey, nothing more."
     ],
     "follow_up_questions": [
      "Could you share the dashboard, pipeline run, or export backing your \"Security Control SDLC & Code Review Practices\" answer so we can verify beyond the survey response?"
     ],
     "na_claimed": false,
     "self_claimed_level": 5,
     "evidence_class": "attested",
     "cap_applied": true
    },
    {
     "dimension_id": "9",
     "is_na": false,
     "suggested_level": 3,
     "confidence": "low",
     "rationale": "Self-report alone claims higher than \"Defined\" for Engineering Governance; a self-rating with no independent corroboration caps at Level 3 per the scoring stance, so verification stops at Level 3.",
     "evidence_excerpts": [
      "Engineering Governance: our practice matches \"Defined\" — this is what the team told us in the self-assessment survey, nothing more."
     ],
     "follow_up_questions": [
      "Could you share the dashboard, pipeline run, or export backing your \"Engineering Governance\" answer so we can verify beyond the survey response?"
     ],
     "na_claimed": false,
     "self_claimed_level": 5,
     "evidence_class": "attested",
     "cap_applied": true
    },
    {
     "dimension_id": "10",
     "is_na": false,
     "suggested_level": 3,
     "confidence": "low",
     "rationale": "Self-report alone claims higher than \"Defined\" for Monitoring, Observability & Runtime Security; a self-rating with no independent corroboration caps at Level 3 per the scoring stance, so verification stops at Level 3.",
     "evidence_excerpts": [
      "Monitoring, Observability & Runtime Security: our practice matches \"Defined\" — this is what the team told us in the self-assessment survey, nothing more."
     ],
     "follow_up_questions": [
      "Could you share the dashboard, pipeline run, or export backing your \"Monitoring, Observability & Runtime Security\" answer so we can verify beyond the survey response?"
     ],
     "na_claimed": false,
     "self_claimed_level": 5,
     "evidence_class": "attested",
     "cap_applied": true
    },
    {
     "dimension_id": "11",
     "is_na": false,
     "suggested_level": 3,
     "confidence": "low",
     "rationale": "Self-report alone claims higher than \"Defined\" for Environment Management; a self-rating with no independent corroboration caps at Level 3 per the scoring stance, so verification stops at Level 3.",
     "evidence_excerpts": [
      "Environment Management: our practice matches \"Defined\" — this is what the team told us in the self-assessment survey, nothing more."
     ],
     "follow_up_questions": [
      "Could you share the dashboard, pipeline run, or export backing your \"Environment Management\" answer so we can verify beyond the survey response?"
     ],
     "na_claimed": false,
     "self_claimed_level": 5,
     "evidence_class": "attested",
     "cap_applied": true
    },
    {
     "dimension_id": "12",
     "is_na": false,
     "suggested_level": 3,
     "confidence": "low",
     "rationale": "Self-report alone claims higher than \"Defined\" for Release Management & Operational Reliability; a self-rating with no independent corroboration caps at Level 3 per the scoring stance, so verification stops at Level 3.",
     "evidence_excerpts": [
      "Release Management & Operational Reliability: our practice matches \"Defined\" — this is what the team told us in the self-assessment survey, nothing more."
     ],
     "follow_up_questions": [
      "Could you share the dashboard, pipeline run, or export backing your \"Release Management & Operational Reliability\" answer so we can verify beyond the survey response?"
     ],
     "na_claimed": false,
     "self_claimed_level": 5,
     "evidence_class": "attested",
     "cap_applied": true
    },
    {
     "dimension_id": "13",
     "is_na": false,
     "suggested_level": 3,
     "confidence": "low",
     "rationale": "Self-report alone claims higher than \"Defined\" for Platform Reusability & Patterns; a self-rating with no independent corroboration caps at Level 3 per the scoring stance, so verification stops at Level 3.",
     "evidence_excerpts": [
      "Platform Reusability & Patterns: our practice matches \"Defined\" — this is what the team told us in the self-assessment survey, nothing more."
     ],
     "follow_up_questions": [
      "Could you share the dashboard, pipeline run, or export backing your \"Platform Reusability & Patterns\" answer so we can verify beyond the survey response?"
     ],
     "na_claimed": false,
     "self_claimed_level": 5,
     "evidence_class": "attested",
     "cap_applied": true
    },
    {
     "dimension_id": "14",
     "is_na": false,
     "suggested_level": 3,
     "confidence": "low",
     "rationale": "Self-report alone claims higher than \"Defined\" for Software Development Mindset & Automation Culture; a self-rating with no independent corroboration caps at Level 3 per the scoring stance, so verification stops at Level 3.",
     "evidence_excerpts": [
      "Software Development Mindset & Automation Culture: our practice matches \"Defined\" — this is what the team told us in the self-assessment survey, nothing more."
     ],
     "follow_up_questions": [
      "Could you share the dashboard, pipeline run, or export backing your \"Software Development Mindset & Automation Culture\" answer so we can verify beyond the survey response?"
     ],
     "na_claimed": false,
     "self_claimed_level": 5,
     "evidence_class": "attested",
     "cap_applied": true
    },
    {
     "dimension_id": "15",
     "is_na": false,
     "suggested_level": 3,
     "confidence": "low",
     "rationale": "Self-report alone claims higher than \"Defined\" for Agile Planning & Backlog Management; a self-rating with no independent corroboration caps at Level 3 per the scoring stance, so verification stops at Level 3.",
     "evidence_excerpts": [
      "Agile Planning & Backlog Management: our practice matches \"Defined\" — this is what the team told us in the self-assessment survey, nothing more."
     ],
     "follow_up_questions": [
      "Could you share the dashboard, pipeline run, or export backing your \"Agile Planning & Backlog Management\" answer so we can verify beyond the survey response?"
     ],
     "na_claimed": false,
     "self_claimed_level": 5,
     "evidence_class": "attested",
     "cap_applied": true
    },
    {
     "dimension_id": "16",
     "is_na": false,
     "suggested_level": 3,
     "confidence": "low",
     "rationale": "Self-report alone claims higher than \"Defined\" for Design Standards & Technical Decision Process; a self-rating with no independent corroboration caps at Level 3 per the scoring stance, so verification stops at Level 3.",
     "evidence_excerpts": [
      "Design Standards & Technical Decision Process: our practice matches \"Defined\" — this is what the team told us in the self-assessment survey, nothing more."
     ],
     "follow_up_questions": [
      "Could you share the dashboard, pipeline run, or export backing your \"Design Standards & Technical Decision Process\" answer so we can verify beyond the survey response?"
     ],
     "na_claimed": false,
     "self_claimed_level": 5,
     "evidence_class": "attested",
     "cap_applied": true
    },
    {
     "dimension_id": "17",
     "is_na": false,
     "suggested_level": 3,
     "confidence": "low",
     "rationale": "Self-report alone claims higher than \"Defined\" for Engineering Metrics & Continuous Improvement; a self-rating with no independent corroboration caps at Level 3 per the scoring stance, so verification stops at Level 3.",
     "evidence_excerpts": [
      "Engineering Metrics & Continuous Improvement: our practice matches \"Defined\" — this is what the team told us in the self-assessment survey, nothing more."
     ],
     "follow_up_questions": [
      "Could you share the dashboard, pipeline run, or export backing your \"Engineering Metrics & Continuous Improvement\" answer so we can verify beyond the survey response?"
     ],
     "na_claimed": false,
     "self_claimed_level": 5,
     "evidence_class": "attested",
     "cap_applied": true
    }
   ]
  }
 ],
 "TEAM-003": [
  {
   "team_id": "TEAM-003",
   "envelope_id": null,
   "stamp": "20260828T093310Z",
   "source": "agent",
   "scores": [
    {
     "dimension_id": "1",
     "is_na": false,
     "suggested_level": 2,
     "confidence": "moderate",
     "rationale": "Self-rating and evidence both point to \"Developing\" for Continuous Integration (CI).",
     "evidence_excerpts": [
      "Continuous Integration (CI): our practice matches \"Developing\" — we pointed the assessor at a written runbook/standard covering this."
     ],
     "follow_up_questions": [],
     "na_claimed": false,
     "self_claimed_level": 2,
     "evidence_class": "documented",
     "cap_applied": false
    },
    {
     "dimension_id": "2",
     "is_na": false,
     "suggested_level": 2,
     "confidence": "moderate",
     "rationale": "Self-rating and evidence both point to \"Developing\" for Continuous Delivery (CD).",
     "evidence_excerpts": [
      "Continuous Delivery (CD): our practice matches \"Developing\" — we pointed the assessor at a written runbook/standard covering this."
     ],
     "follow_up_questions": [],
     "na_claimed": false,
     "self_claimed_level": 2,
     "evidence_class": "documented",
     "cap_applied": false
    },
    {
     "dimension_id": "3",
     "is_na": false,
     "suggested_level": 2,
     "confidence": "moderate",
     "rationale": "Self-rating and evidence both point to \"Developing\" for Automation.",
     "evidence_excerpts": [
      "Automation: our practice matches \"Developing\" — we pointed the assessor at a written runbook/standard covering this."
     ],
     "follow_up_questions": [],
     "na_claimed": false,
     "self_claimed_level": 2,
     "evidence_class": "documented",
     "cap_applied": false
    },
    {
     "dimension_id": "4",
     "is_na": false,
     "suggested_level": 2,
     "confidence": "moderate",
     "rationale": "Self-rating and evidence both point to \"Developing\" for Source Control & Traceability.",
     "evidence_excerpts": [
      "Source Control & Traceability: our practice matches \"Developing\" — we pointed the assessor at a written runbook/standard covering this."
     ],
     "follow_up_questions": [],
     "na_claimed": false,
     "self_claimed_level": 2,
     "evidence_class": "documented",
     "cap_applied": false
    },
    {
     "dimension_id": "5",
     "is_na": false,
     "suggested_level": 2,
     "confidence": "moderate",
     "rationale": "Self-rating and evidence both point to \"Developing\" for Testing & QE – Automated Testing.",
     "evidence_excerpts": [
      "Testing & QE – Automated Testing: our practice matches \"Developing\" — we pointed the assessor at a written runbook/standard covering this."
     ],
     "follow_up_questions": [],
     "na_claimed": false,
     "self_claimed_level": 2,
     "evidence_class": "documented",
     "cap_applied": false
    },
    {
     "dimension_id": "6",
     "is_na": false,
     "suggested_level": 2,
     "confidence": "moderate",
     "rationale": "Self-rating and evidence both point to \"Developing\" for Testing & QE – Security Testing.",
     "evidence_excerpts": [
      "Testing & QE – Security Testing: our practice matches \"Developing\" — we pointed the assessor at a written runbook/standard covering this."
     ],
     "follow_up_questions": [],
     "na_claimed": false,
     "self_claimed_level": 2,
     "evidence_class": "documented",
     "cap_applied": false
    },
    {
     "dimension_id": "7",
     "is_na": false,
     "suggested_level": 2,
     "confidence": "moderate",
     "rationale": "Self-rating and evidence both point to \"Developing\" for Testing & QE – Performance & Reliability Testing.",
     "evidence_excerpts": [
      "Testing & QE – Performance & Reliability Testing: our practice matches \"Developing\" — we pointed the assessor at a written runbook/standard covering this."
     ],
     "follow_up_questions": [],
     "na_claimed": false,
     "self_claimed_level": 2,
     "evidence_class": "documented",
     "cap_applied": false
    },
    {
     "dimension_id": "8",
     "is_na": false,
     "suggested_level": 2,
     "confidence": "moderate",
     "rationale": "Self-rating and evidence both point to \"Developing\" for Security Control SDLC & Code Review Practices.",
     "evidence_excerpts": [
      "Security Control SDLC & Code Review Practices: our practice matches \"Developing\" — we pointed the assessor at a written runbook/standard covering this."
     ],
     "follow_up_questions": [],
     "na_claimed": false,
     "self_claimed_level": 2,
     "evidence_class": "documented",
     "cap_applied": false
    }
   ]
  }
 ]
});

// ─── Feedback (HITL tasks) ──────────────────────────────────────────────────

export type FeedbackStatus = 'OPEN' | 'RESOLVED' | 'DISMISSED';

export interface FeedbackTask {
  task_id: string;
  team_id: string | null;
  kind: string;
  status: FeedbackStatus;
  dimension_id: string | null;
  question: string;
  created_at: string;
  resolved_at: string | null;
  response: string | null;
}

// Stored tasks only — the provider merges in virtual tasks synthesized from
// OPEN follow_up_questions across the scores fixture, mirroring the source's
// "stored + virtual" merge.
const seedFeedback = (): FeedbackTask[] => [
 {
  "task_id": "fb-f66662469029",
  "team_id": "TEAM-001",
  "kind": "exception_review",
  "status": "OPEN",
  "dimension_id": "7",
  "question": "Approve or deny the N/A request for dimension 7 (Performance & Reliability Testing)?",
  "created_at": daysAgo(4),
  "resolved_at": null,
  "response": null
 },
 {
  "task_id": "fb-498e9969570b",
  "team_id": "TEAM-003",
  "kind": "clarification",
  "status": "RESOLVED",
  "dimension_id": "2",
  "question": "Confirm whether checkout uses blue/green or rolling deploys for its release process.",
  "created_at": daysAgo(6),
  "resolved_at": daysAgo(2),
  "response": "Rolling deploys, confirmed via interview with Sam Okafor."
 },
 {
  "task_id": "fb-b1fb64d31abc",
  "team_id": null,
  "kind": "general",
  "status": "DISMISSED",
  "dimension_id": null,
  "question": "Should Fraud Detection ML be merged into the Data Platform cohort instead of self_service?",
  "created_at": daysAgo(5),
  "resolved_at": daysAgo(4),
  "response": null
 }
];

// ─── Knowledge tree ─────────────────────────────────────────────────────────

export type KnowledgeSectionKind = 'local' | 'synced';

export interface KnowledgeNode {
  id: string;
  title: string;
  parent_id: string | null;
  is_dir: boolean;
  classification?: string;
  editable?: boolean;
  viewable?: boolean;
  updated_at?: string;
  page_id?: string;
}

export interface KnowledgeSection {
  key: string;
  title: string;
  kind: KnowledgeSectionKind;
  provider?: string;
  nodes: KnowledgeNode[];
}

const seedKnowledgeSections = (): KnowledgeSection[] => [
 {
  "key": "enterprise_context",
  "title": "Enterprise Context",
  "kind": "local",
  "nodes": [
   {
    "id": "ec:standards",
    "title": "Standards",
    "parent_id": null,
    "is_dir": true
   },
   {
    "id": "ec:standards/ci-cd-standards.md",
    "title": "CI/CD Standards",
    "parent_id": "ec:standards",
    "is_dir": false,
    "classification": "internal",
    "editable": true,
    "viewable": true,
    "updated_at": daysAgo(20)
   },
   {
    "id": "ec:standards/security-baseline.md",
    "title": "Security Baseline",
    "parent_id": "ec:standards",
    "is_dir": false,
    "classification": "internal",
    "editable": true,
    "viewable": true,
    "updated_at": daysAgo(18)
   },
   {
    "id": "ec:process",
    "title": "Process",
    "parent_id": null,
    "is_dir": true
   },
   {
    "id": "ec:process/intake-checklist.md",
    "title": "Intake Checklist",
    "parent_id": "ec:process",
    "is_dir": false,
    "classification": "internal",
    "editable": true,
    "viewable": true,
    "updated_at": daysAgo(30)
   },
   {
    "id": "ec:process/scoring-workflow.md",
    "title": "Scoring Workflow",
    "parent_id": "ec:process",
    "is_dir": false,
    "classification": "internal",
    "editable": true,
    "viewable": true,
    "updated_at": daysAgo(12)
   },
   {
    "id": "ec:organization",
    "title": "Organization",
    "parent_id": null,
    "is_dir": true
   },
   {
    "id": "ec:organization/raci.md",
    "title": "RACI",
    "parent_id": "ec:organization",
    "is_dir": false,
    "classification": "internal",
    "editable": true,
    "viewable": true,
    "updated_at": daysAgo(3)
   },
   {
    "id": "ec:tooling",
    "title": "Tooling",
    "parent_id": null,
    "is_dir": true
   },
   {
    "id": "ec:tooling/approved-tools.md",
    "title": "Approved Tools",
    "parent_id": "ec:tooling",
    "is_dir": false,
    "classification": "internal",
    "editable": true,
    "viewable": true,
    "updated_at": daysAgo(40)
   }
  ]
 },
 {
  "key": "rules",
  "title": "Rules",
  "kind": "local",
  "nodes": [
   {
    "id": "rule:scoring-guardrails.md",
    "title": "Scoring Guardrails",
    "parent_id": null,
    "is_dir": false,
    "classification": "internal",
    "editable": true,
    "viewable": true,
    "updated_at": hoursAgo(6)
   },
   {
    "id": "rule:evidence-classification.md",
    "title": "Evidence Classification",
    "parent_id": null,
    "is_dir": false,
    "classification": "internal",
    "editable": true,
    "viewable": true,
    "updated_at": daysAgo(25)
   },
   {
    "id": "rule:na-exception-policy.md",
    "title": "N/A Exception Policy",
    "parent_id": null,
    "is_dir": false,
    "classification": "internal",
    "editable": true,
    "viewable": true,
    "updated_at": daysAgo(15)
   }
  ]
 },
 {
  "key": "prompts",
  "title": "Prompts",
  "kind": "local",
  "nodes": [
   {
    "id": "prompt:classify-transcript.md",
    "title": "Classify Transcript",
    "parent_id": null,
    "is_dir": false,
    "classification": "internal",
    "editable": true,
    "viewable": true,
    "updated_at": daysAgo(35)
   },
   {
    "id": "prompt:score-dimensions.md",
    "title": "Score Dimensions",
    "parent_id": null,
    "is_dir": false,
    "classification": "internal",
    "editable": true,
    "viewable": true,
    "updated_at": daysAgo(35)
   },
   {
    "id": "prompt:extract-enterprise-context.md",
    "title": "Extract Enterprise Context",
    "parent_id": null,
    "is_dir": false,
    "classification": "internal",
    "editable": true,
    "viewable": true,
    "updated_at": daysAgo(35)
   },
   {
    "id": "prompt:validate-outputs.md",
    "title": "Validate Outputs",
    "parent_id": null,
    "is_dir": false,
    "classification": "internal",
    "editable": true,
    "viewable": true,
    "updated_at": daysAgo(35)
   },
   {
    "id": "prompt:process-self-assessment.md",
    "title": "Process Self-Assessment",
    "parent_id": null,
    "is_dir": false,
    "classification": "internal",
    "editable": true,
    "viewable": true,
    "updated_at": daysAgo(35)
   },
   {
    "id": "prompt:develop-jira-story.md",
    "title": "Develop Jira Story",
    "parent_id": null,
    "is_dir": false,
    "classification": "internal",
    "editable": true,
    "viewable": true,
    "updated_at": daysAgo(35)
   },
   {
    "id": "prompt:draft-confluence-page.md",
    "title": "Draft Confluence Page",
    "parent_id": null,
    "is_dir": false,
    "classification": "internal",
    "editable": true,
    "viewable": true,
    "updated_at": daysAgo(35)
   },
   {
    "id": "prompt:suggest-confluence-content.md",
    "title": "Suggest Confluence Content",
    "parent_id": null,
    "is_dir": false,
    "classification": "internal",
    "editable": true,
    "viewable": true,
    "updated_at": daysAgo(35)
   },
   {
    "id": "prompt:draw-diagram.md",
    "title": "Draw Diagram",
    "parent_id": null,
    "is_dir": false,
    "classification": "internal",
    "editable": true,
    "viewable": true,
    "updated_at": daysAgo(35)
   }
  ]
 },
 {
  "key": "confluence-eng",
  "title": "Engineering Space (Confluence)",
  "kind": "synced",
  "provider": "confluence",
  "nodes": [
   {
    "id": "page:100001",
    "title": "SDLC Assessment Program",
    "parent_id": null,
    "is_dir": true,
    "editable": false,
    "viewable": true,
    "updated_at": daysAgo(9),
    "page_id": "100001"
   },
   {
    "id": "page:100002",
    "title": "Rubric Overview",
    "parent_id": "page:100001",
    "is_dir": false,
    "editable": false,
    "viewable": true,
    "updated_at": daysAgo(9),
    "page_id": "100002"
   },
   {
    "id": "page:100003",
    "title": "Team Playbooks",
    "parent_id": "page:100001",
    "is_dir": true,
    "editable": false,
    "viewable": true,
    "updated_at": daysAgo(11),
    "page_id": "100003"
   },
   {
    "id": "page:100004",
    "title": "Northstar Payments Playbook",
    "parent_id": "page:100003",
    "is_dir": false,
    "editable": false,
    "viewable": true,
    "updated_at": daysAgo(5),
    "page_id": "100004"
   },
   {
    "id": "page:100005",
    "title": "FAQ",
    "parent_id": "page:100001",
    "is_dir": false,
    "editable": false,
    "viewable": true,
    "updated_at": daysAgo(20),
    "page_id": "100005"
   }
  ]
 }
];

export interface KnowledgeDoc {
  id: string;
  title: string;
  classification: string;
  markdown: string;
  editable: boolean;
  path: string;
  updated_at: string;
}

// Mutated in place by putKnowledgeDoc/restoreKnowledgeDocVersion.
const seedKnowledgeDocs = (): Record<string, KnowledgeDoc> => ({
 "ec:standards/ci-cd-standards.md": {
  "id": "ec:standards/ci-cd-standards.md",
  "title": "CI/CD Standards",
  "classification": "internal",
  "markdown": "# CI/CD Standards\n\nAll production repositories must run CI on every push and require a passing build before merge. Pipeline definitions live in version control and follow the approved template.\n\n## Required checks\n- Build\n- Automated tests\n- Lint / static analysis\n",
  "editable": true,
  "path": "enterprise_context/standards/ci-cd-standards.md",
  "updated_at": daysAgo(20)
 },
 "ec:standards/security-baseline.md": {
  "id": "ec:standards/security-baseline.md",
  "title": "Security Baseline",
  "classification": "internal",
  "markdown": "# Security Baseline\n\nEvery repository handling customer data runs SAST and dependency scanning in CI, with findings triaged within 5 business days.\n",
  "editable": true,
  "path": "enterprise_context/standards/security-baseline.md",
  "updated_at": daysAgo(18)
 },
 "ec:process/intake-checklist.md": {
  "id": "ec:process/intake-checklist.md",
  "title": "Intake Checklist",
  "classification": "internal",
  "markdown": "# Intake Checklist\n\n1. Confirm cohort assignment.\n2. Send the self-assessment Form.\n3. Schedule the kickoff interview.\n4. Create the team workspace.\n",
  "editable": true,
  "path": "enterprise_context/process/intake-checklist.md",
  "updated_at": daysAgo(30)
 },
 "ec:process/scoring-workflow.md": {
  "id": "ec:process/scoring-workflow.md",
  "title": "Scoring Workflow",
  "classification": "internal",
  "markdown": "# Scoring Workflow\n\nclassify-transcript -> score-dimensions -> validate-outputs -> apply-scores. A prompt never persists a score directly; the deterministic apply step validates dimension ids, confidence vocabulary and the self-rating cap first.\n",
  "editable": true,
  "path": "enterprise_context/process/scoring-workflow.md",
  "updated_at": daysAgo(12)
 },
 "ec:organization/raci.md": {
  "id": "ec:organization/raci.md",
  "title": "RACI",
  "classification": "internal",
  "markdown": "# RACI\n\n| Decision | Assessor | Lead Assessor | Program Lead |\n|---|---|---|---|\n| Score a dimension | R | C | I |\n| Approve N/A exception | C | A | I |\n| Publish a report | C | A | I |\n| Change target level | I | C | A |\n",
  "editable": true,
  "path": "enterprise_context/organization/raci.md",
  "updated_at": daysAgo(3)
 },
 "ec:tooling/approved-tools.md": {
  "id": "ec:tooling/approved-tools.md",
  "title": "Approved Tools",
  "classification": "internal",
  "markdown": "# Approved Tools\n\nGitLab CI, Terraform, Ansible, Grafana, Splunk. New tooling requests go through the platform review board.\n",
  "editable": true,
  "path": "enterprise_context/tooling/approved-tools.md",
  "updated_at": daysAgo(40)
 },
 "rule:scoring-guardrails.md": {
  "id": "rule:scoring-guardrails.md",
  "title": "Scoring Guardrails",
  "classification": "internal",
  "markdown": "# Scoring Guardrails\n\n- A self-rating with no independent corroboration caps at Level 3.\n- Level 4 requires Observed evidence. Level 5 requires Observed evidence sustained over time.\n- N/A is never self-granting; exceptions require human approval.\n- Never promise a level in a recommendation, and never estimate human effort.\n",
  "editable": true,
  "path": "rules/scoring-guardrails.md",
  "updated_at": hoursAgo(6)
 },
 "rule:evidence-classification.md": {
  "id": "rule:evidence-classification.md",
  "title": "Evidence Classification",
  "classification": "internal",
  "markdown": "# Evidence Classification\n\nAttested (0.3) — the team's own account. Documented (0.5) — a written standard or runbook. Observed (0.9) — the assessor opened the artifact directly. Confidence bands: <0.40 low, 0.40-0.69 moderate, 0.70+ high.\n",
  "editable": true,
  "path": "rules/evidence-classification.md",
  "updated_at": daysAgo(25)
 },
 "rule:na-exception-policy.md": {
  "id": "rule:na-exception-policy.md",
  "title": "N/A Exception Policy",
  "classification": "internal",
  "markdown": "# N/A Exception Policy\n\nA claimed N/A is never self-granting. Archetype and known-exception rows are pre-approved and synthesized on read; submission or manual requests need a lead-assessor Approve/Deny.\n",
  "editable": true,
  "path": "rules/na-exception-policy.md",
  "updated_at": daysAgo(15)
 },
 "prompt:classify-transcript.md": {
  "id": "prompt:classify-transcript.md",
  "title": "Classify Transcript",
  "classification": "internal",
  "markdown": "# /classify-transcript\n\nSlash-command prompt. Read-only tool floor, writes only to the team's temp/, no web fetch, no subagents. Never persists a score directly — output is validated by the deterministic apply step.\n",
  "editable": true,
  "path": "prompts/classify-transcript.md",
  "updated_at": daysAgo(35)
 },
 "prompt:score-dimensions.md": {
  "id": "prompt:score-dimensions.md",
  "title": "Score Dimensions",
  "classification": "internal",
  "markdown": "# /score-dimensions\n\nSlash-command prompt. Read-only tool floor, writes only to the team's temp/, no web fetch, no subagents. Never persists a score directly — output is validated by the deterministic apply step.\n",
  "editable": true,
  "path": "prompts/score-dimensions.md",
  "updated_at": daysAgo(35)
 },
 "prompt:extract-enterprise-context.md": {
  "id": "prompt:extract-enterprise-context.md",
  "title": "Extract Enterprise Context",
  "classification": "internal",
  "markdown": "# /extract-enterprise-context\n\nSlash-command prompt. Read-only tool floor, writes only to the team's temp/, no web fetch, no subagents. Never persists a score directly — output is validated by the deterministic apply step.\n",
  "editable": true,
  "path": "prompts/extract-enterprise-context.md",
  "updated_at": daysAgo(35)
 },
 "prompt:validate-outputs.md": {
  "id": "prompt:validate-outputs.md",
  "title": "Validate Outputs",
  "classification": "internal",
  "markdown": "# /validate-outputs\n\nSlash-command prompt. Read-only tool floor, writes only to the team's temp/, no web fetch, no subagents. Never persists a score directly — output is validated by the deterministic apply step.\n",
  "editable": true,
  "path": "prompts/validate-outputs.md",
  "updated_at": daysAgo(35)
 },
 "prompt:process-self-assessment.md": {
  "id": "prompt:process-self-assessment.md",
  "title": "Process Self-Assessment",
  "classification": "internal",
  "markdown": "# /process-self-assessment\n\nSlash-command prompt. Read-only tool floor, writes only to the team's temp/, no web fetch, no subagents. Never persists a score directly — output is validated by the deterministic apply step.\n",
  "editable": true,
  "path": "prompts/process-self-assessment.md",
  "updated_at": daysAgo(35)
 },
 "prompt:develop-jira-story.md": {
  "id": "prompt:develop-jira-story.md",
  "title": "Develop Jira Story",
  "classification": "internal",
  "markdown": "# /develop-jira-story\n\nSlash-command prompt. Read-only tool floor, writes only to the team's temp/, no web fetch, no subagents. Never persists a score directly — output is validated by the deterministic apply step.\n",
  "editable": true,
  "path": "prompts/develop-jira-story.md",
  "updated_at": daysAgo(35)
 },
 "prompt:draft-confluence-page.md": {
  "id": "prompt:draft-confluence-page.md",
  "title": "Draft Confluence Page",
  "classification": "internal",
  "markdown": "# /draft-confluence-page\n\nSlash-command prompt. Read-only tool floor, writes only to the team's temp/, no web fetch, no subagents. Never persists a score directly — output is validated by the deterministic apply step.\n",
  "editable": true,
  "path": "prompts/draft-confluence-page.md",
  "updated_at": daysAgo(35)
 },
 "prompt:suggest-confluence-content.md": {
  "id": "prompt:suggest-confluence-content.md",
  "title": "Suggest Confluence Content",
  "classification": "internal",
  "markdown": "# /suggest-confluence-content\n\nSlash-command prompt. Read-only tool floor, writes only to the team's temp/, no web fetch, no subagents. Never persists a score directly — output is validated by the deterministic apply step.\n",
  "editable": true,
  "path": "prompts/suggest-confluence-content.md",
  "updated_at": daysAgo(35)
 },
 "prompt:draw-diagram.md": {
  "id": "prompt:draw-diagram.md",
  "title": "Draw Diagram",
  "classification": "internal",
  "markdown": "# /draw-diagram\n\nSlash-command prompt. Read-only tool floor, writes only to the team's temp/, no web fetch, no subagents. Never persists a score directly — output is validated by the deterministic apply step.\n",
  "editable": true,
  "path": "prompts/draw-diagram.md",
  "updated_at": daysAgo(35)
 }
});

/** The wire shape of a saved snapshot. `size` is on it because the portal's
 * version list renders it ("210 B" / "1.4 KB", DocPane.tsx), and because the
 * Aurora path has a real `size` column. */
export interface KnowledgeDocVersion {
  stamp: string;
  label: string | null;
  size: number;
  saved_at: string;
  markdown: string;
}

/**
 * What the mock actually stores: the same row WITHOUT `size`. A stored size
 * is a count of bytes the same row already carries, and the seeded rule-doc
 * snapshots said 210 B and 340 B over 61 and 130 bytes of markdown — the
 * version list rendered those numbers verbatim. `docVersionOut` is the only
 * place the number exists now, and it cannot be wrong.
 */
export type StoredDocVersion = Omit<KnowledgeDocVersion, 'size'>;

export function docVersionOut(v: StoredDocVersion): KnowledgeDocVersion {
  return { ...v, size: v.markdown.length };
}

// doc id -> saved snapshots, OLDEST FIRST as generated (the provider reverses
// for the "newest first" wire contract). A snapshot is taken on every save
// prior to the new content landing, so putKnowledgeDoc pushes here too.
// doc id -> saved revisions, oldest first.
//
// Version history used to exist for exactly ONE document, and the one it
// existed for was not the first the tree hands back. Two things fell out of
// that: the Versions rail read "no history" on the document a reader opens
// first, and the wire capture could not replay
// POST /api/assessment/knowledge/doc/restore at all — it resolves :id from
// the tree, got `ec:standards/ci-cd-standards.md`, found no stamp to restore
// and recorded the write as uncaptured ("no seeded version stamp for
// ec:standards/ci-cd-standards.md"). A ManageKnowledge-gated write whose
// response shape nothing pins is exactly the gap the sweep exists to close,
// so the first local document now carries history too. Each revision is a
// genuine earlier state of the doc it belongs to — a diff a reader could
// have made — never filler.
const seedKnowledgeVersions = (): Record<string, StoredDocVersion[]> => ({
 "ec:standards/ci-cd-standards.md": [
  {
   "stamp": "20260729T104500Z",
   "label": "initial",
   "saved_at": daysAgo(40),
   "markdown": "# CI/CD Standards\n\nAll production repositories must run CI on every push.\n"
  },
  {
   "stamp": "20260812T161500Z",
   "label": "require a passing build before merge",
   "saved_at": daysAgo(26),
   "markdown": "# CI/CD Standards\n\nAll production repositories must run CI on every push and require a passing build before merge. Pipeline definitions live in version control and follow the approved template.\n"
  }
 ],
 "rule:scoring-guardrails.md": [
  {
   "stamp": "20260801T090000Z",
   "label": "initial",
   "saved_at": daysAgo(34),
   "markdown": "# Scoring Guardrails\n\n- A self-rating alone caps at Level 3.\n"
  },
  {
   "stamp": "20260815T130000Z",
   "label": null,
   "saved_at": daysAgo(20),
   "markdown": "# Scoring Guardrails\n\n- A self-rating with no independent corroboration caps at Level 3.\n- Level 4 requires Observed evidence.\n"
  }
 ]
});

// ─── Configuration ──────────────────────────────────────────────────────────

export interface MotionConfig {
  cohort: Cohort;
  title: string;
  tag: string;
  accent: string;
  description: string;
}

const seedMotions = (): MotionConfig[] => [
 {
  "cohort": "white_glove",
  "title": "White Glove",
  "tag": "HIGH-TOUCH",
  "accent": "#141C7C",
  "description": "Dedicated, hands-on assessment engagements with a named lead."
 },
 {
  "cohort": "self_service",
  "title": "Self-Service",
  "tag": "GUIDED",
  "accent": "#2E5BFF",
  "description": "Guided self-assessment with light-touch review checkpoints."
 },
 {
  "cohort": "general",
  "title": "General",
  "tag": "STANDARD",
  "accent": "#5B6472",
  "description": "Standard-cadence assessment for teams outside a named motion."
 }
];

export interface AssessmentConfiguration {
  target_level: number;
  motions: MotionConfig[];
  updated_at: string;
}

// Mutable — PUT /configuration replaces this wholesale under mock.
const seedConfiguration = (): AssessmentConfiguration => ({
  target_level: 3,
  // NOT a second copy of the motion list. It was one — the same three objects
  // typed out twice — so an edit to the motions fixture silently disagreed with the
  // motions /configuration actually serves. PUT /configuration replaces this
  // array wholesale, so the seed hands over its own copy of the rows.
  motions: seedMotions(),
  updated_at: daysAgo(14),
});

// ─── Stories (drafted from a recommendation) ───────────────────────────────

export type StoryStatus = 'pushed' | 'blocked' | 'ready';

export interface StoryDraft {
  filename: string;
  team_id: string;
  dimension_id: string;
  title: string;
  markdown: string;
  status: StoryStatus;
  jira_key: string | null;
  created_at: string;
}

const seedStories = (): Record<string, StoryDraft[]> => ({
  'TEAM-001': [
    {
      filename: 'story-dim1-ci-evidence.md',
      team_id: 'TEAM-001',
      dimension_id: '1',
      title: 'Close the open CI claim: verify branch-protection + pipeline history',
      markdown: '## Close the claim\n\nDimension: Continuous Integration (CI)\n\nAsk the team for branch-protection '
        + 'settings and recent pipeline run history across both repositories, or verified evidence stays at Level 2 '
        + 'against a Level 5 self-rating.\n\nLabels: maturity-dim-1\n',
      status: 'ready',
      jira_key: null,
      created_at: daysAgo(2),
    },
  ],
  'TEAM-002': [],
});

// ─── Fixtures ───────────────────────────────────────────────────────────────
//
// Everything above is a rows FACTORY. Everything below registers one with the
// mock floor (src/mock/core), which is what makes
// `POST /api/__mock/scenario {"scenario":"empty","fixture":"assessment-teams"}`
// possible without an auditor mutating shared state and warning the next one.
//
// Two rules shape the accessors:
//
//   * A read never creates a bucket. `provenanceFor` on an unknown team hands
//     back a fresh empty array; the `ensure*` twin is what a writer calls. A
//     getter that lazily created rows would make "how many teams have evidence"
//     depend on who looked.
//   * A record-of-records seed (team -> dimension -> score) becomes one row PER
//     TEAM, not one row holding the whole map — so `/api/__mock/state` reports
//     "7" and not "1", and so `empty` is a thing you can see.

/** A team's dimension scores. One fixture row per team. */
export interface TeamScores {
  team_id: string;
  dimensions: Record<string, MockDimensionScore>;
}

/** A team's provenance ledger. One fixture row per team. */
export interface TeamProvenance {
  team_id: string;
  records: Provenance[];
}

/** A team's un-scored intake items. One fixture row per team. */
export interface TeamEvidenceLog {
  team_id: string;
  items: EvidenceLogItem[];
}

/** A knowledge doc's saved snapshots, oldest first. One row per doc. */
export interface DocVersions {
  doc_id: string;
  versions: StoredDocVersion[];
}

const byTeam = <T, R>(
  seed: Record<string, T>,
  build: (team_id: string, value: T) => R,
): R[] => Object.entries(seed).map(([team_id, value]) => build(team_id, value));

// ─── Teams ──────────────────────────────────────────────────────────────────

export const archetypesFixture = defineFixture<ArchetypeOption>({
  key: 'assessment-archetypes',
  scenarios: {
    default: seedArchetypes,
    // No registry configured: every N/A claim has to go the manual route,
    // which is a real deployment and a real thing to audit.
    empty: () => [],
  },
});

export const teamsFixture = defineFixture<MockTeam>({
  key: 'assessment-teams',
  scenarios: {
    default: seedTeams,
    empty: () => [],
    // The roster table itself is unreachable — everything keyed off a team
    // (recommendations, rollup, feedback's virtual tasks) fails the same way,
    // because in the real provider they all resolve a team through this table.
    error: () => {
      throw new Error('assessment_teams unavailable: relation does not exist');
    },
    // A brand-new tenant: the cast exists, nothing has been assessed. Pair
    // with `assessment-scores`'s own `fresh`, which is empty.
    fresh: () => seedTeams().map((t) => ({
      ...t, workflow_step: 1, exceptions: [], contributors: [], updated_at: t.created_at,
    })),
    // Enough teams that the list has to paginate/virtualize. Cloned from the
    // seed cast so cohorts, leads and repos stay plausible.
    large: () => {
      const base = seedTeams();
      const out: MockTeam[] = [];
      for (let i = 0; i < 24; i += 1) {
        for (const t of base) {
          const n = out.length + 1;
          out.push({ ...t, id: `TEAM-${String(n).padStart(3, '0')}`, name: i === 0 ? t.name : `${t.name} ${i + 1}` });
        }
      }
      return out;
    },
  },
});

export const teams = (): MockTeam[] => teamsFixture.rows();
export const findTeam = (teamId: string): MockTeam | undefined =>
  teamsFixture.rows().find((t) => t.id === teamId);

// ─── Dimension scores ───────────────────────────────────────────────────────

const emptyDimensionScore = (dimensionId: string): MockDimensionScore => ({
  dimension_id: dimensionId, current_level: null, is_na: false, confidence: 'low',
  self_claimed_level: null, evidence_class: null, cap_applied: false,
  evidence: [], follow_up_questions: [], history: [], updated_at: clock.nowIso(),
});

/** A full, un-scored 17-dimension sheet — what a team gets at intake. */
export const blankDimensions = (): Record<string, MockDimensionScore> =>
  Object.fromEntries(DIMENSION_IDS.map((d) => [d, emptyDimensionScore(d)]));

export const scoresFixture = defineFixture<TeamScores>({
  key: 'assessment-scores',
  scenarios: {
    default: () => byTeam(seedAssessments(), (team_id, dimensions) => ({ team_id, dimensions })),
    empty: () => [],
    // Dimension scores unreachable — recommendations and rollup both walk
    // every team's sheet to build their answer, so pinning this alone fails
    // them without touching the roster or submissions.
    error: () => {
      throw new Error('assessment_dimension_scores unavailable: relation does not exist');
    },
    // The cast is there, nobody has been scored: every team reads NEW, every
    // certification reads "Not yet assessed".
    fresh: () => seedTeams().map((t) => ({ team_id: t.id, dimensions: blankDimensions() })),
    large: () => teamsFixture.rows('large').map((t) => ({ team_id: t.id, dimensions: blankDimensions() })),
  },
});

export const allScores = (): TeamScores[] => scoresFixture.rows();

/** A team's live dimension map, or `undefined` when the team has no sheet. */
export const scoresFor = (teamId: string): Record<string, MockDimensionScore> | undefined =>
  scoresFixture.rows().find((r) => r.team_id === teamId)?.dimensions;

export const setScoresFor = (teamId: string, dimensions: Record<string, MockDimensionScore>): void => {
  const rows = scoresFixture.rows();
  const existing = rows.find((r) => r.team_id === teamId);
  if (existing) existing.dimensions = dimensions;
  else rows.push({ team_id: teamId, dimensions });
};

/**
 * A team's workflow status — the derived one, always. Never read a stored
 * `status`: that is the field that let a team say "New" beside "17/17".
 */
export const teamStatus = (teamId: string): TeamStatus => deriveTeamStatus(scoresFor(teamId) ?? {});

// ─── Provenance / evidence intake ───────────────────────────────────────────

export const provenanceFixture = defineFixture<TeamProvenance>({
  key: 'assessment-provenance',
  scenarios: {
    default: () => byTeam(seedProvenance(), (team_id, records) => ({ team_id, records })),
    empty: () => [],
  },
});

export const provenanceFor = (teamId: string): Provenance[] =>
  provenanceFixture.rows().find((r) => r.team_id === teamId)?.records ?? [];

export const ensureProvenanceFor = (teamId: string): Provenance[] => {
  const rows = provenanceFixture.rows();
  const existing = rows.find((r) => r.team_id === teamId);
  if (existing) return existing.records;
  const created: TeamProvenance = { team_id: teamId, records: [] };
  rows.push(created);
  return created.records;
};

export const evidenceLogFixture = defineFixture<TeamEvidenceLog>({
  key: 'assessment-evidence-log',
  scenarios: {
    default: () => byTeam(seedEvidenceLog(), (team_id, items) => ({ team_id, items })),
    empty: () => [],
  },
});

export const evidenceLogFor = (teamId: string): EvidenceLogItem[] =>
  evidenceLogFixture.rows().find((r) => r.team_id === teamId)?.items ?? [];

export const ensureEvidenceLogFor = (teamId: string): EvidenceLogItem[] => {
  const rows = evidenceLogFixture.rows();
  const existing = rows.find((r) => r.team_id === teamId);
  if (existing) return existing.items;
  const created: TeamEvidenceLog = { team_id: teamId, items: [] };
  rows.push(created);
  return created.items;
};

// ─── Submissions ────────────────────────────────────────────────────────────
//
// Flat: an envelope already carries `team_id` and `envelope_id`, so a
// nested map bought nothing but a second place for a team id to be wrong.

export const submissionsFixture = defineFixture<SubmissionEnvelope>({
  key: 'assessment-submissions',
  scenarios: {
    default: () => Object.values(seedSubmissions()).flatMap((byEnvelope) => Object.values(byEnvelope)),
    empty: () => [],
    error: () => {
      throw new Error('assessment_submissions unavailable: relation does not exist');
    },
  },
});

export const submissions = (): SubmissionEnvelope[] => submissionsFixture.rows();

export const submissionsFor = (teamId: string): SubmissionEnvelope[] =>
  submissionsFixture.rows().filter((e) => e.team_id === teamId);

export const findSubmission = (teamId: string, envelopeId: string): SubmissionEnvelope | undefined =>
  submissionsFixture.rows().find((e) => e.team_id === teamId && e.envelope_id === envelopeId);

export const upsertSubmission = (env: SubmissionEnvelope): SubmissionEnvelope => {
  const rows = submissionsFixture.rows();
  const idx = rows.findIndex((e) => e.team_id === env.team_id && e.envelope_id === env.envelope_id);
  if (idx >= 0) rows[idx] = env;
  else rows.push(env);
  return env;
};

export const removeSubmission = (teamId: string, envelopeId: string): boolean => {
  const rows = submissionsFixture.rows();
  const idx = rows.findIndex((e) => e.team_id === teamId && e.envelope_id === envelopeId);
  if (idx < 0) return false;
  rows.splice(idx, 1);
  return true;
};

// ─── Runs ───────────────────────────────────────────────────────────────────

export const runsFixture = defineFixture<MockRun>({
  key: 'assessment-runs',
  scenarios: {
    default: () => withRunDurations(seedRuns()),
    empty: () => [],
    // The ledger's own error story: every terminal run failed. Not a thrown
    // provider — a fleet that is up and losing, which reads differently.
    error: () => withRunDurations(seedRuns()).map((r) => (
      r.status === 'completed'
        ? { ...r, status: 'failed' as RunStatus, error: 'agent invocation failed: model timeout', summary: '' }
        : r
    )),
    large: () => {
      const base = withRunDurations(seedRuns());
      const out: MockRun[] = [];
      for (let i = 0; i < 20; i += 1) {
        for (const r of base) out.push({ ...r, id: `${r.id}-${i}`, started_at: clock.daysAgo(i) });
      }
      return out;
    },
  },
});

export const runs = (): MockRun[] => runsFixture.rows();

/** Runs per status, counted — never a stored tally beside the ledger. */
export const runCountsByStatus = (): Map<RunStatus, number> => countBy(runsFixture.rows(), 'status');

// ─── Scoring logs ───────────────────────────────────────────────────────────

export const scoringLogsFixture = defineFixture<ScoringLog>({
  key: 'assessment-scoring-logs',
  scenarios: {
    default: () => Object.values(seedScoringLogs()).flat(),
    empty: () => [],
  },
});

/** A team's reasoning logs, newest first. */
export const scoringLogsFor = (teamId: string): ScoringLog[] =>
  scoringLogsFixture.rows().filter((l) => l.team_id === teamId);

export const addScoringLog = (log: ScoringLog): void => {
  scoringLogsFixture.rows().unshift(log);
};

// ─── Feedback ───────────────────────────────────────────────────────────────

export const feedbackFixture = defineFixture<FeedbackTask>({
  key: 'assessment-feedback',
  scenarios: {
    default: seedFeedback,
    // Stored tasks only. The queue is never truly empty in `default` because
    // the provider also synthesizes virtual tasks from OPEN follow-ups —
    // pin `assessment-scores` to `empty` too for a genuinely empty queue.
    empty: () => [],
    error: () => {
      throw new Error('assessment_feedback_tasks unavailable: relation does not exist');
    },
  },
});

export const feedback = (): FeedbackTask[] => feedbackFixture.rows();

// ─── Knowledge ──────────────────────────────────────────────────────────────

export const knowledgeSectionsFixture = defineFixture<KnowledgeSection>({
  key: 'assessment-knowledge-sections',
  scenarios: {
    default: seedKnowledgeSections,
    empty: () => [],
    // The synced provider is unreachable. The tree route has to say so
    // rather than render a rail that reads "Nothing here yet".
    error: () => {
      throw new Error('knowledge sync provider unavailable (confluence-eng)');
    },
  },
});

export const knowledgeSections = (): KnowledgeSection[] => knowledgeSectionsFixture.rows();

export const knowledgeDocsFixture = defineFixture<KnowledgeDoc>({
  key: 'assessment-knowledge-docs',
  scenarios: {
    default: () => Object.values(seedKnowledgeDocs()),
    empty: () => [],
  },
});

export const knowledgeDocs = (): KnowledgeDoc[] => knowledgeDocsFixture.rows();
export const findKnowledgeDoc = (id: string): KnowledgeDoc | undefined =>
  knowledgeDocsFixture.rows().find((d) => d.id === id);

export const knowledgeVersionsFixture = defineFixture<DocVersions>({
  key: 'assessment-knowledge-versions',
  scenarios: {
    default: () => Object.entries(seedKnowledgeVersions()).map(([doc_id, versions]) => ({ doc_id, versions })),
    empty: () => [],
  },
});

export const versionsFor = (docId: string): StoredDocVersion[] =>
  knowledgeVersionsFixture.rows().find((r) => r.doc_id === docId)?.versions ?? [];

export const ensureVersionsFor = (docId: string): StoredDocVersion[] => {
  const rows = knowledgeVersionsFixture.rows();
  const existing = rows.find((r) => r.doc_id === docId);
  if (existing) return existing.versions;
  const created: DocVersions = { doc_id: docId, versions: [] };
  rows.push(created);
  return created.versions;
};

// ─── Configuration ──────────────────────────────────────────────────────────

export const motionsFixture = defineFixture<MotionConfig>({
  key: 'assessment-motions',
  scenarios: { default: seedMotions, empty: () => [] },
});

export const motions = (): MotionConfig[] => motionsFixture.rows();

export const archetypes = (): ArchetypeOption[] => archetypesFixture.rows();

/**
 * One row, because there is one configuration. `empty` keeps the row and
 * empties the motions: a tenant with nothing configured still has a target
 * level, and the Configuration page's real empty state is "no motions".
 */
export const configurationFixture = defineFixture<AssessmentConfiguration>({
  key: 'assessment-configuration',
  scenarios: {
    default: () => [seedConfiguration()],
    empty: () => [{ target_level: 3, motions: [], updated_at: clock.nowIso() }],
    error: () => {
      throw new Error('assessment_configuration unavailable: relation does not exist');
    },
  },
});

export const configuration = (): AssessmentConfiguration => configurationFixture.rows()[0]!;

// ─── Stories ────────────────────────────────────────────────────────────────

export const storiesFixture = defineFixture<StoryDraft>({
  key: 'assessment-stories',
  scenarios: {
    default: () => Object.values(seedStories()).flat(),
    empty: () => [],
  },
});

export const storiesFor = (teamId: string): StoryDraft[] =>
  storiesFixture.rows().filter((s) => s.team_id === teamId);

export const addStory = (story: StoryDraft): void => {
  storiesFixture.rows().push(story);
};

// ─── Cross-fixture helpers ──────────────────────────────────────────────────

/**
 * Everything a team owns, dropped in one call. Spread across six `delete`
 * statements in the provider it was one edit away from leaking a team's
 * scoring logs into the next TEAM-00N that reused the id.
 */
export const dropTeam = (teamId: string): boolean => {
  const rows = teamsFixture.rows();
  const idx = rows.findIndex((t) => t.id === teamId);
  if (idx === -1) return false;
  rows.splice(idx, 1);
  const drop = <T>(list: T[], match: (row: T) => boolean): void => {
    for (let i = list.length - 1; i >= 0; i -= 1) if (match(list[i]!)) list.splice(i, 1);
  };
  drop(scoresFixture.rows(), (r) => r.team_id === teamId);
  drop(provenanceFixture.rows(), (r) => r.team_id === teamId);
  drop(evidenceLogFixture.rows(), (r) => r.team_id === teamId);
  drop(submissionsFixture.rows(), (r) => r.team_id === teamId);
  drop(scoringLogsFixture.rows(), (r) => r.team_id === teamId);
  drop(storiesFixture.rows(), (r) => r.team_id === teamId);
  return true;
};

/** The next free TEAM-0NN, counted from the live roster. */
export const nextTeamId = (): string => {
  const maxNum = Math.max(0, ...teamsFixture.rows().map((t) => parseInt(t.id.replace('TEAM-', ''), 10) || 0));
  return `TEAM-${String(maxNum + 1).padStart(3, '0')}`;
};
