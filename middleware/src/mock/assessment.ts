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
// dimension 1 (claimed Optimizing, verified Developing), one approved N/A
// (dimension 6) and one requested N/A (dimension 7). TEAM-002 shows the
// self-rating cap at work: where the only evidence is the team's own account
// (evidence_class "attested") a higher claim is held at Defined. The scores,
// evidence, submissions and scoring logs are authored in assessment-content.ts.
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
import {
  at, buildEvidenceLog, ENVELOPE, buildScores, buildScoringLogs, buildSubmissions, HB, RUN_ID, runId, runStamp, stampOf,
  type ContentContext,
} from './assessment-content.js';

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
     "Implement at least one CI pipeline capable of building source code or validating deployable artifacts.",
     "Store CI pipeline definitions in version control.",
     "Demonstrate that the pipeline has executed successfully within the assessment period.",
     "Establish ownership for CI pipeline maintenance.",
     "Use the pipeline for at least a subset of application changes."
    ],
    "evidence_examples": [
     "GitLab CI YAML",
     "GitHub Actions workflow",
     "Jenkinsfile",
     "Azure DevOps pipeline",
     "Build execution history",
     "Repository containing pipeline definitions ---"
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
     "Configure CI to automatically trigger on commit, push, merge request, pull request, or equivalent source control event.",
     "Ensure the majority of active development work executes through CI rather than manual builds.",
     "Publish build and test results to developers.",
     "Implement automated validation beyond simple compilation, such as unit tests, linting, static analysis, or equivalent checks.",
     "Demonstrate CI usage across at least one production-supported repository."
    ],
    "evidence_examples": [
     "Auto-trigger configuration",
     "Automated pipeline execution history",
     "Build notifications",
     "Status checks",
     "Repository settings showing CI integration",
     "Pull request or merge request history showing CI results ---"
    ]
   },
   {
    "level": 2,
    "name": "Developing",
    "description": "CI triggers automatically on push/PR for at least some of the team's repositories.",
    "key_characteristics": [
     "CI triggers automatically on push/PR for at least some repositories.",
     "Failing pipelines do not block merges.",
     "Build and test results are visible to the team.",
     "CI coverage across repositories remains inconsistent."
    ],
    "level_up_criteria": [
     "Require successful CI execution before code changes are merged.",
     "Implement branch protection or equivalent controls that prevent direct merges bypassing CI.",
     "Standardize CI implementation across all qualifying repositories owned by the team.",
     "Maintain CI pipeline definitions using approved organizational templates or standards.",
     "Require automated testing within the CI workflow.",
     "Document CI expectations and team operating procedures."
    ],
    "evidence_examples": [
     "Protected branch settings",
     "Mandatory status checks",
     "Standard pipeline templates",
     "Team engineering standards",
     "CI/CD operating procedures",
     "Repository settings enforcing merge controls ---"
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
     "Measure build success rate, pipeline duration, failure rate, and pipeline reliability.",
     "Track recurring CI failures or flaky pipeline behavior.",
     "Demonstrate remediation activities for failing or unreliable CI runs.",
     "Review CI performance data on a recurring cadence.",
     "Establish targets or thresholds for CI effectiveness.",
     "Use CI metrics to drive engineering improvements."
    ],
    "evidence_examples": [
     "CI dashboards",
     "Pipeline health reports",
     "Build success trends",
     "Build failure trends",
     "Flaky test or flaky pipeline tracking",
     "Improvement backlog items",
     "Engineering reviews referencing CI performance ---"
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
     "Demonstrate automated optimization of pipeline execution efficiency.",
     "Leverage CI telemetry to improve broader software delivery outcomes.",
     "Continuously evaluate and reduce feedback cycle times.",
     "Demonstrate that CI improvements are proactively identified rather than reactively addressed.",
     "Use CI performance data to inform broader engineering effectiveness or delivery reporting."
    ],
    "evidence_examples": [
     "Dynamic test selection",
     "Intelligent caching",
     "Parallelized execution",
     "Automated pipeline optimization",
     "DORA metric integration",
     "Organization-level CI reporting",
     "Proactive CI improvement initiatives ---"
    ]
   },
   {
    "level": 5,
    "name": "Optimizing",
    "description": "CI is a fully enforced, self-improving gate with no bypass path.",
    "key_characteristics": [
     "Merging without a passing CI run is architecturally impossible.",
     "CI pipelines self-optimize through capabilities such as test selection, parallelization, or caching.",
     "CI telemetry contributes to broader delivery and engineering performance reporting.",
     "Quality validation remains fast while preserving confidence and coverage."
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
     "None. Releases are managed through manual effort without established standards, controls, or repeatable deployment processes."
    ],
    "level_up_criteria": [
     "Document a repeatable release process, deployment checklist, runbook, or release procedure.",
     "Define deployment responsibilities and required release participants.",
     "Establish a documented promotion path between environments.",
     "Define a basic rollback approach.",
     "Demonstrate that releases are performed using the documented process rather than tribal knowledge."
    ],
    "evidence_examples": [
     "Release runbook",
     "Deployment checklist",
     "Change management documentation",
     "Release readiness checklist",
     "Team operational procedures ---"
    ]
   },
   {
    "level": 1,
    "name": "Initial",
    "description": "Release plans and practices are documented, even though execution is manual and packaging or promotion still require hands-on coordination for each release.",
    "key_characteristics": [
     "A documented release plan, runbook, or checklist exists and is followed for each deployment.",
     "Packaging is assembled manually but follows a known, documented process.",
     "Promotion steps are documented, though movement between environments still requires manual coordination.",
     "Release planning is maintained as a formal artifact rather than relying solely on communication or tribal knowledge.",
     "Rollback and approval rigor remain immature or inconsistent."
    ],
    "level_up_criteria": [
     "Standardize portions of packaging or deployment activities.",
     "Define release approval requirements and readiness criteria.",
     "Maintain versioned release artifacts.",
     "Document rollback conditions, triggers, and responsibilities.",
     "Demonstrate that releases follow a repeatable process.",
     "Use automation for selected deployment or packaging activities."
    ],
    "evidence_examples": [
     "Standard release package structure",
     "Approval workflow records",
     "Artifact repository",
     "Deployment scripts",
     "Rollback documentation",
     "Change records ---"
    ]
   },
   {
    "level": 2,
    "name": "Developing",
    "description": "A basic release process exists, but practices vary by change type or environment.",
    "key_characteristics": [
     "Packaging is partially standardized, but formats and metadata may vary.",
     "Approval processes exist, though criteria and evidence requirements are inconsistent.",
     "Rollback procedures are documented but not routinely validated.",
     "Release practices differ between environments or deployment types.",
     "Automation exists but is not consistently applied."
    ],
    "level_up_criteria": [
     "Use automated deployment pipelines for qualifying releases.",
     "Standardize packaging, versioning, and release artifact requirements.",
     "Enforce approval gates through tooling or workflow controls.",
     "Require release evidence before promotion.",
     "Define rollback procedures before production deployment.",
     "Ensure deployment paths are consistent across environments."
    ],
    "evidence_examples": [
     "GitLab, GitHub, Azure DevOps, or equivalent deployment pipelines",
     "Release promotion workflows",
     "Signed release artifacts",
     "Automated approval gates",
     "Standard release templates",
     "Release readiness documentation ---"
    ]
   },
   {
    "level": 3,
    "name": "Defined",
    "description": "Packaging, approval, promotion, and rollback are standardized and pipeline-driven.",
    "key_characteristics": [
     "Packaging is standardized, including versioning structure and release metadata.",
     "Release artifacts, release notes, test evidence, and supporting documentation are consistently maintained.",
     "Deployment occurs through automated pipelines and predictable promotion paths.",
     "Approval gates are enforced and tied to documented readiness criteria.",
     "Rollback plans are defined prior to deployment and integrated into release preparation."
    ],
    "level_up_criteria": [
     "Track deployment performance metrics.",
     "Measure deployment success rate, change failure rate, rollback frequency, and deployment throughput.",
     "Validate rollback procedures through testing.",
     "Implement automated deployment verification checks.",
     "Use release metrics to identify and address bottlenecks.",
     "Review release performance on a recurring cadence."
    ],
    "evidence_examples": [
     "Deployment dashboards",
     "Release scorecards",
     "Rollback testing results",
     "Deployment verification reports",
     "Change failure tracking",
     "Engineering governance reviews ---"
    ]
   },
   {
    "level": 4,
    "name": "Measured",
    "description": "Release performance is measured and rollback readiness is validated, not just documented.",
    "key_characteristics": [
     "Release metrics are actively tracked and reviewed.",
     "Rollback readiness is validated through testing rather than assumed.",
     "Deployment success and change-failure trends are measured over time.",
     "Safe deployment approaches such as canary, phased rollout, or blue/green strategies are used.",
     "Release data informs engineering and release process improvements."
    ],
    "level_up_criteria": [
     "Implement policy-driven release orchestration.",
     "Dynamically adjust approvals based on risk, evidence, or change type.",
     "Demonstrate automated rollback capabilities.",
     "Support progressive delivery strategies where applicable.",
     "Continuously optimize deployment safety, speed, and reliability.",
     "Demonstrate proactive release process improvements."
    ],
    "evidence_examples": [
     "Automated rollback execution",
     "Risk-based approvals",
     "Feature flag management",
     "Progressive delivery capabilities",
     "DORA-aligned deployment reporting",
     "Deployment optimization initiatives ---"
    ]
   },
   {
    "level": 5,
    "name": "Optimizing",
    "description": "Release orchestration is policy-driven, resilient, and self-improving.",
    "key_characteristics": [
     "Approvals are policy-based and adapt to risk and evidence.",
     "Rollback is automated and can be executed rapidly with minimal manual effort.",
     "Progressive delivery techniques are used where appropriate.",
     "The delivery process continually improves through operational feedback and measurable outcomes.",
     "Qualifying deployments cannot routinely bypass approved deployment workflows."
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
     "Implement at least one repeatable automation capability for infrastructure, configuration, or operational tasks.",
     "Use automation tooling for at least a subset of work.",
     "Maintain automation artifacts in a reusable form rather than one-time execution.",
     "Establish ownership for automation assets.",
     "Demonstrate automation has been successfully executed within the assessment period."
    ],
    "evidence_examples": [
     "Terraform configurations",
     "PowerShell scripts",
     "Bash scripts",
     "Ansible playbooks",
     "Infrastructure deployment templates",
     "Scheduled automation jobs ---"
    ]
   },
   {
    "level": 1,
    "name": "Initial",
    "description": "Automation tooling exists, but most work is still manual.",
    "key_characteristics": [
     "Some Infrastructure-as-Code (IaC) exists, but most changes are applied manually with elevated access.",
     "Secrets and credentials are often stored in scripts or configuration files.",
     "Centralized secrets management is not consistently used.",
     "Deployment and change processes rely on tribal knowledge or individual expertise.",
     "Manual execution remains the default operating model."
    ],
    "level_up_criteria": [
     "Automate selected repeatable infrastructure or configuration activities.",
     "Store automation artifacts in version control.",
     "Reduce dependence on manual execution for recurring tasks.",
     "Begin documenting automation procedures and ownership.",
     "Demonstrate that automation is used beyond isolated or experimental scenarios.",
     "Track which activities are automated versus manual."
    ],
    "evidence_examples": [
     "Source-controlled automation repositories",
     "Automated provisioning scripts",
     "Configuration management artifacts",
     "Infrastructure deployment templates",
     "Operational runbooks referencing automation ---"
    ]
   },
   {
    "level": 2,
    "name": "Developing",
    "description": "Automation scripts exist, but execution is inconsistent.",
    "key_characteristics": [
     "Infrastructure-as-Code or automation scripts exist and are used for some changes.",
     "Execution is inconsistent and often triggered manually.",
     "Automation adoption is not measured.",
     "Success and failure rates are not routinely tracked.",
     "Automation operates outside version control in some cases, reducing traceability.",
     "Automation usage varies across teams, systems, or environments."
    ],
    "level_up_criteria": [
     "Require automation for qualifying infrastructure and configuration changes.",
     "Standardize automation patterns, modules, templates, or reusable components.",
     "Use version-controlled infrastructure definitions as the source of truth.",
     "Implement centralized secrets management.",
     "Establish ownership and lifecycle management for automation assets.",
     "Demonstrate consistent use of automation across environments."
    ],
    "evidence_examples": [
     "Approved Terraform modules",
     "Infrastructure-as-Code repositories",
     "Secret-management integrations",
     "Standard automation templates",
     "Configuration baselines",
     "Repository governance standards ---"
    ]
   },
   {
    "level": 3,
    "name": "Defined",
    "description": "Infrastructure and configuration changes are applied through a consistent, automated process.",
    "key_characteristics": [
     "Infrastructure-as-Code and automation assets are version-controlled.",
     "Defined patterns, modules, and templates are used consistently.",
     "Qualifying infrastructure and configuration changes are applied through automation rather than manual execution.",
     "Secrets are managed through centralized platforms with auditable access controls.",
     "Approved reusable modules are adopted to reduce custom implementation patterns.",
     "Ownership and maintenance responsibilities are clearly established."
    ],
    "level_up_criteria": [
     "Measure automation coverage across infrastructure and operational activities.",
     "Track automation success rates, failures, and reliability metrics.",
     "Monitor manual changes as documented exceptions.",
     "Review automation metrics on a recurring cadence.",
     "Use automation performance data to identify improvement opportunities.",
     "Demonstrate active management of automation quality and effectiveness."
    ],
    "evidence_examples": [
     "Automation coverage dashboards",
     "Infrastructure deployment metrics",
     "Coverage reports",
     "Exception logs",
     "Automation reliability trend reporting",
     "Engineering reviews focused on automation performance ---"
    ]
   },
   {
    "level": 4,
    "name": "Measured",
    "description": "Automation coverage and reliability are tracked.",
    "key_characteristics": [
     "Automation coverage is measured as a percentage of qualifying changes.",
     "Manual changes are tracked as exceptions rather than routine practice.",
     "Secrets rotation policies are defined, enforced, and monitored.",
     "Automated detection and remediation may exist for secrets found in code.",
     "Automation reliability metrics are captured and analyzed.",
     "Failure patterns inform improvement efforts."
    ],
    "level_up_criteria": [
     "Implement technical controls that prevent or significantly restrict manual infrastructure changes.",
     "Continuously detect and remediate infrastructure drift.",
     "Use automation telemetry to identify optimization opportunities.",
     "Automate remediation of recurring operational issues where appropriate.",
     "Ensure qualifying infrastructure changes flow through approved automated processes.",
     "Demonstrate that automation drives consistency and continuous operational improvement."
    ],
    "evidence_examples": [
     "Drift detection tooling",
     "Policy-as-Code controls",
     "Automated remediation workflows",
     "Infrastructure compliance reporting",
     "Automated guardrail enforcement",
     "Infrastructure health telemetry ---"
    ]
   },
   {
    "level": 5,
    "name": "Optimizing",
    "description": "Manual infrastructure changes are architecturally prevented.",
    "key_characteristics": [
     "Guardrails prevent manual or out-of-band infrastructure changes for qualifying systems.",
     "Automation continuously improves through telemetry-driven optimization.",
     "Infrastructure drift is automatically detected and corrected.",
     "Automated processes govern infrastructure and configuration lifecycle management.",
     "Manual intervention becomes the exception and requires governance oversight.",
     "Infrastructure operations are highly repeatable, auditable, and resilient."
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
  "na_description": "Not applicable if the team does not create or modify source code, configuration, scripts, or Infrastructure-as-Code artifacts and is therefore not expected to maintain version control or traceability.",
  "levels": [
   {
    "level": 0,
    "name": "Below Baseline",
    "description": "Version control is not used. Code, configuration, or infrastructure changes cannot be traced to work items or releases. Branching strategies are not used.",
    "key_characteristics": [
     "None. Source artifacts, configuration, or infrastructure changes cannot be reliably tracked, audited, or connected to business outcomes."
    ],
    "level_up_criteria": [
     "Store at least some source code, scripts, configuration files, or Infrastructure-as-Code assets in an approved version control platform.",
     "Establish a repository structure for active development work.",
     "Maintain basic commit history identifying who made changes.",
     "Define a basic branch and merge process.",
     "Demonstrate the ability to retrieve prior versions of managed assets."
    ],
    "evidence_examples": [
     "Git repositories",
     "Commit history",
     "Repository ownership documentation",
     "Branching guidance",
     "Source control platform usage reports ---"
    ]
   },
   {
    "level": 1,
    "name": "Initial",
    "description": "Version control usage is inconsistent, and traceability relies on manual notes or individual habits.",
    "key_characteristics": [
     "Version control usage varies, with some code, scripts, or configuration stored outside approved repositories.",
     "Configuration updates are handled manually, creating drift and limited visibility into change history.",
     "Infrastructure changes are not consistently tracked and often occur outside Infrastructure-as-Code practices.",
     "Traceability relies on manual naming conventions, spreadsheets, documentation, or personal notes.",
     "Branch and merge practices are inconsistent and lack agreed workflows or review expectations."
    ],
    "level_up_criteria": [
     "Store the majority of source artifacts in approved repositories.",
     "Expand version control beyond application code to include scripts, configuration files, and Infrastructure-as-Code where applicable.",
     "Establish repeatable branching and merge practices.",
     "Introduce pull requests, merge requests, or peer review processes.",
     "Begin linking work items to source control activities.",
     "Reduce reliance on manual tracking of change history."
    ],
    "evidence_examples": [
     "Pull request workflows",
     "Branching standards",
     "Infrastructure-as-Code repositories",
     "Work item references in commits",
     "Repository review history",
     "Source control governance documentation ---"
    ]
   },
   {
    "level": 2,
    "name": "Developing",
    "description": "Version control is used for some assets, but branching, Infrastructure-as-Code, and traceability practices differ across work types and are applied inconsistently.",
    "key_characteristics": [
     "Most code changes are stored in version control, but scripts, configuration files, and infrastructure definitions may be managed separately.",
     "Branching and merge practices vary across repositories.",
     "Protection controls and review requirements are inconsistently enforced.",
     "Configuration-as-Code is emerging, but portions of configuration remain manual.",
     "Infrastructure-as-Code adoption is partial and inconsistent.",
     "Traceability is improving, but linking requirements, code, tests, and releases still requires manual effort."
    ],
    "level_up_criteria": [
     "Use approved repositories consistently across qualifying assets.",
     "Standardize branching, merge, and review practices.",
     "Implement repository protection controls.",
     "Require peer review before merging qualifying changes.",
     "Adopt Configuration-as-Code and Infrastructure-as-Code practices where applicable.",
     "Establish documented traceability connecting requirements, code changes, testing activities, and release artifacts."
    ],
    "evidence_examples": [
     "Protected branch settings",
     "Merge approval requirements",
     "Repository governance standards",
     "Configuration-as-Code repositories",
     "Traceability documentation",
     "Repository access controls ---"
    ]
   },
   {
    "level": 3,
    "name": "Defined",
    "description": "Standardized repository practices, Configuration-as-Code, and traceability are consistently applied.",
    "key_characteristics": [
     "Approved repositories are used consistently.",
     "Structured branching, merge review processes, and access controls are established.",
     "Multi-factor authentication and repository administration practices are defined.",
     "Repository security controls govern permissions and visibility changes.",
     "Configuration-as-Code has been adopted.",
     "Infrastructure-as-Code follows standardized patterns, modules, and folder structures.",
     "Traceability is documented and links work items to code changes, tests, and release artifacts."
    ],
    "level_up_criteria": [
     "Maintain end-to-end traceability from work item through deployment.",
     "Measure traceability completeness and metadata quality.",
     "Monitor adherence to branching, review, and repository standards.",
     "Track repository governance metrics and exceptions.",
     "Maintain artifact provenance information.",
     "Use traceability information during audits, reviews, incident investigations, and release validation activities."
    ],
    "evidence_examples": [
     "Traceability dashboards",
     "Audit reports",
     "Release lineage reports",
     "Repository compliance reviews",
     "Provenance tracking records",
     "Software Bill of Materials (SBOM) records ---"
    ]
   },
   {
    "level": 4,
    "name": "Measured",
    "description": "Traceability is monitored and used to improve consistency, security, and release reliability.",
    "key_characteristics": [
     "End-to-end traceability connects requirements, commits, builds, deployments, releases, and supporting artifacts.",
     "Configuration and infrastructure changes are governed through version-controlled workflows.",
     "Metadata quality is measured and monitored.",
     "Commit history, merge history, and release information consistently reflect business context.",
     "Artifact provenance is tracked and visible.",
     "Compliance signals such as review history, SBOM generation, and dependency scanning can be observed and reported."
    ],
    "level_up_criteria": [
     "Automate traceability across the software delivery lifecycle.",
     "Eliminate manual reconciliation between requirements, code, testing, approvals, and releases.",
     "Enforce repository governance through automated controls.",
     "Automatically collect and maintain lineage data.",
     "Use traceability data to identify quality, security, delivery, and platform improvement opportunities.",
     "Demonstrate that traceability information informs engineering decisions."
    ],
    "evidence_examples": [
     "Automated work item linking",
     "Automated release lineage generation",
     "Policy-as-Code governance controls",
     "Automated dependency tracking",
     "Delivery intelligence dashboards",
     "Platform analytics using traceability data ---"
    ]
   },
   {
    "level": 5,
    "name": "Optimizing",
    "description": "Traceability is automated and drives continuous improvement, auditability, and delivery intelligence.",
    "key_characteristics": [
     "Automated traceability connects code, Infrastructure-as-Code, configuration, tests, approvals, and releases.",
     "Configuration and infrastructure are fully expressed as code.",
     "Real-time drift detection supports operational integrity.",
     "Governance controls prevent untracked or unreviewed changes.",
     "Historical lineage is visible across repositories, modules, deployments, and releases.",
     "Traceability insights actively inform quality improvement, security decisions, architecture modernization, refactoring opportunities, and platform investment decisions."
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
  "na_description": "Not applicable if the team does not write, maintain, or execute application or platform code (including scripts). Teams only deploy vendor products, operate COTS systems without custom code, or perform operations-only responsibilities.",
  "levels": [
   {
    "level": 0,
    "name": "Below Baseline",
    "description": "The team has no automated tests and relies entirely on manual validation or production discovery.",
    "key_characteristics": [
     "None. Validation depends entirely on manual testing, user reports, or post-release issue discovery."
    ],
    "level_up_criteria": [
     "Implement at least one form of automated testing (unit, integration, API, UI, regression, or equivalent).",
     "Execute automated tests for at least a subset of application functionality.",
     "Store test assets in a managed repository.",
     "Establish ownership for automated test maintenance.",
     "Demonstrate successful execution of automated tests during the assessment period."
    ],
    "evidence_examples": [
     "Unit test frameworks",
     "Automated test scripts",
     "Test repositories",
     "Build logs showing test execution",
     "Quality engineering procedures ---"
    ]
   },
   {
    "level": 1,
    "name": "Initial",
    "description": "Automated testing is minimal; validation is manual and issues are discovered late.",
    "key_characteristics": [
     "Automated testing is minimal, with validation primarily manual or ad hoc after deployment.",
     "Coverage expectations are undefined.",
     "Critical application paths lack unit, integration, or end-to-end coverage.",
     "Automated tests are often executed locally rather than systematically.",
     "Testing is not embedded into delivery workflows."
    ],
    "level_up_criteria": [
     "Expand automated testing beyond isolated components.",
     "Establish documented expectations for automated testing practices.",
     "Execute automated tests on a recurring basis.",
     "Incorporate automated testing into portions of the development lifecycle.",
     "Identify critical workflows requiring automated validation.",
     "Track which system areas have automated coverage versus manual-only validation."
    ],
    "evidence_examples": [
     "Test coverage inventories",
     "Automated regression suites",
     "Integration test suites",
     "Testing standards",
     "Test execution reports",
     "Coverage assessments ---"
    ]
   },
   {
    "level": 2,
    "name": "Developing",
    "description": "Some automated tests exist, but coverage, reliability, and consistency vary widely.",
    "key_characteristics": [
     "Coverage is limited and focused on selected components or services.",
     "Automated testing is isolated to specific code paths.",
     "Test execution is irregular and may require manual triggering.",
     "Pipeline integration is inconsistent.",
     "Test reliability is not measured.",
     "Flaky or unstable tests persist without active remediation."
    ],
    "level_up_criteria": [
     "Define testing scope across unit, integration, end-to-end, and regression testing as applicable.",
     "Automatically execute qualifying tests through delivery workflows.",
     "Integrate automated testing with CI/CD pipelines, merge requests, or deployment processes.",
     "Make test results visible to engineers and delivery teams.",
     "Establish a process for reviewing and remediating failing tests.",
     "Maintain managed test data, mocks, stubs, or test environments supporting reliable execution."
    ],
    "evidence_examples": [
     "Pipeline-integrated test execution",
     "CI/CD quality gates",
     "Merge request validation",
     "Test result dashboards",
     "Regression testing standards",
     "Test environment management procedures ---"
    ]
   },
   {
    "level": 3,
    "name": "Defined",
    "description": "Automated tests exist for key behaviors and run consistently as part of standard delivery workflows.",
    "key_characteristics": [
     "Unit, integration, end-to-end, and regression testing scopes are documented.",
     "Execution is automated and integrated into standard delivery workflows.",
     "Automated tests run through CI/CD pipelines, merge requests, or promotion workflows.",
     "Results are visible to the team.",
     "Test failures are routinely reviewed and categorized.",
     "Test data and mock services are managed to ensure reliable execution.",
     "Environment dependencies are controlled to support repeatable outcomes."
    ],
    "level_up_criteria": [
     "Measure automated testing coverage, execution reliability, and quality trends.",
     "Track test failure rates, flaky tests, execution times, and stability metrics.",
     "Use automated test outcomes as release readiness indicators.",
     "Review testing metrics on a recurring cadence.",
     "Demonstrate active maintenance of automated testing assets.",
     "Use testing data to identify quality risks and improvement opportunities."
    ],
    "evidence_examples": [
     "Coverage dashboards",
     "Test stability reports",
     "Flaky test remediation backlog",
     "Release readiness reports",
     "Quality trend reporting",
     "QE review sessions ---"
    ]
   },
   {
    "level": 4,
    "name": "Measured",
    "description": "Automated suites provide repeatable, measurable quality signals that influence delivery workflows.",
    "key_characteristics": [
     "Automated test suites are instrumented and monitored.",
     "Coverage, stability, execution performance, and failure trends are tracked.",
     "Test results serve as release confidence indicators.",
     "Maintenance is proactive.",
     "Critical paths remain well-covered.",
     "Low-value tests are identified and retired when appropriate.",
     "Testing metrics influence engineering decisions."
    ],
    "level_up_criteria": [
     "Use risk-based or impact-based testing strategies.",
     "Continuously tune automated suites to maximize risk coverage while minimizing execution time.",
     "Implement automated identification and remediation of test instability where feasible.",
     "Use testing intelligence to guide release decisions.",
     "Demonstrate adaptive execution based on change scope, risk profile, or impacted functionality.",
     "Continuously evaluate and improve testing effectiveness."
    ],
    "evidence_examples": [
     "Test impact analysis",
     "Risk-based test selection",
     "Adaptive execution strategies",
     "Automated test maintenance capabilities",
     "Quality engineering analytics",
     "Intelligent regression testing approaches ---"
    ]
   },
   {
    "level": 5,
    "name": "Optimizing",
    "description": "Automation is comprehensive, reliable, and continuously tuned to support fast and safe delivery.",
    "key_characteristics": [
     "Coverage is risk-informed and continuously aligned to protect critical business and technical workflows.",
     "Test execution adapts to code changes and impacted areas.",
     "Test selection is optimized to maximize confidence and speed.",
     "Suites maintain low flakiness and efficient runtime.",
     "Test data and dependency management are automated.",
     "Quality signals are continuously improved based on operational outcomes and engineering needs."
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
  "na_description": "Not applicable if the team does not develop, modify, deploy, or maintain code, scripts, applications, APIs, Infrastructure-as-Code, or configuration that requires security validation. 【1-af0e1e】",
  "levels": [
   {
    "level": 0,
    "name": "Below Baseline",
    "description": "No security testing is performed prior to deployment or release.",
    "key_characteristics": [
     "None. Security vulnerabilities are discovered only through production incidents, external assessments, audits, or user reports."
    ],
    "level_up_criteria": [
     "Perform at least one form of security validation prior to release or deployment.",
     "Document basic security testing expectations.",
     "Identify ownership for application security testing activities.",
     "Review security findings when discovered.",
     "Demonstrate security testing has occurred for at least one application, release, or platform component."
    ],
    "evidence_examples": [
     "Vulnerability scan reports",
     "Security review checklists",
     "Security testing plans",
     "Application security assessments",
     "Security findings logs ---"
    ]
   },
   {
    "level": 1,
    "name": "Initial",
    "description": "Security testing is limited, inconsistent, and largely dependent on individual initiative.",
    "key_characteristics": [
     "Security reviews occur sporadically.",
     "Vulnerability identification is largely reactive.",
     "Security validation is often performed late in the development lifecycle.",
     "Security findings may not be tracked consistently.",
     "Security testing expectations vary across applications and teams.",
     "Security activities are not integrated into normal delivery workflows."
    ],
    "level_up_criteria": [
     "Establish repeatable security testing activities for qualifying applications or services.",
     "Incorporate automated or semi-automated security testing into parts of the development lifecycle.",
     "Define minimum security testing requirements based on application risk.",
     "Track identified vulnerabilities and remediation status.",
     "Apply security testing consistently across major releases.",
     "Integrate security findings into engineering workflows."
    ],
    "evidence_examples": [
     "SAST scan results",
     "Dependency scanning reports",
     "Vulnerability management tickets",
     "Security testing procedures",
     "Security assessment records",
     "Risk-based testing requirements ---"
    ]
   },
   {
    "level": 2,
    "name": "Developing",
    "description": "Basic security testing capabilities exist, but coverage, consistency, and remediation effectiveness vary significantly.",
    "key_characteristics": [
     "Security testing is performed on selected applications or release types.",
     "Automated scanning exists but is inconsistently applied.",
     "Security testing coverage differs across systems and repositories.",
     "Vulnerability remediation practices vary.",
     "Security requirements are not consistently tied to delivery readiness.",
     "Testing depth depends on individual team practices."
    ],
    "level_up_criteria": [
     "Integrate security testing into standard development and delivery workflows.",
     "Establish documented requirements for security testing activities based on system risk and classification.",
     "Perform security testing prior to production promotion.",
     "Ensure security findings are reviewed, triaged, and assigned.",
     "Define severity classifications and remediation expectations.",
     "Maintain evidence that security controls are evaluated consistently."
    ],
    "evidence_examples": [
     "Pipeline-integrated security scans",
     "Security quality gates",
     "Threat modeling outputs",
     "Secure release readiness reviews",
     "Security testing standards",
     "Remediation workflows ---"
    ]
   },
   {
    "level": 3,
    "name": "Defined",
    "description": "Security testing practices are standardized, repeatable, and integrated into delivery workflows.",
    "key_characteristics": [
     "Security testing occurs as part of normal software delivery activities.",
     "Security requirements are documented and consistently applied.",
     "Security testing is tied to application risk.",
     "Vulnerabilities are reviewed, triaged, and assigned for remediation.",
     "Security findings influence promotion and readiness decisions.",
     "Security validation requirements are known and repeatable."
    ],
    "level_up_criteria": [
     "Measure security testing effectiveness and vulnerability management performance.",
     "Track vulnerability trends, remediation timelines, and recurring security issues.",
     "Monitor compliance with security testing requirements.",
     "Review security metrics on a recurring cadence.",
     "Use testing results to improve secure development practices.",
     "Demonstrate that security findings influence release and risk decisions."
    ],
    "evidence_examples": [
     "Vulnerability dashboards",
     "Risk trend reporting",
     "Security metrics reviews",
     "Remediation SLA reporting",
     "Security compliance reviews",
     "Release risk assessments ---"
    ]
   },
   {
    "level": 4,
    "name": "Measured",
    "description": "Security testing effectiveness and vulnerability management performance are measured and actively managed.",
    "key_characteristics": [
     "Security testing coverage and effectiveness are monitored.",
     "Vulnerability trends are tracked over time.",
     "Resolution performance is measured and managed.",
     "Security findings influence engineering priorities.",
     "Compliance with security expectations is visible.",
     "Security metrics support governance and risk management decisions."
    ],
    "level_up_criteria": [
     "Continuously adapt security testing based on evolving threats and risk exposure.",
     "Automate security validation wherever technically feasible.",
     "Use security telemetry and historical findings to improve prevention and detection capabilities.",
     "Prioritize testing efforts using risk-informed approaches.",
     "Demonstrate continuous improvement in security posture and vulnerability reduction.",
     "Ensure security validation is embedded throughout the software delivery lifecycle."
    ],
    "evidence_examples": [
     "Risk-based security testing strategies",
     "Continuous security validation",
     "Automated policy enforcement",
     "Security analytics platforms",
     "Threat-informed testing practices",
     "Security engineering roadmaps ---"
    ]
   },
   {
    "level": 5,
    "name": "Optimizing",
    "description": "Security validation is continuously improved, risk-informed, and fully embedded in engineering practices.",
    "key_characteristics": [
     "Security testing evolves alongside emerging threats.",
     "Automated validation is extensively integrated throughout delivery workflows.",
     "Security controls adapt based on risk and context.",
     "Vulnerability reduction trends demonstrate continuous improvement.",
     "Security insights influence architecture, engineering, and operational decisions.",
     "Security is treated as a continuous engineering capability rather than a periodic validation exercise."
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
  "na_description": "Not applicable if the team does not own software services, APIs, or workload-bearing systems. This includes teams that operate internal platforms without service-level traffic, hardware-only groups, or teams without defined SLOs, SLIs, or user-facing behaviors.",
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
     "Execute at least one performance or reliability test against a production-relevant workload.",
     "Establish ownership for performance and reliability testing activities.",
     "Document basic performance expectations, even if targets are preliminary.",
     "Demonstrate testing has occurred within the assessment period."
    ],
    "evidence_examples": [
     "Load test reports",
     "Performance test plans",
     "Initial capacity assessments",
     "Reliability testing documentation",
     "Operational readiness reviews ---"
    ]
   },
   {
    "level": 1,
    "name": "Initial",
    "description": "Performance and reliability testing is largely absent; behavior under load or failure is unknown.",
    "key_characteristics": [
     "SLOs and SLIs are undefined.",
     "No targets exist for latency, throughput, availability, or error rates.",
     "Testing occurs infrequently and often only after incidents.",
     "Resilience behavior is largely untested.",
     "Recovery expectations have not been validated.",
     "Teams have limited understanding of degraded-mode operations."
    ],
    "level_up_criteria": [
     "Establish repeatable performance or reliability testing activities.",
     "Define basic performance scenarios aligned to expected usage patterns.",
     "Execute load, stress, or resilience testing on a recurring basis.",
     "Document findings and remediation actions resulting from testing.",
     "Begin evaluating performance risks before major releases.",
     "Track performance issues discovered through testing."
    ],
    "evidence_examples": [
     "Load testing scripts",
     "Reliability test suites",
     "Capacity planning documentation",
     "Performance issue backlogs",
     "Test execution records",
     "Baseline performance reports ---"
    ]
   },
   {
    "level": 2,
    "name": "Developing",
    "description": "Basic load or resilience checks exist but are inconsistent and not used in release decisions.",
    "key_characteristics": [
     "Testing scenarios are shallow and limited to basic load or smoke testing.",
     "Testing execution is largely manual.",
     "Workloads do not consistently reflect production traffic patterns.",
     "Results are not consistently actionable.",
     "Bottlenecks may be identified but are not systematically remediated.",
     "Failover and recovery testing occur inconsistently.",
     "Release readiness decisions are not influenced by testing results."
    ],
    "level_up_criteria": [
     "Define and document SLOs and SLIs for key services.",
     "Establish performance thresholds supporting release readiness decisions.",
     "Conduct standardized performance testing scenarios, including load, spike, and soak testing where appropriate.",
     "Document expected service degradation and recovery behaviors.",
     "Execute testing before production promotion for qualifying releases.",
     "Ensure performance results are reviewed during release decision-making."
    ],
    "evidence_examples": [
     "SLO and SLI documentation",
     "Performance testing standards",
     "Release readiness criteria",
     "Performance test reports",
     "Reliability requirements documentation",
     "Capacity assessments ---"
    ]
   },
   {
    "level": 3,
    "name": "Defined",
    "description": "Performance expectations are documented and validated for key systems before promotion.",
    "key_characteristics": [
     "SLOs and SLIs are defined for critical services.",
     "Metrics such as p95 latency, p99 latency, throughput, availability, and error rates are documented.",
     "Standardized load, spike, and soak tests are executed.",
     "Testing scenarios align to expected production usage.",
     "Test outcomes influence release readiness decisions.",
     "Go/no-go thresholds are defined and tied to performance expectations.",
     "Resilience behaviors and degradation expectations are documented."
    ],
    "level_up_criteria": [
     "Track performance and reliability trends across releases.",
     "Measure system behavior relative to established SLOs and SLIs.",
     "Maintain performance baselines and monitor regressions.",
     "Integrate performance and reliability validation into delivery workflows.",
     "Delay or block promotions when critical performance criteria are not met.",
     "Conduct resilience exercises validating recovery behavior under failure conditions."
    ],
    "evidence_examples": [
     "Performance dashboards",
     "Release-over-release trend reporting",
     "Capacity forecasting reports",
     "Reliability scorecards",
     "Fault simulation results",
     "Promotion gate documentation ---"
    ]
   },
   {
    "level": 4,
    "name": "Measured",
    "description": "Performance and reliability suites are repeatable, instrumented, and integrated into release decisions to reduce operational risk.",
    "key_characteristics": [
     "Trends are monitored across releases and environments.",
     "Performance regressions can be identified and measured.",
     "Execution is integrated into delivery workflows.",
     "Test failures can prevent promotion until mitigations are implemented.",
     "Performance baselines are maintained.",
     "Capacity planning is informed by observed testing data.",
     "Resilience exercises include dependency failure simulation and controlled fault scenarios."
    ],
    "level_up_criteria": [
     "Continuously validate performance and resilience using production-informed testing strategies.",
     "Conduct routine resilience engineering activities, including fault injection or chaos experimentation where appropriate.",
     "Use error budgets and reliability objectives to guide release decisions.",
     "Continuously optimize scalability, recovery, and user experience based on observed results.",
     "Automatically identify emerging performance risks.",
     "Demonstrate that testing evolves as architecture, usage patterns, and operational risks change."
    ],
    "evidence_examples": [
     "Chaos engineering exercises",
     "Fault injection testing",
     "Error budget reviews",
     "Reliability engineering metrics",
     "Production traffic modeling",
     "Continuous performance validation capabilities ---"
    ]
   },
   {
    "level": 5,
    "name": "Optimizing",
    "description": "Testing is continuous, production-informed, and focused on preventing impact before it occurs.",
    "key_characteristics": [
     "Traffic patterns used in testing resemble real production conditions.",
     "Testing includes concurrency, peak demand, and downstream dependency variation.",
     "Chaos or fault-injection testing validates resiliency mechanisms.",
     "Circuit breakers, retry logic, timeouts, and backpressure controls are routinely validated.",
     "Error budgets influence release pacing and prioritization decisions.",
     "Continuous performance tuning improves scalability, resiliency, and user experience.",
     "Reliability engineering is proactive rather than reactive."
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
     "None. Changes can be introduced into systems without peer validation, security assessment, or secure engineering controls."
    ],
    "level_up_criteria": [
     "Establish a basic peer review process for code, configuration, scripts, or Infrastructure-as-Code changes.",
     "Identify individuals authorized to review and approve changes.",
     "Document basic security expectations for code changes.",
     "Perform reviews on at least some changes prior to deployment.",
     "Demonstrate evidence that review activities are occurring."
    ],
    "evidence_examples": [
     "Pull request reviews",
     "Merge request approvals",
     "Review checklists",
     "Engineering standards",
     "Change approval records ---"
    ]
   },
   {
    "level": 1,
    "name": "Initial",
    "description": "Security and code review practices are informal, inconsistent, and dependent on individual judgment.",
    "key_characteristics": [
     "Reviews occur inconsistently without defined expectations regarding scope, depth, or evidence.",
     "Threat modeling is informal and performed only when initiated by individuals.",
     "Secure design considerations are ad hoc.",
     "Security checks are largely manual.",
     "Findings may not be documented or triaged.",
     "Protected branches are not consistently enforced.",
     "Changes can bypass structured review activities."
    ],
    "level_up_criteria": [
     "Define minimum review expectations across repositories and development teams.",
     "Require peer review for most changes prior to merge.",
     "Implement at least some security validation activities as part of the review process.",
     "Capture review evidence through comments, approvals, or documented decisions.",
     "Establish guidance for identifying security-sensitive or higher-risk changes.",
     "Document exceptions when review processes are bypassed."
    ],
    "evidence_examples": [
     "Peer review standards",
     "Security review checklists",
     "Repository review policies",
     "Approval records",
     "Review exception logs",
     "Security governance documentation ---"
    ]
   },
   {
    "level": 2,
    "name": "Developing",
    "description": "Basic security and review expectations exist, but adoption, depth, and documentation vary by repository or change type.",
    "key_characteristics": [
     "Peer review occurs, but review quality and consistency vary.",
     "Security checks exist for some changes, including SAST or dependency scanning.",
     "Threat modeling guidance is available but not consistently applied.",
     "Review evidence varies in quality and depth.",
     "Review controls are only partially enforced.",
     "Security validation is inconsistent between teams and repositories."
    ],
    "level_up_criteria": [
     "Document formal code review standards and reviewer expectations.",
     "Establish required security checkpoints for applicable changes.",
     "Implement protected branches or equivalent controls.",
     "Apply structured threat modeling to qualifying architectural, data flow, or design changes.",
     "Require auditable evidence of review and approval activities.",
     "Define secure SDLC requirements and integrate them into delivery processes."
    ],
    "evidence_examples": [
     "Secure SDLC standards",
     "Threat modeling documentation",
     "Protected branch configuration",
     "Repository governance policies",
     "Review approval records",
     "Security scanning requirements ---"
    ]
   },
   {
    "level": 3,
    "name": "Defined",
    "description": "Secure SDLC and code review practices are documented, repeatable, and consistently applied.",
    "key_characteristics": [
     "Review standards are documented.",
     "Expectations for security considerations, quality checks, and required reviewers are established.",
     "Threat modeling is applied predictably using structured methods.",
     "Security checkpoints include capabilities such as SAST, SCA, secrets scanning, and Infrastructure-as-Code scanning where applicable.",
     "Protected branches are required.",
     "Review evidence is recorded and auditable.",
     "Review workflows are consistently enforced."
    ],
    "level_up_criteria": [
     "Measure adherence to review and secure SDLC practices.",
     "Track security findings identified through reviews and security controls.",
     "Monitor review effectiveness using defined performance indicators.",
     "Define remediation timelines and verification requirements.",
     "Measure completion of required security checkpoints.",
     "Review metrics and trends on a recurring cadence."
    ],
    "evidence_examples": [
     "Review quality dashboards",
     "Security findings reporting",
     "Review cycle-time metrics",
     "Threat model inventories",
     "Compliance reporting",
     "Remediation tracking dashboards ---"
    ]
   },
   {
    "level": 4,
    "name": "Measured",
    "description": "Secure SDLC activities are integrated with delivery workflows and produce measurable signals.",
    "key_characteristics": [
     "Review quality is monitored through measurable indicators.",
     "Comment quality, defect discovery, and review cycle times are observed.",
     "Security findings are tracked and analyzed.",
     "Remediation expectations are defined and governed.",
     "Threat modeling outcomes are recorded and linked to risk mitigation activities.",
     "Adherence to review controls is visible and measurable.",
     "Security review effectiveness influences engineering decisions."
    ],
    "level_up_criteria": [
     "Automatically enforce review and security control requirements through tooling.",
     "Prevent qualifying changes from being merged when required reviews or security validations are incomplete.",
     "Trigger additional security analysis based on change risk profile.",
     "Continuously improve review processes using observed findings, defects, and security trends.",
     "Integrate threat modeling into ongoing engineering and architectural decision making.",
     "Demonstrate that secure design and code review practices proactively reduce organizational risk."
    ],
    "evidence_examples": [
     "Automated merge protection controls",
     "Policy-as-Code enforcement",
     "Risk-based security workflows",
     "Automated secure SDLC gates",
     "Security governance reporting",
     "Engineering effectiveness reviews ---"
    ]
   },
   {
    "level": 5,
    "name": "Optimizing",
    "description": "Secure engineering practices are embedded into behavior, tooling, and governance, reducing risk proactively.",
    "key_characteristics": [
     "Automated guardrails prevent merges when required reviews or security checks have not completed.",
     "Threat modeling is proactive and continuously revisited as systems evolve.",
     "Review practices continuously improve based on observed defects, vulnerabilities, and outcomes.",
     "Security validation activities adapt based on risk context.",
     "Secure SDLC insights influence design patterns, frameworks, reusable components, and platform improvements.",
     "Security is embedded into engineering culture rather than treated as a supplemental activity."
    ],
    "level_up_criteria": [],
    "evidence_examples": []
   }
  ]
 },
 {
  "id": "9",
  "title": "Engineering Governance",
  "definition": "Clear decision rights, guardrails, and oversight mechanisms that ensure predictable engineering outcomes through formal gates, risk controls, funding alignment, and governance forums that enforce consistency and accountability.",
  "na_description": "Not applicable if the team does not make engineering or technical decisions requiring documented standards, approval gates, or governance participation.",
  "levels": [
   {
    "level": 0,
    "name": "Below Baseline",
    "description": "Engineering decisions occur informally without documented standards, gate criteria, or defined decision rights.",
    "key_characteristics": [
     "None. Engineering decisions are made without documented governance structures, approval requirements, accountability mechanisms, or formal oversight."
    ],
    "level_up_criteria": [
     "Identify individuals or groups responsible for engineering decision-making.",
     "Define at least one governance forum, approval mechanism, or escalation path.",
     "Document basic expectations for engineering reviews or approvals.",
     "Capture records of significant engineering decisions.",
     "Demonstrate governance participation on at least some engineering initiatives."
    ],
    "evidence_examples": [
     "Architecture review meetings",
     "Approval records",
     "Engineering leadership forums",
     "Decision logs",
     "Team operating procedures ---"
    ]
   },
   {
    "level": 1,
    "name": "Initial",
    "description": "Engineering decisions are inconsistent and dependent on informal escalation or individual judgment.",
    "key_characteristics": [
     "Decision rights are unclear, creating ambiguity around who approves design, security, platform, or delivery changes.",
     "Guardrails are limited and poorly documented.",
     "Escalation paths rely heavily on personal networks and relationships.",
     "Approval evidence is inconsistent.",
     "Engineering decisions may vary significantly between teams.",
     "Funding priorities and technical priorities shift reactively rather than through defined governance criteria."
    ],
    "level_up_criteria": [
     "Document governance processes for common engineering decisions.",
     "Define which engineering changes require review, approval, or escalation.",
     "Establish governance forums with recurring participation.",
     "Begin documenting standards, policies, or engineering expectations.",
     "Identify engineering risks as part of governance discussions.",
     "Track major decisions and exceptions in a repeatable manner."
    ],
    "evidence_examples": [
     "Governance charters",
     "Engineering standards documentation",
     "Approval workflows",
     "Risk review artifacts",
     "Exception tracking records",
     "Engineering council participation records ---"
    ]
   },
   {
    "level": 2,
    "name": "Developing",
    "description": "Some governance forums and standards exist, but expectations and decision pathways vary.",
    "key_characteristics": [
     "Standards are partially documented, but adoption varies across teams and work types.",
     "Governance forums exist, but engagement is inconsistent.",
     "Governance activities are not always tied to delivery outcomes.",
     "Approval paths exist but remain loosely enforced.",
     "Risk considerations are inconsistently applied.",
     "Dependency management and exception handling vary significantly across teams."
    ],
    "level_up_criteria": [
     "Define clear decision rights and approval authorities.",
     "Establish documented governance standards covering engineering, security, release, and operational decisions.",
     "Define required evidence for governance approvals.",
     "Document escalation paths for elevated-risk decisions.",
     "Apply governance expectations consistently across qualifying work.",
     "Demonstrate governance alignment across participating delivery teams."
    ],
    "evidence_examples": [
     "RACI or decision-rights matrix",
     "Architecture review standards",
     "Release governance requirements",
     "Risk management procedures",
     "Approval criteria documentation",
     "Engineering governance playbooks ---"
    ]
   },
   {
    "level": 3,
    "name": "Defined",
    "description": "Engineering governance is documented, repeatable, and aligned to clear decision rights and controls.",
    "key_characteristics": [
     "Decision rights are established and communicated.",
     "Governance processes define which decisions require approval, review, or escalation.",
     "Risk controls establish minimum safeguards for code, configuration, Infrastructure-as-Code, and environment changes.",
     "Standards are consistently applied.",
     "Approval requirements include documented evidence expectations.",
     "Escalation paths are well understood and consistently used.",
     "Governance structures support predictable engineering outcomes."
    ],
    "level_up_criteria": [
     "Measure governance effectiveness using defined indicators.",
     "Track governance exceptions and their outcomes.",
     "Measure approval cycle times and decision latency.",
     "Review governance bottlenecks and improvement opportunities.",
     "Monitor adherence to governance standards.",
     "Demonstrate that governance outcomes influence delivery, risk, or operational decisions."
    ],
    "evidence_examples": [
     "Governance dashboards",
     "Approval cycle reporting",
     "Exception trend analysis",
     "Risk reduction metrics",
     "Governance reviews",
     "Delivery effectiveness reporting ---"
    ]
   },
   {
    "level": 4,
    "name": "Measured",
    "description": "Governance processes are monitored for effectiveness, timeliness, and delivery impact.",
    "key_characteristics": [
     "Decision quality is reviewed and evaluated.",
     "Governance evidence is assessed for completeness and usefulness.",
     "Exceptions are tracked and analyzed.",
     "Approval cycle times are measured and optimized.",
     "Governance controls are evaluated for effectiveness.",
     "Risk reduction outcomes are reviewed.",
     "Dependencies are surfaced and managed across organizational boundaries."
    ],
    "level_up_criteria": [
     "Automate governance controls wherever feasible.",
     "Enforce engineering standards through tooling and delivery workflows.",
     "Allow teams to operate autonomously within established guardrails.",
     "Continuously refine governance processes using operational, quality, and delivery outcomes.",
     "Use governance data to identify systemic improvement opportunities.",
     "Demonstrate that governance accelerates delivery while maintaining appropriate risk controls."
    ],
    "evidence_examples": [
     "Policy-as-Code controls",
     "Automated approval gates",
     "Governance quality metrics",
     "Delivery flow analytics",
     "Automated compliance reporting",
     "Engineering effectiveness reviews ---"
    ]
   },
   {
    "level": 5,
    "name": "Optimizing",
    "description": "Governance functions as enabling guardrails, with autonomy supported by clear standards and automated controls.",
    "key_characteristics": [
     "Guardrails are automated and embedded into tooling.",
     "Policy logic enforces governance expectations through workflows and controls.",
     "Teams are empowered to make local decisions when readiness signals and evidence requirements are satisfied.",
     "Governance forums focus on organizational learning and standards evolution rather than case-by-case supervision.",
     "Continuous improvement is built into governance processes.",
     "Accountability is lightweight but highly visible through traceable approvals, ownership structures, and delivery evidence."
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
  "na_description": "Not applicable if the team does not own or operate software services, platforms, or infrastructure requiring system health monitoring, observability, or runtime security signals. This includes teams whose responsibilities are limited to business process operations, intake triage, or non-technical coordination. 【1-58c0fd】",
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
     "Collect at least one operational signal (metrics, logs, or alerts).",
     "Identify ownership for monitoring and incident response activities.",
     "Define basic operational health indicators.",
     "Demonstrate the ability to detect and investigate a service issue using collected telemetry."
    ],
    "evidence_examples": [
     "Monitoring dashboards",
     "Alert configurations",
     "Log aggregation tools",
     "Service ownership documentation",
     "Incident investigation records ---"
    ]
   },
   {
    "level": 1,
    "name": "Initial",
    "description": "System health visibility is minimal and reactive; issues are discovered after user impact. 【1-58c0fd】",
    "key_characteristics": [
     "Little health visibility exists.",
     "Issues are detected through user reports or manual checks rather than proactive monitoring.",
     "SLOs and SLIs are not defined.",
     "Alerts are absent, unreliable, or overly noisy.",
     "Troubleshooting depends on ad hoc log analysis.",
     "Monitoring data is fragmented across tools.",
     "Runtime security signals are not integrated into operational processes."
    ],
    "level_up_criteria": [
     "Implement monitoring across multiple critical services or environments.",
     "Define alerting thresholds for key operational conditions.",
     "Establish recurring reviews of monitoring and alert effectiveness.",
     "Track operational issues identified through monitoring.",
     "Begin centralizing operational data sources.",
     "Document response expectations for common operational events."
    ],
    "evidence_examples": [
     "Alert policies",
     "Dashboard inventories",
     "Operational runbooks",
     "Monitoring standards",
     "Incident records",
     "Platform health reports ---"
    ]
   },
   {
    "level": 2,
    "name": "Developing",
    "description": "Basic monitoring exists in some services, but coverage, alerting, and response vary widely. 【1-58c0fd】",
    "key_characteristics": [
     "Monitoring exists for selected systems but coverage is inconsistent.",
     "Metrics, logs, and traces are only partially implemented.",
     "Alerting reliability varies.",
     "Teams still depend on manual log review for diagnosis.",
     "Multiple monitoring tools exist without a unified operational view.",
     "Incident response is still largely manual.",
     "Runtime security events are captured inconsistently.",
     "Visibility gaps exist across environments or cloud accounts."
    ],
    "level_up_criteria": [
     "Define SLIs and SLOs for qualifying systems.",
     "Collect and retain required metrics, logs, and traces.",
     "Standardize monitoring expectations across critical services.",
     "Implement actionable alerting tied to service health objectives.",
     "Establish documented operational runbooks.",
     "Integrate observability requirements into operational readiness expectations."
    ],
    "evidence_examples": [
     "SLO and SLI documentation",
     "Standard observability requirements",
     "Runbooks",
     "Alerting standards",
     "Central observability dashboards",
     "Operational readiness reviews ---"
    ]
   },
   {
    "level": 3,
    "name": "Defined",
    "description": "Monitoring and observability expectations are documented and applied to critical services before promotion. 【1-58c0fd】",
    "key_characteristics": [
     "SLOs and SLIs are established for critical services.",
     "Metrics, logs, and traces are consistently collected.",
     "Operational signals are routed into approved observability platforms.",
     "Monitoring expectations are documented and standardized.",
     "Alert thresholds are aligned with service health goals.",
     "Runbooks support diagnosis and recovery.",
     "Runtime security events begin to be correlated with operational activity.",
     "Sensitive data handling requirements are incorporated into telemetry practices."
    ],
    "level_up_criteria": [
     "Measure operational performance using defined reliability indicators.",
     "Track MTTD, MTTR, incident trends, service reliability, and alert effectiveness.",
     "Correlate metrics, logs, traces, and security events.",
     "Review operational trends on a recurring cadence.",
     "Automate ticket creation, escalation, or operational workflows where appropriate.",
     "Use observability data to influence release, architecture, and operational decisions."
    ],
    "evidence_examples": [
     "Reliability dashboards",
     "Incident trend reporting",
     "ServiceNow integrations",
     "Alert quality reports",
     "Post-incident reviews",
     "Error budget reporting ---"
    ]
   },
   {
    "level": 4,
    "name": "Measured",
    "description": "Observability data is repeatable, correlated, and integrated into incident response and release decisions. 【1-58c0fd】",
    "key_characteristics": [
     "Reliability indicators are monitored over time.",
     "Incident trends are visible and actionable.",
     "Alerts create tickets and operational actions automatically.",
     "Operational and runtime security signals are correlated.",
     "Post-incident learning is embedded into operational workflows.",
     "Alert tuning is actively managed.",
     "Error budgets and reliability objectives influence engineering decisions.",
     "Operational data informs release readiness."
    ],
    "level_up_criteria": [
     "Implement predictive detection and anomaly identification capabilities.",
     "Automate correlation of operational, performance, and security signals.",
     "Automate selected incident response and recovery activities.",
     "Use observability data to proactively prevent customer or business impact.",
     "Demonstrate that reliability objectives influence engineering prioritization.",
     "Continuously refine monitoring, observability, and runtime security practices."
    ],
    "evidence_examples": [
     "Anomaly detection capabilities",
     "Automated remediation workflows",
     "Runtime security monitoring",
     "Predictive operational analytics",
     "Error budget governance",
     "Reliability engineering programs ---"
    ]
   },
   {
    "level": 5,
    "name": "Optimizing",
    "description": "Monitoring, observability, and runtime security operate as a predictive, prevention-oriented capability. 【1-58c0fd】",
    "key_characteristics": [
     "Predictive detection surfaces anomalies before customer impact occurs.",
     "Automated response actions reduce operational risk.",
     "Runtime security is integrated into operational workflows.",
     "Operational, security, and reliability signals share a unified view.",
     "Dashboards aggregate cloud, platform, and infrastructure telemetry.",
     "Continuous learning loops improve alert quality, reliability, and incident prevention.",
     "Error budgets guide release pacing and engineering priorities.",
     "Reliability engineering becomes a proactive discipline."
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
     "Establish ownership and support responsibilities for each environment.",
     "Document how environments are provisioned, accessed, and maintained.",
     "Define a basic promotion process between environments.",
     "Define a basic rollback approach for major deployments.",
     "Demonstrate repeatable environment setup procedures."
    ],
    "evidence_examples": [
     "Environment inventory",
     "Environment ownership documentation",
     "Provisioning procedures",
     "Deployment procedures",
     "Rollback documentation ---"
    ]
   },
   {
    "level": 1,
    "name": "Initial",
    "description": "Environments are manually managed and inconsistent, dependent on individual knowledge, leading to drift, rework, and unreliable validation.",
    "key_characteristics": [
     "Environments are configured manually and rely on individual knowledge rather than documented standards.",
     "Development environments may require CRQs or production-level approvals for routine work.",
     "Environment drift occurs between non-production and production environments.",
     "Teams are often forced to test in customer-facing environments.",
     "Promotion occurs through ad hoc coordination.",
     "Rollback depends on manual recovery procedures."
    ],
    "level_up_criteria": [
     "Establish baseline standards for environment configuration and management.",
     "Document environment promotion workflows.",
     "Reduce dependency on individual knowledge for environment setup and maintenance.",
     "Establish isolated development environments when possible.",
     "Identify environment inconsistencies and remediation activities.",
     "Begin standardizing provisioning activities."
    ],
    "evidence_examples": [
     "Environment standards",
     "Environment architecture documentation",
     "Promotion workflow documentation",
     "Development environment standards",
     "Environment remediation plans ---"
    ]
   },
   {
    "level": 2,
    "name": "Developing",
    "description": "Basic standards exist, but provisioning, refresh, and promotion practices vary widely across environments.",
    "key_characteristics": [
     "Partial environment standards are present.",
     "Environment setup differs across cloud, co-location, and on-prem environments.",
     "Development environments may still rely on production-style controls and approvals.",
     "Provisioning is partially automated.",
     "Refresh activities are manual and resource intensive.",
     "Environment drift remains common.",
     "Undocumented exceptions frequently occur."
    ],
    "level_up_criteria": [
     "Define a standard promotion path across environments.",
     "Establish readiness criteria for environment promotion.",
     "Demonstrate meaningful separation between development and customer-facing workloads.",
     "Define environment ownership and access management processes.",
     "Standardize environment provisioning procedures.",
     "Reduce environment variability through documented standards."
    ],
    "evidence_examples": [
     "Promotion path documentation",
     "Environment readiness checklists",
     "Environment lifecycle standards",
     "Access management controls",
     "Cloud landing zone standards",
     "Environment governance documentation ---"
    ]
   },
   {
    "level": 3,
    "name": "Defined",
    "description": "Environment management is documented and repeatable, with clear promotion paths and meaningful separation of development and customer-facing workloads.",
    "key_characteristics": [
     "Promotion paths are clearly defined.",
     "Standard progression exists across environments.",
     "Ownership and access management are documented.",
     "Development environments are isolated from production workloads.",
     "Provisioning processes are repeatable and consistent.",
     "Cloud landing zones or equivalent capabilities support environment creation.",
     "Readiness criteria are defined and enforced."
    ],
    "level_up_criteria": [
     "Automate provisioning and configuration management where appropriate.",
     "Monitor environment health, availability, and configuration consistency.",
     "Track environment drift and remediation activities.",
     "Instrument promotion workflows with observable readiness indicators.",
     "Validate rollback approaches through testing or rehearsal.",
     "Demonstrate operational visibility across managed environments."
    ],
    "evidence_examples": [
     "Automated provisioning workflows",
     "Environment health dashboards",
     "Drift reports",
     "Promotion tracking",
     "Rollback testing records",
     "Environment observability metrics ---"
    ]
   },
   {
    "level": 4,
    "name": "Measured",
    "description": "Provisioning, configuration, and promotion are automated and monitored, with drift and environment health tracked for predictability.",
    "key_characteristics": [
     "Provisioning and configuration activities are automated.",
     "Environment setup variation is reduced.",
     "Environment drift is measured and monitored.",
     "Health indicators are tracked across environments.",
     "Promotion workflows provide visibility into validation activities.",
     "Rollback approaches are tested and rehearsed.",
     "Environment reliability supports predictable delivery."
    ],
    "level_up_criteria": [
     "Manage environments through Configuration-as-Code practices.",
     "Implement automated drift detection and remediation.",
     "Support self-service provisioning capabilities.",
     "Automate lifecycle activities such as environment refresh and cleanup.",
     "Automate rollback and recovery workflows where feasible.",
     "Demonstrate continuous optimization of environment management practices."
    ],
    "evidence_examples": [
     "Infrastructure-as-Code repositories",
     "Configuration-as-Code standards",
     "Automated drift remediation",
     "Self-service environment provisioning",
     "Automated refresh workflows",
     "Environment lifecycle automation ---"
    ]
   },
   {
    "level": 5,
    "name": "Optimizing",
    "description": "Environments are self-service, Configuration-as-Code driven, and continuously remediated through automated controls.",
    "key_characteristics": [
     "Configuration-as-Code governs environment definitions.",
     "Environment consistency is enforced through automation.",
     "Drift is automatically detected and remediated.",
     "Self-service provisioning supports rapid environment creation.",
     "Environment lifecycle management is automated.",
     "Cleanup, refresh, promotion, and rollback workflows are automated.",
     "Environment management scales without significant operational overhead."
    ],
    "level_up_criteria": [],
    "evidence_examples": []
   }
  ]
 },
 {
  "id": "12",
  "title": "Release Management & Operational Reliability",
  "definition": "Documented, automated, and tested operational processes—including runbooks, rollback procedures, readiness checks, incident learnings, and reliability engineering—to ensure predictable, resilient, production-safe delivery.",
  "na_description": "This dimension does not apply if the team does not operate services or participate in production-related support, readiness, rollback, or operational processes.",
  "levels": [
   {
    "level": 0,
    "name": "Below Baseline",
    "description": "Operational delivery is manual, undocumented, and reactive, with no established runbooks, readiness checks, or rollback procedures.",
    "key_characteristics": [
     "None. Production readiness, recovery, and operational support are largely improvised and dependent on individual response."
    ],
    "level_up_criteria": [
     "Document basic operational support procedures.",
     "Identify ownership for operational readiness, support, and recovery activities.",
     "Create an initial runbook for a critical service or workflow.",
     "Define a basic rollback approach.",
     "Establish a basic production readiness checklist.",
     "Begin documenting incident learnings when failures occur."
    ],
    "evidence_examples": [
     "Operational procedures",
     "Production support documentation",
     "Initial runbooks",
     "Rollback instructions",
     "Incident notes",
     "Readiness checklists ---"
    ]
   },
   {
    "level": 1,
    "name": "Initial",
    "description": "Operational delivery relies on informal knowledge, manual intervention, and reactive support.",
    "key_characteristics": [
     "Runbooks are limited, informal, or not maintained.",
     "Readiness checks occur through individual judgment.",
     "Rollback approaches are unclear and performed ad hoc.",
     "Incident learning is informal and largely undocumented.",
     "Troubleshooting depends heavily on individual expertise.",
     "Operational activities are highly manual."
    ],
    "level_up_criteria": [
     "Create runbooks for recurring operational activities.",
     "Establish standard readiness checklists before production changes.",
     "Document rollback procedures for critical services.",
     "Begin capturing incident learnings consistently.",
     "Standardize execution of common operational activities.",
     "Establish expectations for production communication and coordination."
    ],
    "evidence_examples": [
     "Runbooks",
     "Readiness checklists",
     "Rollback documentation",
     "Incident review logs",
     "Operational procedures",
     "Production communication templates ---"
    ]
   },
   {
    "level": 2,
    "name": "Developing",
    "description": "Basic operational documentation exists, but completeness, accuracy, and adoption vary.",
    "key_characteristics": [
     "Runbooks exist but may be outdated or inconsistently used.",
     "Readiness checklists are available but do not consistently govern production readiness decisions.",
     "Rollback procedures are documented but rarely rehearsed.",
     "Incident learnings are captured but often fail to drive long-term improvements.",
     "Operational processes vary between individuals and teams.",
     "Environment drift and documentation drift create inconsistencies."
    ],
    "level_up_criteria": [
     "Establish maintained runbooks with clear ownership.",
     "Define readiness criteria covering environment health, service validation, and deployment readiness.",
     "Validate rollback procedures within non-production environments.",
     "Standardize operational workflows and escalation paths.",
     "Establish formal post-incident learning activities.",
     "Define required communication activities for significant operational events and production changes."
    ],
    "evidence_examples": [
     "Maintained runbooks",
     "Readiness standards",
     "Rollback validation records",
     "Escalation procedures",
     "Post-incident review documents",
     "Customer communication procedures ---"
    ]
   },
   {
    "level": 3,
    "name": "Defined",
    "description": "Operational practices are documented, repeatable, and consistently applied for critical services.",
    "key_characteristics": [
     "Runbooks are maintained and include clear execution criteria.",
     "Readiness criteria cover environment health, configuration baselines, and service validation.",
     "Rollback procedures are validated in non-production environments.",
     "Incident learning includes ownership and corrective actions.",
     "Operational processes are standardized.",
     "Handoffs are clear and less dependent on individual expertise.",
     "Communication expectations are incorporated into operational practices."
    ],
    "level_up_criteria": [
     "Validate runbook execution through exercises, simulations, or automation.",
     "Measure readiness effectiveness and rollback effectiveness.",
     "Track operational reliability indicators.",
     "Analyze operational trends and recurring issues.",
     "Reduce repetitive operational activities through automation.",
     "Use operational metrics to drive service reliability improvements."
    ],
    "evidence_examples": [
     "Operational simulations",
     "Runbook execution testing",
     "Reliability dashboards",
     "Readiness outcome reports",
     "Rollback effectiveness reporting",
     "Operational automation workflows ---"
    ]
   },
   {
    "level": 4,
    "name": "Measured",
    "description": "Operational practices are tested, automated where practical, and measured using reliability indicators.",
    "key_characteristics": [
     "Runbook execution is validated through exercises, simulations, or automation.",
     "Readiness effectiveness is measured.",
     "Rollback effectiveness is monitored.",
     "Incident trends are analyzed.",
     "Alert fatigue and operational noise are actively addressed.",
     "Operational reliability metrics are tracked.",
     "Automation reduces repetitive or error-prone work."
    ],
    "level_up_criteria": [
     "Use telemetry and operational insights to continuously improve operational procedures.",
     "Automate rollback where appropriate.",
     "Automate readiness validation activities.",
     "Implement resilience engineering practices that prevent recurring failures.",
     "Continuously improve operational communication effectiveness.",
     "Demonstrate operational processes that proactively reduce production risk."
    ],
    "evidence_examples": [
     "Telemetry-driven runbook improvements",
     "Automated rollback capabilities",
     "Automated readiness validations",
     "Reliability engineering programs",
     "Resilience improvement initiatives",
     "Communication effectiveness metrics ---"
    ]
   },
   {
    "level": 5,
    "name": "Optimizing",
    "description": "Reliability engineering is embedded into delivery and operations, driving continuous improvement.",
    "key_characteristics": [
     "Runbooks evolve using telemetry, incident learnings, and operational feedback.",
     "Rollback capabilities are automated and predictable.",
     "Readiness checks proactively identify issues before production impact.",
     "Incident learning continuously improves resilience.",
     "Reliability engineering principles are integrated into delivery processes.",
     "Operational practices align with observability, environment management, and resilience objectives.",
     "Production risk is reduced through preventive controls rather than reactive response."
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
     "Establish at least one reusable asset, template, or shared component.",
     "Document the purpose and intended usage of reusable assets.",
     "Make reusable assets available to more than one team or project.",
     "Assign ownership for maintaining reusable assets."
    ],
    "evidence_examples": [
     "Shared templates",
     "Reusable scripts",
     "Common component libraries",
     "Published repository assets",
     "Platform ownership documentation ---"
    ]
   },
   {
    "level": 1,
    "name": "Initial",
    "description": "Reuse is minimal and guidance is hard to find, leading to duplicate solutions and inconsistent patterns.",
    "key_characteristics": [
     "Reusable assets are scarce.",
     "Published templates, components, and golden paths are limited or unavailable.",
     "Discovery is difficult and relies on tribal knowledge.",
     "Guidance is fragmented across repositories, wikis, and documentation.",
     "Teams frequently implement similar solutions independently.",
     "Refactoring toward reusable solutions is deprioritized in favor of immediate delivery."
    ],
    "level_up_criteria": [
     "Publish reusable assets in a common location.",
     "Introduce starter templates or shared engineering components.",
     "Document intended usage and applicability.",
     "Encourage reuse across multiple teams or services.",
     "Establish basic versioning and maintenance practices.",
     "Reduce duplication in selected engineering workflows."
    ],
    "evidence_examples": [
     "Shared repositories",
     "Internal templates",
     "Common engineering patterns",
     "Reusable infrastructure modules",
     "Internal developer documentation ---"
    ]
   },
   {
    "level": 2,
    "name": "Developing",
    "description": "Some reusable assets exist, but adoption is voluntary and frequently customized or recreated.",
    "key_characteristics": [
     "Starter templates are available.",
     "Adoption depends on awareness and individual initiative.",
     "Teams frequently fork or customize reusable assets.",
     "Documentation is inconsistent or incomplete.",
     "Applicability and prerequisites are unclear.",
     "Versioning and lifecycle management are weak.",
     "Compatibility issues emerge as assets diverge."
    ],
    "level_up_criteria": [
     "Publish documented golden paths.",
     "Establish clear guidance on when and how reusable assets should be used.",
     "Curate reusable assets through centralized repositories or catalogs.",
     "Implement versioning and maintenance standards.",
     "Define customization boundaries.",
     "Align reusable assets to engineering standards and delivery practices."
    ],
    "evidence_examples": [
     "Golden path documentation",
     "Component catalogs",
     "Versioned platform templates",
     "Decision trees",
     "Platform standards",
     "Reuse guidance documentation ---"
    ]
   },
   {
    "level": 3,
    "name": "Defined",
    "description": "Reusable patterns are documented, discoverable, and aligned to standard engineering practices with clear usage guidance.",
    "key_characteristics": [
     "Golden paths are published and maintained.",
     "Prerequisites and usage guidance are clearly documented.",
     "Reusable assets are discoverable through centralized indexes or catalogs.",
     "Templates and shared components are versioned.",
     "Engineering standards are reflected in reusable patterns.",
     "Guidance clearly explains customization and extension boundaries.",
     "Reuse contributes to consistency across engineering teams."
    ],
    "level_up_criteria": [
     "Measure adoption of reusable assets.",
     "Track platform usage and variance from preferred patterns.",
     "Establish feedback loops for improving reusable assets.",
     "Implement contribution and governance processes.",
     "Monitor duplication and identify opportunities for consolidation.",
     "Demonstrate measurable benefits from reuse."
    ],
    "evidence_examples": [
     "Adoption dashboards",
     "Usage analytics",
     "Governance workflows",
     "Contribution standards",
     "Pattern improvement backlog",
     "Duplication analysis ---"
    ]
   },
   {
    "level": 4,
    "name": "Measured",
    "description": "Reuse is actively promoted, measured, and improved through feedback loops that reduce variance.",
    "key_characteristics": [
     "Adoption of templates, patterns, and components is measured.",
     "Real-world usage data informs improvement priorities.",
     "Feedback loops refine documentation and implementation patterns.",
     "Governance processes define approval, contribution, and deprecation activities.",
     "Duplication is reduced through preferred patterns.",
     "Platform investments are informed by measurable demand."
    ],
    "level_up_criteria": [
     "Enable self-service consumption of platform capabilities.",
     "Implement telemetry-driven evolution of reusable assets.",
     "Support scalable contribution and maintenance workflows.",
     "Continuously improve onboarding experiences.",
     "Automate compatibility and policy validation where appropriate.",
     "Demonstrate measurable improvements in speed, consistency, and engineering productivity."
    ],
    "evidence_examples": [
     "Self-service onboarding experiences",
     "Usage telemetry",
     "Platform analytics",
     "Automated compatibility checks",
     "Contribution automation",
     "Platform effectiveness reporting ---"
    ]
   },
   {
    "level": 5,
    "name": "Optimizing",
    "description": "Reusability operates as a platform capability offering well-governed, self-service patterns that evolve with measurable demand and outcomes.",
    "key_characteristics": [
     "Self-service consumption is the default experience.",
     "Discovery and onboarding are streamlined.",
     "Patterns evolve based on telemetry and operational feedback.",
     "Contribution models support safe extension without fragmentation.",
     "Compatibility is managed proactively.",
     "Golden paths accelerate delivery and improve consistency.",
     "Platform capabilities continuously evolve to meet engineering demand."
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
  "na_description": "This dimension is not applicable if the team does not build, configure, modify, or deliver technical solutions that require engineering discipline, automation, or consistent development practices.",
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
     "Identify repetitive manual activities suitable for automation.",
     "Begin documenting engineering practices and workflows.",
     "Introduce version control and repeatable engineering processes where applicable.",
     "Promote awareness of modern SDLC and automation concepts.",
     "Demonstrate at least one example of engineering work treated as reusable rather than one-off."
    ],
    "evidence_examples": [
     "Engineering standards",
     "Team operating agreements",
     "Version-controlled assets",
     "Process documentation",
     "Automation opportunities backlog ---"
    ]
   },
   {
    "level": 1,
    "name": "Initial",
    "description": "Work relies on manual effort and individual expertise, with limited evidence of modern engineering or automation-first behaviors.",
    "key_characteristics": [
     "Engineering mindset varies, with work frequently approached as one-off tasks rather than reusable, iterative improvements.",
     "Automation is limited, with manual execution common and ClickOps patterns still present.",
     "Standards are applied inconsistently.",
     "Developer enablement is minimal.",
     "Knowledge is siloed.",
     "Improvement efforts are largely reactive."
    ],
    "level_up_criteria": [
     "Adopt basic engineering principles across a majority of team members.",
     "Establish knowledge-sharing practices.",
     "Begin reducing manual effort using repeatable tools or automation.",
     "Encourage consistent use of shared platforms and tooling.",
     "Introduce shift-left behaviors such as earlier testing, validation, or security activities.",
     "Document common engineering practices and expectations."
    ],
    "evidence_examples": [
     "Shared engineering documentation",
     "Team onboarding materials",
     "Knowledge-sharing sessions",
     "Automation initiatives",
     "Common tooling standards ---"
    ]
   },
   {
    "level": 2,
    "name": "Developing",
    "description": "Modern engineering practices are recognized as important, but adoption remains uneven or isolated.",
    "key_characteristics": [
     "Automation exists in pockets.",
     "Manual work remains common.",
     "Engineering principles are referenced but inconsistently applied.",
     "Shared tooling adoption varies.",
     "Documentation remains fragmented.",
     "Shift-left behaviors occur inconsistently.",
     "Engineering maturity differs significantly across contributors."
    ],
    "level_up_criteria": [
     "Establish automation-first expectations.",
     "Define engineering work as code where appropriate (configuration, scripting, infrastructure, pipelines).",
     "Standardize adoption of shared tooling and engineering platforms.",
     "Publish discoverable documentation and team standards.",
     "Incorporate continuous improvement activities into planning and retrospectives.",
     "Reduce reliance on ad hoc manual execution patterns."
    ],
    "evidence_examples": [
     "Team engineering playbook",
     "Shared automation standards",
     "Platform usage guidance",
     "Retrospective improvement backlog",
     "Developer onboarding content ---"
    ]
   },
   {
    "level": 3,
    "name": "Defined",
    "description": "Modern engineering principles and automation-first behaviors are consistently applied and reinforced through team norms.",
    "key_characteristics": [
     "Automation-first behaviors reduce manual work.",
     "Shared expectations exist that engineering work should be treated as code where applicable.",
     "Reusable practices are maintained and encouraged.",
     "Documentation is predictable and discoverable.",
     "Continuous improvement is part of normal team operations.",
     "Engineering identity is shared across the team rather than isolated to specific contributors."
    ],
    "level_up_criteria": [
     "Establish metrics related to automation adoption and engineering effectiveness.",
     "Track manual intervention frequency and recurring friction points.",
     "Provide coaching and structured enablement opportunities.",
     "Use retrospectives, telemetry, and operational signals to identify improvement opportunities.",
     "Measure adoption of engineering practices.",
     "Demonstrate improvements based on observed team behavior."
    ],
    "evidence_examples": [
     "Engineering health metrics",
     "Coaching programs",
     "Platform adoption reports",
     "Retrospective improvement tracking",
     "Team capability assessments ---"
    ]
   },
   {
    "level": 4,
    "name": "Measured",
    "description": "Engineering behaviors are supported by metrics, coaching, and feedback loops that strengthen automation and reduce manual work.",
    "key_characteristics": [
     "Data guides engineering improvements.",
     "Coaching supports adoption of engineering practices.",
     "Manual work is systematically identified and targeted.",
     "Friction is surfaced and addressed.",
     "Developer enablement is intentional and structured.",
     "Engineering culture improvements are measurable."
    ],
    "level_up_criteria": [
     "Proactively identify and automate manual activities.",
     "Contribute reusable patterns, templates, or platform assets.",
     "Establish mentorship programs supporting engineering growth.",
     "Use operational, delivery, and quality signals to evolve engineering practices.",
     "Demonstrate continuous improvement in engineering maturity.",
     "Embed automation and engineering excellence into team culture."
    ],
    "evidence_examples": [
     "Automation adoption programs",
     "Golden path contributions",
     "Mentorship frameworks",
     "Engineering maturity assessments",
     "Platform contribution records",
     "Continuous improvement metrics ---"
    ]
   },
   {
    "level": 5,
    "name": "Optimizing",
    "description": "Automation and engineering excellence are embedded into team culture and continuously improved.",
    "key_characteristics": [
     "Automation is proactive rather than reactive.",
     "Teams continuously convert manual activities into repeatable workflows.",
     "Engineering patterns are codified and shared.",
     "Mentorship reinforces engineering practices.",
     "Continuous improvement is a cultural norm.",
     "Automation-first behaviors span development, infrastructure, configuration, and operations work.",
     "Modern engineering principles are sustained through coaching, standards, and platform enablement."
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
     "None. Work enters the system unpredictably and execution relies primarily on ad hoc requests, interruptions, and informal coordination."
    ],
    "level_up_criteria": [
     "Establish a single location to track work.",
     "Define a basic intake process for new requests.",
     "Document ownership for planning and prioritization activities.",
     "Begin maintaining a backlog of planned and active work.",
     "Differentiate between planned work and operational interruptions.",
     "Create visibility into current priorities."
    ],
    "evidence_examples": [
     "Backlog tool",
     "Intake process",
     "Team work board",
     "Prioritization list",
     "Work tracking repository ---"
    ]
   },
   {
    "level": 1,
    "name": "Initial",
    "description": "Work is reactive and intake is informal, with limited visibility into priorities or differentiation between planned work and operational interruptions.",
    "key_characteristics": [
     "Work is tracked inconsistently.",
     "Requests arrive through chat, email, meetings, and other informal channels.",
     "Backlog visibility is limited.",
     "Priorities frequently shift.",
     "Operational interrupts compete with planned work.",
     "Refinement activities are inconsistent.",
     "Little shared understanding of future work exists."
    ],
    "level_up_criteria": [
     "Establish and maintain a structured backlog.",
     "Define basic work item standards.",
     "Conduct regular backlog refinement sessions.",
     "Document prioritization criteria.",
     "Improve visibility into active and upcoming work.",
     "Introduce repeatable planning routines."
    ],
    "evidence_examples": [
     "Product backlog",
     "Refinement sessions",
     "Prioritization framework",
     "Sprint planning artifacts",
     "Kanban board ---"
    ]
   },
   {
    "level": 2,
    "name": "Developing",
    "description": "Basic agile practices exist, but refinement, prioritization, and execution discipline vary across efforts.",
    "key_characteristics": [
     "A backlog exists but quality varies.",
     "Work items may lack acceptance criteria or clear outcomes.",
     "Refinement occurs but inconsistently.",
     "Prioritization often responds to near-term pressures.",
     "Sprint and Kanban practices vary by team or initiative.",
     "Documentation remains fragmented.",
     "Visibility continues to improve but remains incomplete."
    ],
    "level_up_criteria": [
     "Define backlog standards and readiness expectations.",
     "Establish predictable refinement and planning cadences.",
     "Create consistent prioritization norms.",
     "Standardize execution workflows.",
     "Define work-in-progress expectations.",
     "Maintain clear visibility into commitments and delivery plans."
    ],
    "evidence_examples": [
     "Definition of Ready",
     "Backlog standards",
     "Refinement cadence",
     "Sprint planning artifacts",
     "WIP policies",
     "Delivery commitments ---"
    ]
   },
   {
    "level": 3,
    "name": "Defined",
    "description": "Planning and backlog management are documented, repeatable, and aligned to transparent team-level routines.",
    "key_characteristics": [
     "The backlog is structured and actively maintained.",
     "Work items contain clear definitions, acceptance criteria, and outcomes.",
     "Refinement is predictable and recurring.",
     "Prioritization follows agreed decision frameworks.",
     "Sprint or flow-based execution practices are stable.",
     "Stakeholders can understand commitments and priorities.",
     "Planned and interrupt-driven work are visible."
    ],
    "level_up_criteria": [
     "Measure planning effectiveness and delivery predictability.",
     "Track flow-based metrics such as cycle time, lead time, throughput, and WIP.",
     "Monitor planned versus delivered work.",
     "Identify and manage dependencies.",
     "Use delivery data to improve planning decisions.",
     "Create action-oriented retrospectives that improve backlog and planning practices."
    ],
    "evidence_examples": [
     "Velocity metrics",
     "Burndown charts",
     "Cycle time reporting",
     "Lead time reporting",
     "Throughput dashboards",
     "Dependency tracking",
     "Retrospective action tracking ---"
    ]
   },
   {
    "level": 4,
    "name": "Measured",
    "description": "Planning and execution are measured using flow, predictability, throughput, dependency, and delivery health indicators.",
    "key_characteristics": [
     "Flow metrics are actively used.",
     "Predictability is measured and discussed.",
     "Capacity balance is monitored.",
     "Interrupt load is visible.",
     "Dependencies influence planning decisions.",
     "Blocked work and aging items are tracked.",
     "Retrospectives drive measurable improvements."
    ],
    "level_up_criteria": [
     "Use objective prioritization methods to optimize value delivery.",
     "Continuously improve flow using operational and delivery telemetry.",
     "Adjust planning dynamically using real-time insights.",
     "Balance operational work against strategic investment.",
     "Connect planning decisions to organizational outcomes.",
     "Demonstrate continuous value management rather than periodic planning."
    ],
    "evidence_examples": [
     "Value prioritization framework",
     "Flow optimization initiatives",
     "Dependency analytics",
     "Outcome tracking",
     "Strategic alignment reporting",
     "Delivery effectiveness dashboards ---"
    ]
   },
   {
    "level": 5,
    "name": "Optimizing",
    "description": "Agile planning functions as a continuous value-management capability that maximizes flow and strategic impact.",
    "key_characteristics": [
     "Prioritization is data-driven.",
     "Impact, risk, effort, operational load, and dependencies influence sequencing decisions.",
     "Teams continuously optimize flow.",
     "Scope and commitments adapt using current information.",
     "Strategic outcomes are visible in backlog decisions.",
     "Continuous value management is part of team culture.",
     "Delivery decisions balance short-term execution and long-term value."
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
  "na_description": "This dimension does not apply if the team does not make technical or architectural decisions (e.g., purely operational support without design, development, or configuration authority).",
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
     "Define who can make and approve technical decisions.",
     "Document major technical decisions in a repeatable manner.",
     "Create baseline architecture and solution standards.",
     "Capture rationale for significant technology choices.",
     "Establish a shared location for technical guidance."
    ],
    "evidence_examples": [
     "Architecture standards",
     "Solution design documentation",
     "Technical decision logs",
     "Architecture review meeting notes",
     "Engineering guidance repositories ---"
    ]
   },
   {
    "level": 1,
    "name": "Initial",
    "description": "Technical decisions are made informally, inconsistently documented, and dependent on individual experience.",
    "key_characteristics": [
     "Standards are minimally documented.",
     "Decisions are often driven by individual preference, experience, or familiarity.",
     "Decision rationale is rarely captured.",
     "Review expectations are unclear.",
     "Architecture and security reviews occur inconsistently.",
     "Patterns vary significantly between services and teams.",
     "Evidence is fragmented across tools and repositories."
    ],
    "level_up_criteria": [
     "Establish reference architecture patterns.",
     "Begin capturing Architectural Decision Records (ADRs) or equivalent documentation.",
     "Define minimum review expectations.",
     "Incorporate architecture and security perspectives into design discussions.",
     "Improve consistency of decision documentation.",
     "Document dependencies between systems and services."
    ],
    "evidence_examples": [
     "Reference architectures",
     "ADR templates",
     "Design review records",
     "Architecture principles",
     "Dependency inventories ---"
    ]
   },
   {
    "level": 2,
    "name": "Developing",
    "description": "Some design standards or review practices exist, but adoption and documentation vary by system or stakeholder.",
    "key_characteristics": [
     "Reference patterns are available but not consistently applied.",
     "ADR adoption is partial.",
     "Design reviews occur inconsistently.",
     "Security reviews are often reactive.",
     "Dependency relationships remain unclear.",
     "Decision artifacts vary in quality and completeness.",
     "Design governance differs across teams and initiatives."
    ],
    "level_up_criteria": [
     "Define architecture and design standards.",
     "Standardize use of ADRs or equivalent decision frameworks.",
     "Establish formal design review processes.",
     "Define review entry and exit criteria.",
     "Require documentation of alternatives, constraints, risks, and rationale.",
     "Ensure decisions are traceable to requirements and business needs."
    ],
    "evidence_examples": [
     "Architecture standards",
     "Design review procedures",
     "ADR repositories",
     "Review criteria documentation",
     "Requirement traceability artifacts ---"
    ]
   },
   {
    "level": 3,
    "name": "Defined",
    "description": "Design standards, review practices, and decision records are documented and consistently applied for meaningful technical choices.",
    "key_characteristics": [
     "Standards exist for architecture, APIs, data models, configuration, and Infrastructure-as-Code.",
     "ADRs capture rationale, alternatives, tradeoffs, risks, and approvals.",
     "Architecture and design reviews occur predictably.",
     "Security and platform stakeholders participate appropriately.",
     "Shared patterns are reused.",
     "Decision traceability is maintained.",
     "Design guidance improves consistency across engineering efforts."
    ],
    "level_up_criteria": [
     "Measure compliance with design standards.",
     "Evaluate the quality and consistency of decision records.",
     "Monitor deviations from approved patterns.",
     "Incorporate threat modeling and risk evaluation earlier in the lifecycle.",
     "Assess design decisions against implementation and operational outcomes.",
     "Establish feedback loops for standards and review processes."
    ],
    "evidence_examples": [
     "Architecture governance metrics",
     "ADR quality reviews",
     "Standards compliance reporting",
     "Threat modeling artifacts",
     "Design review scorecards",
     "Pattern adoption metrics ---"
    ]
   },
   {
    "level": 4,
    "name": "Measured",
    "description": "Technical decision practices are governed and assessed for quality, consistency, risk reduction, and implementation outcomes.",
    "key_characteristics": [
     "Decision quality is evaluated.",
     "Architecture consistency is measurable.",
     "Pattern adoption is monitored.",
     "Security input is integrated early.",
     "Design decisions are connected to operational outcomes.",
     "Standards evolve through measurable feedback.",
     "Governance activities focus on reducing risk and increasing consistency."
    ],
    "level_up_criteria": [
     "Continuously evolve standards based on operational outcomes and telemetry.",
     "Use prior decision history to inform future architectural decisions.",
     "Embed governance controls into engineering workflows.",
     "Scale architectural guidance through reusable patterns and golden paths.",
     "Reduce unnecessary review overhead through automated guardrails.",
     "Demonstrate improved outcomes resulting from design governance practices."
    ],
    "evidence_examples": [
     "Architectural analytics",
     "Design telemetry",
     "Golden path libraries",
     "Governance automation",
     "Outcome-based design metrics",
     "Engineering effectiveness reporting ---"
    ]
   },
   {
    "level": 5,
    "name": "Optimizing",
    "description": "Technical decision-making operates as a mature engineering capability, balancing autonomy with architectural guardrails.",
    "key_characteristics": [
     "Patterns are curated and continuously refined.",
     "Decision intelligence leverages prior ADRs and outcomes.",
     "Governance guardrails are embedded in platforms and delivery workflows.",
     "Teams retain autonomy within approved boundaries.",
     "Architecture guidance is highly discoverable.",
     "Decision traceability is streamlined and accessible.",
     "Engineering outcomes continuously improve through design learning."
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
     "Establish a recurring review cadence.",
     "Create visibility into team performance data.",
     "Define metric ownership.",
     "Begin collecting baseline measurements.",
     "Demonstrate use of metrics in at least one team discussion or decision."
    ],
    "evidence_examples": [
     "Team dashboards",
     "Metrics reports",
     "Engineering scorecards",
     "Management reviews",
     "Baseline metric collection ---"
    ]
   },
   {
    "level": 1,
    "name": "Initial",
    "description": "Some metrics exist, but collection is inconsistent and they are rarely used to drive behavior or decisions.",
    "key_characteristics": [
     "Metrics are collected sporadically.",
     "Different teams track different measures.",
     "Data quality is inconsistent.",
     "Reviews occur only when issues arise.",
     "Metrics are often reported but not acted upon.",
     "Improvement activities remain largely reactive."
    ],
    "level_up_criteria": [
     "Define standard engineering metrics.",
     "Establish recurring metric reviews.",
     "Improve data quality and consistency.",
     "Align metrics to team objectives.",
     "Track engineering outcomes over time.",
     "Begin using metrics during planning and retrospectives."
    ],
    "evidence_examples": [
     "Standard metric catalog",
     "Team scorecards",
     "Weekly or sprint reviews",
     "Trend reporting",
     "Retrospective artifacts ---"
    ]
   },
   {
    "level": 2,
    "name": "Developing",
    "description": "Metrics are collected and reviewed, but adoption, interpretation, and usage vary across teams.",
    "key_characteristics": [
     "Standard metrics exist but are interpreted inconsistently.",
     "Trends are visible but not always actionable.",
     "Engineering decisions are only partially data driven.",
     "Dashboards may exist without clear ownership.",
     "Metrics focus on reporting rather than improvement.",
     "Teams struggle to connect metrics to desired outcomes."
    ],
    "level_up_criteria": [
     "Define engineering metrics that align with delivery goals.",
     "Establish ownership for metric review and actions.",
     "Create dashboards that support engineering decisions.",
     "Connect metrics to continuous improvement activities.",
     "Use metrics during retrospectives and planning.",
     "Document actions resulting from observed trends."
    ],
    "evidence_examples": [
     "Engineering dashboards",
     "Trend analysis",
     "Improvement backlogs",
     "Metric-to-goal mappings",
     "Operational reviews ---"
    ]
   },
   {
    "level": 3,
    "name": "Defined",
    "description": "Engineering metrics are documented, consistently reviewed, and used to support team-level decision making.",
    "key_characteristics": [
     "Teams understand their metrics.",
     "Dashboards provide actionable visibility.",
     "Trends drive improvement discussions.",
     "Improvement actions are documented.",
     "Metrics are reviewed regularly.",
     "Engineering goals are linked to measurable outcomes.",
     "Decision making increasingly uses evidence rather than intuition."
    ],
    "level_up_criteria": [
     "Measure improvement effectiveness over time.",
     "Track engineering health, quality, reliability, and delivery performance.",
     "Monitor leading and lagging indicators.",
     "Evaluate achievement of improvement goals.",
     "Use metrics to identify systemic constraints and bottlenecks.",
     "Demonstrate measurable improvements resulting from data-driven actions."
    ],
    "evidence_examples": [
     "DORA metrics",
     "Reliability metrics",
     "Engineering health reports",
     "Improvement tracking",
     "Trend dashboards",
     "KPI reviews ---"
    ]
   },
   {
    "level": 4,
    "name": "Measured",
    "description": "Engineering, operational, and delivery metrics are actively used to improve outcomes and guide decisions.",
    "key_characteristics": [
     "Teams track performance trends over time.",
     "Improvement efforts are measurable.",
     "Metrics influence prioritization and planning.",
     "Quality, reliability, throughput, and delivery health are visible.",
     "Data helps identify bottlenecks and risks.",
     "Engineering leaders use metrics to guide investments and improvements.",
     "Continuous improvement activities become measurable and predictable."
    ],
    "level_up_criteria": [
     "Use predictive indicators to identify future risks or opportunities.",
     "Integrate delivery, quality, operational, and engineering metrics into a unified view.",
     "Continuously optimize workflows using telemetry and trend analysis.",
     "Establish organization-wide learning from metrics.",
     "Demonstrate sustained improvement across multiple metric categories.",
     "Connect engineering outcomes directly to business and mission outcomes."
    ],
    "evidence_examples": [
     "Predictive analytics",
     "Engineering effectiveness platforms",
     "Portfolio health dashboards",
     "Value-stream analytics",
     "Reliability forecasts",
     "Outcome-based reporting ---"
    ]
   },
   {
    "level": 5,
    "name": "Optimizing",
    "description": "Engineering metrics operate as a continuous learning and optimization capability that drives strategic, operational, and engineering decisions.",
    "key_characteristics": [
     "Metrics are deeply integrated into engineering culture.",
     "Teams proactively identify improvement opportunities.",
     "Leading indicators help prevent future problems.",
     "Engineering effectiveness is continuously optimized.",
     "Teams balance quality, reliability, speed, and sustainability using shared data.",
     "Metrics drive strategic as well as team-level decisions.",
     "Continuous improvement is evidence-based and highly visible."
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

/** What assessment-content.ts needs from the rubric to write level names and titles. */
const contentContext = (): ContentContext => ({
  levelName: (dimensionId, level) => levelName(dimensionId, level),
  title: (dimensionId) => rubricDimension(dimensionId)?.title ?? dimensionId,
  dimensionIds: DIMENSION_IDS,
});

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
  "assessment_lead": "Jonas Lindqvist",
  "contacts": [
   "deepa.natarajan@example.com",
   "idris.diallo@example.com"
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
  "archetype": null,
  "rubric_version": "v1",
  "exceptions": [
   {
    "dimension_id": "6",
    "status": "approved",
    "source": "known_exception",
    "reason": "Security testing for the payments repositories is owned and run by Application Security's central gate (SAST, dependency and DAST scans on every merge), so the team has no testing of its own to score.",
    "approved_by": "Jonas Lindqvist",
    "approved_at": at(240)
   },
   {
    "dimension_id": "7",
    "status": "requested",
    "source": "manual",
    "reason": "Team states their only job is an internal overnight reconciliation batch with no internet-facing service, and asks for N/A on performance and reliability testing.",
    "approved_by": "",
    "approved_at": ""
   }
  ],
  "created_at": daysAgo(45),
  "updated_at": daysAgo(2),
  "contributors": [
   {
    "initials": "DN",
    "name": "Deepa Natarajan"
   },
   {
    "initials": "ID",
    "name": "Idris Diallo"
   },
   {
    "initials": "AN",
    "name": "Asha Nair"
   }
  ]
 },
 {
  "id": "TEAM-002",
  "name": "Kubernetes Operator",
  "cohort": "general",
  "workflow_step": 5,
  "assessment_lead": "Jonas Lindqvist",
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
    "initials": "LR",
    "name": "Lucia Romero"
   }
  ]
 },
 {
  "id": "TEAM-003",
  "name": "Checkout Experience",
  "cohort": "self_service",
  "workflow_step": 3,
  "assessment_lead": "Asha Nair",
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
  "assessment_lead": "Farah Osei",
  "contacts": [
   "elena.marsh@example.com",
   "bruno.vega@example.com"
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
    "initials": "BV",
    "name": "Bruno Vega"
   }
  ]
 },
 {
  "id": "TEAM-005",
  "name": "Notifications Service",
  "cohort": "general",
  "workflow_step": 2,
  "assessment_lead": "Farah Osei",
  "contacts": [
   "martina.kovacs@example.com"
  ],
  "repos": [],
  "archetype": null,
  "rubric_version": "v1",
  "exceptions": [],
  "created_at": daysAgo(10),
  "updated_at": daysAgo(4),
  "contributors": [
   {
    "initials": "MK",
    "name": "Martina Kovacs"
   }
  ]
 },
 {
  "id": "TEAM-006",
  "name": "Fraud Detection ML",
  "cohort": "self_service",
  "workflow_step": 1,
  "assessment_lead": "Asha Nair",
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
  "assessment_lead": "Jonas Lindqvist",
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
// applyScores/resetAssessment so the UI round-trips under mock. Authored in
// assessment-content.ts; teams with no sheet yet get a blank one.
const seedAssessments = (): Record<string, Record<string, MockDimensionScore>> => {
  const built = buildScores(contentContext());
  const out = built.scores;
  for (const t of seedTeams()) {
    if (out[t.id]) continue;
    out[t.id] = Object.fromEntries(DIMENSION_IDS.map((d) => [d, { ...emptyDimensionScore(d), updated_at: t.created_at }]));
  }
  return out;
};

// team_id -> provenance records referenced by evidence[].source_ref above.
const seedProvenance = (): Record<string, Provenance[]> => {
  const built = buildScores(contentContext()).provenance;
  const extra = buildEvidenceLog().provenance;
  const out: Record<string, Provenance[]> = {};
  for (const t of seedTeams()) out[t.id] = [...(built[t.id] ?? []), ...(extra[t.id] ?? [])];
  return out;
};

// team_id -> raw ingested evidence items linked to a dimension at intake but
// not yet scored (Evidence.scored === false in the wire contract).
const seedEvidenceLog = (): Record<string, EvidenceLogItem[]> => buildEvidenceLog().log;


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

/** A submission is processed only when its exact scoring run applied every hinted dimension.
 * Manual team scoring and another envelope's run cannot satisfy this projection.
 * Legacy history without attributable run provenance stays committed until reprocessed.
 */
export function isSubmissionProcessed(
  env: Pick<SubmissionEnvelope, 'envelope_id' | 'status' | 'dimension_hints' | 'ingested_at'>,
  dims: Record<string, MockDimensionScore>,
  logs: ScoringLog[] = [],
): boolean {
  if (env.status !== 'committed' || !env.dimension_hints?.length) return false;
  // A later team score is not evidence that THIS submission was processed.
  // Require an explicit envelope -> run -> applied dimension history chain.
  const runs = new Set(logs.filter(log => log.envelope_id === env.envelope_id && log.run_id).map(log => log.run_id));
  return env.dimension_hints.every(h => dims[h.dimension_id]?.history.some(entry =>
    runs.has(entry.source_meeting) && entry.changed_at >= env.ingested_at));

}

// team_id -> envelope_id -> envelope. Mutated by parse/commit/clear. Every date
// and id stamp derives from the mock clock (assessment-content.ts).
const seedSubmissions = (): Record<string, Record<string, SubmissionEnvelope>> => buildSubmissions(contentContext());

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
const seedRuns = (): MockRun[] => {
  const t3Classify = at(HB.t3Classify);
  const t3Score = at(HB.t3Score);
  const t2Score = at(HB.t2Score);
  const t1Rescore = at(HB.t1Rescore);
  const t1Jira = at(HB.t1Jira);
  const t2Draft = at(HB.t2Draft);
  const t4Failed = at(HB.t4Failed);
  const t2Validate = at(HB.t2Validate);
  const t1Diagram = at(HB.t1Diagram);
  const t5Failed = at(HB.t5Failed);
  const t3Running = at(HB.t3Running);
  const context = at(HB.enterpriseContext);
  return [
 {
  "id": RUN_ID.t3Classify(),
  "command": "classify-transcript",
  "team_id": "TEAM-003",
  "args": {},
  "status": "completed",
  "source": "agent",
  "started_at": t3Classify,
  "finished_at": t3Classify,
  "summary": "Classified 1 interview transcript into 8 dimension-tagged excerpts.",
  "error": null,
  "files_written": [
   `workspace/teams/TEAM-003/lineage/classify_${runStamp(t3Classify)}.json`
  ]
 },
 {
  "id": RUN_ID.t3Score(),
  "command": "score-dimensions",
  "team_id": "TEAM-003",
  "args": {},
  "status": "completed",
  "source": "agent",
  "started_at": t3Score,
  "finished_at": t3Score,
  "summary": "Scored 8 dimensions from classified transcript evidence.",
  "error": null,
  "files_written": [
   `workspace/teams/TEAM-003/reports/scoring_log_${runStamp(t3Score)}.json`
  ]
 },
 {
  "id": RUN_ID.t2Score(),
  "command": "score-dimensions",
  "team_id": "TEAM-002",
  "args": {},
  "status": "completed",
  "source": "agent",
  "started_at": t2Score,
  "finished_at": t2Score,
  "summary": "Scored 17 dimensions from the linked repositories and the review call; two answers rated above Defined with no evidence behind them were held at Defined by the self-rating cap.",
  "error": null,
  "files_written": [
   `workspace/teams/TEAM-002/reports/scoring_log_${runStamp(t2Score)}.json`
  ]
 },
 {
  "id": RUN_ID.t1Rescore(),
  "command": "score-dimensions",
  "team_id": "TEAM-001",
  "args": {},
  "status": "completed",
  "source": "agent",
  "started_at": t1Rescore,
  "finished_at": t1Rescore,
  "summary": "Re-scored 15 dimensions after the governance review minutes were uploaded; governance, release management and design standards each moved up one level.",
  "error": null,
  "files_written": [
   `workspace/teams/TEAM-001/reports/scoring_log_${runStamp(t1Rescore)}.json`
  ]
 },
 {
  "id": runId(context, "extract-enterprise-context", "e30a9188"),
  "command": "extract-enterprise-context",
  "team_id": null,
  "args": {},
  "status": "completed",
  "source": "agent",
  "started_at": context,
  "finished_at": context,
  "summary": "Extracted 4 governance facts into the enterprise-context knowledge tree.",
  "error": null,
  "files_written": [
   "workspace/enterprise_context/organization/raci.md"
  ]
 },
 {
  "id": runId(t1Jira, "develop-jira-story", "77bdf2aa11cc"),
  "command": "develop-jira-story",
  "team_id": "TEAM-001",
  "args": {
   "dimension": "1"
  },
  "status": "completed",
  "source": "agent",
  "started_at": t1Jira,
  "finished_at": t1Jira,
  "summary": "Drafted a story for dimension 1 (add a pipeline to northstar-payments-infra and block merge on it).",
  "error": null,
  "files_written": [
   "workspace/teams/TEAM-001/reports/stories/story-dim1-ci-evidence.md"
  ]
 },
 {
  "id": runId(t2Draft, "draft-confluence-page", "0c9a4eff33aa"),
  "command": "draft-confluence-page",
  "team_id": "TEAM-002",
  "args": {},
  "status": "completed",
  "source": "agent",
  "started_at": t2Draft,
  "finished_at": t2Draft,
  "summary": "Drafted a Confluence page summarizing the team's certification status.",
  "error": null,
  "files_written": [
   "workspace/teams/TEAM-002/reports/drafts/certification-summary.md"
  ]
 },
 {
  "id": runId(t4Failed, "suggest-confluence-content", "55e6aa21bb"),
  "command": "suggest-confluence-content",
  "team_id": "TEAM-004",
  "args": {
   "space": "ENG-DATA"
  },
  "status": "failed",
  "source": "agent",
  "started_at": t4Failed,
  "finished_at": t4Failed,
  "summary": "",
  "error": "The ENG-DATA Confluence space is not linked to Data Platform yet, so there was no page tree to read.",
  "files_written": []
 },
 {
  "id": runId(t2Validate, "validate-outputs", "3d88f1cc09ee"),
  "command": "validate-outputs",
  "team_id": "TEAM-002",
  "args": {},
  "status": "completed",
  "source": "agent",
  "started_at": t2Validate,
  "finished_at": t2Validate,
  "summary": `Validated scoring_log_${runStamp(t2Score)}.json against the rubric schema — no violations.`,
  "error": null,
  "files_written": [
   `workspace/teams/TEAM-002/reports/validation_${runStamp(t2Validate)}.json`
  ]
 },
 {
  "id": runId(t1Diagram, "draw-diagram", "a204be009911"),
  "command": "draw-diagram",
  "team_id": "TEAM-001",
  "args": {},
  "status": "completed",
  "source": "agent",
  "started_at": t1Diagram,
  "finished_at": t1Diagram,
  "summary": "Rendered the payment-reconciliation sequence diagram for the Northstar review.",
  "error": null,
  "files_written": [
   "workspace/teams/TEAM-001/reports/diagrams/reconciliation-sequence.md"
  ]
 },
 {
  "id": runId(t5Failed, "process-self-assessment", "9be301aa44"),
  "command": "process-self-assessment",
  "team_id": "TEAM-005",
  "args": {
   "envelope_id": ENVELOPE.t5()
  },
  "status": "failed",
  "source": "agent",
  "started_at": t5Failed,
  "finished_at": t5Failed,
  "summary": "",
  "error": "Notifications Service has no repositories linked, so the three self-assessment answers could not be checked against a pipeline. Scoring did not start.",
  "files_written": []
 },
 {
  "id": runId(t3Running, "score-dimensions", "cc10aa77ff02"),
  "command": "score-dimensions",
  "team_id": "TEAM-003",
  "args": {},
  "status": "running",
  "source": "agent",
  "started_at": t3Running,
  "finished_at": null,
  "summary": "Scoring dimensions 9-17 from the governance charter and latency dashboard classified today.",
  "error": null,
  "files_written": []
 }
  ];
};

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
const seedScoringLogs = (): Record<string, ScoringLog[]> =>
  buildScoringLogs(contentContext(), buildScores(contentContext()).scores);

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
  "question": "Jonas Lindqvist to decide: approve or deny the N/A request for dimension 7 (Performance & Reliability Testing)? The team says its only job is an internal overnight reconciliation batch.",
  "created_at": at(100),
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
  "created_at": at(HB.t3Interview),
  "resolved_at": at(HB.t3Score),
  "response": "Rolling deploys, confirmed via interview with Sam Okafor."
 },
 {
  "task_id": "fb-b1fb64d31abc",
  "team_id": null,
  "kind": "general",
  "status": "DISMISSED",
  "dimension_id": null,
  "question": "Should Fraud Detection ML be merged into the Data Platform cohort instead of self_service?",
  "created_at": at(120),
  "resolved_at": at(96),
  "response": null
 },
 {
  "task_id": "fb-link-eng-data",
  "team_id": "TEAM-004",
  "kind": "general",
  "status": "OPEN",
  "dimension_id": null,
  "question": "Farah Osei: link the ENG-DATA Confluence space to Data Platform, then re-run Suggest Confluence Content. The last run failed because the space was not linked.",
  "created_at": at(HB.t4Failed - 1),
  "resolved_at": null,
  "response": null
 },
 {
  "task_id": "fb-link-notifications-repos",
  "team_id": "TEAM-005",
  "kind": "general",
  "status": "OPEN",
  "dimension_id": null,
  "question": "Farah Osei: ask Martina Kovacs for the Notifications Service repository URLs and link them to the team, then re-run Process Self-Assessment. The last run stopped because no repositories were linked.",
  "created_at": at(HB.t5Failed - 1),
  "resolved_at": null,
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
  /**
   * When this section last pulled from its remote, for a SYNCED section only.
   *
   * Derived, not stored: a pull touches every node's `updated_at`
   * (`touchSyncedSectionNodes`), so the newest one IS the pull. That keeps the
   * claim honest — it cannot say "synced 4m ago" unless rows actually moved —
   * and needs no column the schema does not have. Absent when the section is
   * local, or when a synced section has no dated node yet.
   */
  last_pulled_at?: string;
  nodes: KnowledgeNode[];
}

/**
 * The files the run ledger says agents wrote, as drafts the Workspace and Activity pages can open.
 * Each one cites only what the scorecards already show, so it cannot disagree with them.
 */
const DRAFT_FILES: Array<{ id: string; title: string; path: string; hb: number; markdown: string }> = [
 {
  id: 'workspace_drafts/story-dim1-ci-evidence.md',
  title: 'Northstar Payments: close the CI claim (dimension 1)',
  path: 'workspace/teams/TEAM-001/reports/stories/story-dim1-ci-evidence.md',
  hb: HB.t1Jira,
  markdown: `# Add a pipeline to northstar-payments-infra and block merge on it

Drafted for Jonas Lindqvist. Not pushed to Jira.

## Why
Northstar rated Continuous Integration Optimizing. The review verified Developing: northstar-payments-api builds on every push, but northstar-payments-infra has no pipeline and neither project blocks a merge on a failed one.

## Acceptance criteria
- northstar-payments-infra runs lint, \`terraform validate\` and plan on every push.
- Both projects require a passing pipeline before a merge request can be merged.
- The merge request settings for both projects are attached to the story as evidence.

## Notes
The team asked whether a shared template already covers the infra repository. If it does, the first criterion is a settings change rather than new work.
`,
 },
 {
  id: 'workspace_drafts/certification-summary-team-002.md',
  title: 'Kubernetes Operator: certification summary',
  path: 'workspace/teams/TEAM-002/reports/drafts/certification-summary.md',
  hb: HB.t2Draft,
  markdown: `# Kubernetes Operator: certification status

Drafted for Jonas Lindqvist's review. Not published to Confluence.

## Strongest
Platform Reusability and Source Control & Traceability are verified at Measured, both from observed evidence: three other teams run the operator and its chart, and every release note maps back to a merge request. Continuous Integration and Automated Testing are also verified at Measured.

## Weakest
Performance & Reliability Testing is Initial: the team says it load-tests before releases but showed no plan or results. Governance, Agile Planning and Engineering Metrics are Developing and rest on the team's own account.

## Held at Defined
Continuous Delivery and Software Development Mindset were rated above Defined. The only evidence is the team's own account, so the self-rating cap holds them at Defined until a release record shows the canary and rollback working.

## Waiting on the team
Revision 3 of the Forms submission arrived after the last scoring pass and has not been processed. The follow-up questions on Continuous Delivery, Security Testing, Performance Testing and Engineering Metrics are open.
`,
 },
 {
  id: 'workspace_drafts/reconciliation-sequence.md',
  title: 'Northstar Payments: reconciliation sequence',
  path: 'workspace/teams/TEAM-001/reports/diagrams/reconciliation-sequence.md',
  hb: HB.t1Diagram,
  markdown: `# Payment reconciliation sequence

Rendered for the Northstar review. The nightly batch is the job behind the dimension 7 not-applicable request.

\`\`\`mermaid
sequenceDiagram
  participant Scheduler
  participant Batch as Reconciliation batch
  participant API as payments-api
  participant Ledger
  Scheduler->>Batch: start nightly run
  Batch->>API: fetch settled payments
  API-->>Batch: payments since last run
  Batch->>Ledger: post matched entries
  Batch-->>Scheduler: report unmatched items
\`\`\`
`,
 },
];

const seedKnowledgeSections = (): KnowledgeSection[] => [
 {
  key: 'workspace_drafts', title: 'Workspace drafts', kind: 'local',
  nodes: DRAFT_FILES.map((d) => ({
   id: d.id, title: d.title, parent_id: null, is_dir: false, classification: 'internal', editable: true, viewable: true, updated_at: at(d.hb),
  })),
 },
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
    "id": "rule:what-counts-as-evidence.md",
    "title": "What Counts as Evidence",
    "parent_id": null,
    "is_dir": false,
    "classification": "internal",
    "editable": true,
    "viewable": true,
    "updated_at": daysAgo(30)
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
  source_parent_id?: string | null;
  published_page_id?: string | null;
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
 ...Object.fromEntries(DRAFT_FILES.map((d): [string, KnowledgeDoc] => [d.id, {
  id: d.id, title: d.title, classification: 'internal', markdown: d.markdown, editable: true, path: d.path, updated_at: at(d.hb),
 }])),
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
  "rule:what-counts-as-evidence.md": {
  "id": "rule:what-counts-as-evidence.md",
  "title": "What Counts as Evidence",
  "classification": "internal",
  "markdown": "# What Counts as Evidence\n\nFor all dimensions, evidence should be concrete and reviewable. Acceptable evidence may include:\n\n- GitLab repository links\n- README files\n- Merge requests\n- Pipeline run history\n- Ansible playbooks\n- PowerShell scripts\n- Terraform modules\n- Confluence pages\n- SharePoint documentation\n- ServiceNow records\n- Splunk, CloudWatch, Dynatrace, or Grafana dashboards\n- Security scan results\n- SBOMs\n- Runbooks\n- Architecture Decision Records (ADRs)\n- Operational checklists\n- Post-incident review actions\n\n**Verbal confirmation alone should not be considered sufficient evidence above Level 1.**\n",
  "editable": true,
  "path": "rules/what-counts-as-evidence.md",
  "updated_at": daysAgo(30)
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
  "markdown": "---\ndescription: Classify a transcript or document as evidence \u2014 determine type, weight, and relevant rubric dimensions\nargument-hint: \"document: <path to transcript or document>\"\n---\n\n# Classify Transcript\n\nYou are triaging one piece of evidence about a software engineering team, before it is scored against a maturity rubric.\n\n## Input\n\nParse these from `$ARGUMENTS` (labeled, space-separated, any order; values may be quoted):\n\n- `document:` \u2014 required. Repo-root-relative path to the document, e.g.\n  `workspace/teams/<team-id>/raw_transcripts/interview.vtt`.\n\nIf `document:` is missing, STOP and say so. Do not guess.\n\nRead the document at the `document:` path.\n\nSupported transcript/document inputs in this flow are the text formats `.vtt`, `.md`, and `.txt`.\nBinary formats (`.pdf`, `.docx`, `.xlsx`, images) cannot be read directly \u2014 they are converted to a\nsibling `<original-filename>.md` during ingestion. If the `document:` path points at a binary file,\nread that sibling `.md` instead; if it does not exist, STOP and report that the file has not been\ningested yet. Never infer a classification from a filename.\n\nAlso read the rubric dimension list from `sdlcd/assessment/dimensions/rubric.yaml` to get the dimension IDs and titles.\n\n## Task\n\nGiven the document's type and length, judge:\n\n- `evidence_type`: one of `stakeholder_interview`, `assessment_qa`, `document`, `survey`, `meeting`, `other`\n- `weight`: `high`, `medium`, or `low` \u2014 how much this evidence should move the team's score. A short survey answer or brief meeting note carries less weight than a full stakeholder interview.\n- `weight_reason`: one short sentence explaining the weight (mention type and/or length)\n- `informs`: brief human-readable list of maturity areas this evidence touches (e.g. \"testing\", \"deployment\", \"incident response\")\n- `relevant_dimension_ids`: from the rubric dimensions, the IDs of ONLY the dimensions this evidence gives real, direct signal about \u2014 enough to assess or update that dimension's level. Omit dimensions the evidence does not substantively address. Being precise here protects scores on dimensions this evidence is silent about.\n- `action_items`: short clarifying commitments/to-dos mentioned, if any (empty array if none)\n- `summary`: 1-2 sentences summarizing the evidence\n\n## Output\n\nWrite your classification as JSON to the team's temp directory. For example, for a team whose id is `<team-id>`:\n\n```\nworkspace/teams/<team-id>/temp/classification.json\n```\n\nUse this exact schema:\n\n```json\n{\n  \"evidence_type\": \"stakeholder_interview\",\n  \"weight\": \"high\",\n  \"weight_reason\": \"Detailed 45-minute stakeholder interview covering multiple practices.\",\n  \"informs\": [\"testing\", \"CI/CD\", \"incident response\"],\n  \"relevant_dimension_ids\": [\"1\", \"5\", \"12\"],\n  \"action_items\": [],\n  \"summary\": \"The team discussed their testing and deployment practices in depth.\",\n  \"length_chars\": 12345\n}\n```\n\nThen run this command to validate and persist the classification:\n\n```bash\nuv run -m sdlcd.main assess apply-classification workspace/teams/<TEAM-ID>/temp/classification.json --team <TEAM-ID>\n```\n\n`<TEAM-ID>` is the team segment of the `document:` path (the `<team-id>` in `workspace/teams/<team-id>/...`). If the path has no team segment, STOP and report that \u2014 do not guess a team.\n\nWriting the file is not the end of the job. `relevant_dimension_ids` decides which dimensions a\nlater `/score-dimensions` pass touches at all, so it is validated strictly by this verb: ids must be\nplain rubric dimension numbers (`\"1\"`..`\"17\"`, never `\"DIM-01\"`), with no duplicates, and\n`evidence_type`/`weight` must match the vocabulary above. If the verb exits non-zero, fix the JSON\nand run it again \u2014 do not report success on an unapplied classification.\n\nReport: the evidence type, weight and weight reason, the relevant dimension ids, and the path the\nverb printed.\n",
  "editable": true,
  "path": "prompts/classify-transcript.md",
  "updated_at": daysAgo(35)
 },
 "prompt:score-dimensions.md": {
  "id": "prompt:score-dimensions.md",
  "title": "Score Dimensions",
  "classification": "internal",
  "markdown": "---\ndescription: Score a team against the maturity rubric using gathered evidence\nargument-hint: \"team: <TEAM-ID>\"\n---\n\n# Score Dimensions\n\nYou are a maturity-assessment rubric scorer. You will score a team's engineering maturity dimensions based on evidence from their artifacts.\n\n## Input\n\nParse these from `$ARGUMENTS` (labeled, space-separated, any order; values may be quoted):\n\n- `team:` \u2014 required. Team id, as the workspace folder names it.\n\nIf `team:` is missing, STOP and ask for it. Do not guess.\n\nRead these files:\n1. The rubric: `sdlcd/assessment/dimensions/rubric.yaml` \u2014 contains all 17 dimensions with level 0-5 descriptions\n2. The team's evidence \u2014 read transcript/document evidence files (`.vtt`, `.md`, `.txt`) and supporting text files under:\n  - `workspace/teams/<team>/raw_transcripts/`\n  - `workspace/teams/<team>/processed_transcripts/`\n   - `workspace/teams/<team>/documents/`\n   - `workspace/teams/<team>/raw_documents/`\n   - `workspace/teams/<team>/notes/`\n   - `workspace/teams/<team>/evidence/evidence_log.json` (if it exists)\n\n   Binary evidence (`.pdf`, `.docx`, `.xlsx`, images) cannot be read directly. Ingestion writes a\n   sibling `<original-filename>.md` next to each such file \u2014 read that. If a binary file has no\n   sibling `.md`, treat it as unavailable evidence and say so in your report; never infer its\n   contents from its filename.\n3. Shared enterprise context: `workspace/teams/enterprise_context/{standards,process,organization,tooling}/`\n  (organization-wide reference knowledge; do not treat recommendations as implemented evidence)\n4. Team context: `workspace/teams/<team>/context/{standards,process,organization,tooling}/`\n  (context extracted specifically for this team; distinguish observed practices, gaps, and recommendations)\n5. The classification (if available): `workspace/teams/<team>/temp/classification.json` \u2014 tells you which `relevant_dimension_ids` to score\n\n## Task\n\nFor **each dimension** listed in `relevant_dimension_ids` from the classification (or all 17 if no classification exists):\n\n1. Determine whether this dimension applies to the team. If evidence clearly shows it's not applicable, set `is_na` to true.\n2. N/A claims are never self-granting (full design: `docs/scoring-model.md` \u00a7 \"N/A branching and\n   exceptions\"). Before setting `is_na: true`, check the team's `team.json` `archetype` +\n   `exceptions[]` (entries with `status: approved`) and the registry\n   `workspace/teams/enterprise_context/organization/assessment_exceptions.yaml` (`archetypes.<archetype>.na_dimensions`\n   + `known_exceptions` with `status: approved`). Covered \u2192 set `is_na: true` and cite the specific\n   exception (archetype/known-exception/approved request) in `rationale`. Claimed-but-not-covered\n   (evidence or a survey answer says N/A, but no approved exception matches) \u2192 do NOT self-grant\n   N/A: score the dimension on whatever evidence exists (low confidence if none), set\n   `na_claimed: true` on the score entry, and note in `rationale` that this raises a pending\n   exception request for a human to review.\n3. Read the evidence and determine which maturity level (0-5) is BEST SUPPORTED by concrete evidence. Do not guess or extrapolate. If ambiguous, prefer the lower level and set confidence to \"low\".\n   Level calibration \u2014 it is very hard to get past level 3: level 4 requires verifiable corroboration\n   (pipeline runs, dashboards, metrics, code links) and level 5 additionally requires evidence of\n   sustained practice over time. With claims alone, verification reaches level 3 and stops there \u2014\n   say it that way in the rationale, and add a follow-up question naming the evidence that would\n   carry it further.\n4. Set `confidence` using the evidence-weighting tables below \u2014 sum the weights of the distinct\n   evidence items supporting the assigned level and map the total to the confidence band.\n5. In `rationale`, explain (2-4 sentences) why you assigned this level, citing evidence, and follow the \"Writing style\" section below \u2014 it is read by the team, not by an engineer.\n6. In `evidence_excerpts`, include exact short quotes from the evidence. Leave empty if none.\n7. In `follow_up_questions`, list open questions that would help refine the level, each a plain question addressed to the team. Leave empty if evidence is conclusive.\n8. Set `self_claimed_level` to the level the team's self-rating implies via the standard map (`docs/scoring-model.md` \u00a7 Certification: Not started=0, Developing=2, Established=3, Advanced=4, Leading=5) \u2014 `null` if no self-rating or descriptor claim appears in the evidence.\n9. Set `evidence_class` to the strongest class actually present for this dimension: `\"attested\"`, `\"documented\"`, or `\"observed\"`.\n10. Set `cap_applied` to `true` only when the level-4/5 cap in step 3 fired for this dimension (an uncorroborated claim held the level at 3); otherwise `false`.\n\n**Do NOT fabricate evidence that isn't present in the text.**\n\nShared enterprise context may help interpret applicable standards or formulate follow-up\nquestions, but it is not proof that this team implements the standard. Team context can\ninform the assessment only when its `observed` content is explicitly labeled as current\npractice. Treat `gap` and `recommendation` entries as signals for questions and planning,\nnot as evidence of maturity.\n\n## Scoring criteria \u2014 evidence classes and confidence\n\nFull design + rationale: `docs/scoring-model.md`. Every evidence item\nbelongs to one class; **class, not item count, drives confidence** \u2014\nrepeating the same account in two places is not corroboration:\n\n| Class | What it is | Examples | Anchor |\n| --- | --- | --- | --- |\n| **Attested** | The team says so | Self-assessment answers, interview/transcript statements | 0.3 |\n| **Documented** | The team wrote it down | Architecture diagrams, runbooks, policies, ADRs, minutes | 0.5 |\n| **Observed** | The practice demonstrably happens | Code/pipeline config, CI run history, dashboards, metrics | 0.9 |\n\n\"Observed\" is relative to the dimension: for planning/governance dimensions\na real, current backlog board or decision log IS observed evidence. Stale or\nvague artifacts are discounted one class down (say so in the rationale).\n\n```\nconfidence score = anchor of the STRONGEST class present\n                 + 0.1 if two or more independent classes agree\n                 - 0.2 if classes conflict (floor 0.1)\n```\n\n| Evidence mix | Arithmetic | Confidence |\n| --- | --- | --- |\n| Attested only \u2014 any number of statements | 0.3 | low |\n| Documented only | 0.5 | moderate |\n| Attested + Documented, consistent | 0.5 + 0.1 = 0.6 | moderate |\n| Observed + any consistent class | 0.9 + 0.1 = 1.0 | high |\n| Observed contradicting the claim | 0.9 \u2212 0.2 = 0.7 | high \u2014 score the observed level, raise a follow-up |\n\nBands: **below 0.40 low \u00b7 0.40\u20130.69 moderate \u00b7 0.70+ high.**\nLevel gates in class terms: levels 0\u20133 are supportable by Attested +\nDocumented; **level 4 requires Observed evidence; level 5 requires Observed\nevidence of sustained practice over time.** Show the arithmetic in each\nrationale, written out as sentences rather than notation \u2014 for example:\n\"Confidence starts at 0.5 because the strongest evidence here is something the\nteam wrote down, their deployment runbook. The team's own account of the process\nagrees with it, which adds 0.1 and brings this to 0.6 \u2014 moderate confidence.\"\nThe tables above are how you work it out; the rationale is how you say it.\n\n## Writing style \u2014 these sentences are read by the team\n\n`rationale` and `follow_up_questions` are printed in the team's report and read\nby non-technical people on the assessed team. Write them for that reader:\n\n- **Complete sentences only.** No semicolon-joined fragment chains, no\n  headline-style clauses standing in for a sentence.\n- **No notation.** Never use `->`, `\u2192`, `=`, or a bare equation. Never write\n  anything shaped like `Attested class, anchor 0.3, -0.2 conflict = 0.1 -> low`.\n- **Express the confidence arithmetic in words.** It still has to be shown \u2014 as\n  prose: \"This starts at 0.3 because the only evidence is the team's own\n  account. The conflict between the answer and the self-rating subtracts 0.2,\n  landing at 0.1 \u2014 low confidence.\"\n- **Name things by what the reader knows.** \"The team's answer\", \"the runbook\n  they uploaded\", \"the pipeline history we can see\" \u2014 not \"Attested class\",\n  \"anchor\", \"band\", \"envelope\", \"evidence_class\".\n- **Certification vocabulary** (CLAUDE.md \u00a76): claimed level, verified level,\n  evidence requested. Never \"grade\", \"capped\", \"penalty\", \"marked down\" or\n  \"revised down\". Where a claim outruns its evidence, say that verification\n  reached level N and stopped there, and name the artifact that would carry it\n  further.\n- **A missing artifact is a request, not a fault.** Address each follow-up\n  question to the team and be specific about what would help.\n\nNone of this changes the schema: same field names, same enums, same verbs.\n\n## Output\n\nWrite a JSON file to `workspace/teams/<team>/temp/scores.json` with this schema:\n\n```json\n{\n  \"team_id\": \"<team-id>\",\n  \"scored_at\": \"2026-08-06T14:30:00Z\",\n  \"scores\": [\n    {\n      \"dimension_id\": \"1\",\n      \"is_na\": false,\n      \"suggested_level\": 3,\n      \"confidence\": \"moderate\",\n      \"rationale\": \"The team told us unit tests run on every pull request, and the test plan they uploaded describes the same practice, so both point at level 3. Nothing we could read shows an integration suite running, so the verified level stops there. Confidence starts at 0.5 because the strongest evidence is something the team wrote down, and their own account agrees with it, which adds 0.1 and brings this to 0.6 \u2014 moderate confidence.\",\n      \"evidence_excerpts\": [\"We run unit tests on every PR but integration tests are manual\"],\n      \"follow_up_questions\": [\"Could you share a recent pipeline run that shows the integration tests executing, so we can see how often they run?\"],\n      \"na_claimed\": false,\n      \"self_claimed_level\": null,\n      \"evidence_class\": \"documented\",\n      \"cap_applied\": false\n    }\n  ]\n}\n```\n\nThen persist the scores with the deterministic verb (it validates the JSON,\nnormalizes confidence vocabulary, writes the reasoning log, and records the\nrun \u2014 never call the scoring engine ad hoc):\n\n```bash\nuv run -m sdlcd.main assess apply-scores workspace/teams/<team>/temp/scores.json --team <team>\n```\n\nReport the certification result \u2014 claimed vs verified levels per dimension (CLAUDE.md \u00a76\nvocabulary, never a grade) \u2014 the number of dimensions assessed, and any changes.\n\nThen show what to do about it. A level on its own is not useful to a team; the point of the\nbaseline is what comes next. Read the improvement plan:\n\n```bash\nuv run -m sdlcd.main assess recommendations --team <team>\n```\n\nReport its summary sentence and the top two or three entries, each as the dimension, what kind of\nentry it is, and the one-line headline. Keep the distinction the plan makes: an entry where the\nteam already describes the practice and we are asking for the artifact is a different request from\none where the practice needs building, and running them together as \"gaps\" tells a team to build\nsomething they may already have. Do not re-rank, re-word, or add entries of your own \u2014 the plan is\ncomputed from the same certification you just reported, and it is what the dashboard shows.\n",
  "editable": true,
  "path": "prompts/score-dimensions.md",
  "updated_at": daysAgo(35)
 },
 "prompt:extract-enterprise-context.md": {
  "id": "prompt:extract-enterprise-context.md",
  "title": "Extract Enterprise Context",
  "classification": "internal",
  "markdown": "---\ndescription: Extract enterprise-level governance context (standards, process, org, tooling) from a document\nargument-hint: \"document: <path> [team: <TEAM-ID>] [run_id: <id>]\"\n---\n\n# Extract Enterprise Context\n\nYou are a context extraction agent. Extract organization-wide or cross-team knowledge\nand, when requested, team-specific context about processes, roles, tooling, standards,\ncurrent practices, gaps, and recommendations. Never profile named individuals.\n\n## Input\n\nParse these from `$ARGUMENTS` (labeled, space-separated, any order; values may be quoted):\n\n- `document:` \u2014 required. Repo-root-relative path to the source document, e.g.\n  `workspace/teams/<team-id>/raw_transcripts/interview.vtt`.\n- `team:` \u2014 optional. Source team id for a team-scoped document. Omit for enterprise-only documents.\n- `run_id:` \u2014 optional. Run id to record as provenance.\n\nIf `document:` is missing, STOP and report it. Do not guess.\n\nRead the document at the `document:` path. For team-scoped documents, preserve the `team:` value as\n`source_team_id` in the JSON response. For enterprise-only documents (no `team:` given), use `null`.\n\nSupported transcript/document inputs in this flow are the text formats `.vtt`, `.md`, and `.txt`.\nBinary formats (`.pdf`, `.docx`, `.xlsx`, images) cannot be read directly \u2014 they are converted to a\nsibling `<original-filename>.md` during ingestion. If the `document:` path points at a binary file,\nread that sibling `.md` instead; if it does not exist, STOP and report that the file has not been\ningested yet. Never infer context from a filename.\n\nAlso read existing enterprise context files under `workspace/teams/enterprise_context/{standards,process,organization,tooling}/` to understand what's already captured and avoid duplication.\n\n## Categories\n\n| Category | What to Extract |\n|----------|-----------------|\n| process | SDLC workflows, phase definitions, approval gates, artifacts |\n| organization | Roles (PM, TPM, PO, architect), team structures, reporting, team/app ownership |\n| tooling | JIRA, ServiceNow, Confluence, AI tools, systems used, integration points |\n| standards | Conventions (sizing, naming, cadence); app capabilities, tribal knowledge |\n\n**CRITICAL**: Separate broadly applicable facts from team-specific facts. Shared facts\nbelong in enterprise context; team-specific facts must identify exactly one mapped team.\n\n**CRITICAL**: Never profile or evaluate specific named individuals. Role and process context is fine; assessing a person is not.\n\n## Output\n\nWrite a JSON file to `workspace/teams/enterprise_context/temp/extractions.json`:\n\n```json\n{\n  \"extractions\": [\n    {\n      \"category\": \"process\",\n      \"filename\": \"sdlc_step_process.md\",\n      \"section_title\": \"Step 1: Discover\",\n      \"markdown_content\": \"**Purpose**: Kick off discovery.\\n\\n**Owner**: PM\",\n      \"scope\": \"shared\",\n      \"teams_involved\": [],\n      \"fact_type\": \"observed\"\n    }\n  ],\n  \"discrepancies\": [\n    {\n      \"topic\": \"Approval Gate Owner\",\n      \"existing\": \"TPM approves scope lock\",\n      \"from_document\": \"VP approves scope lock\",\n      \"context_file\": \"process/approval_workflows.md\",\n      \"suggested_resolution\": \"Confirm with the process owner which role approves.\"\n    }\n  ],\n  \"processing_log_summary\": \"SDLC step 1, PM role, 1 discrepancy\",\n  \"source_team_id\": \"<team-id>\",\n  \"team_mapping\": {\"Team 1\": \"<team-id>\"}\n}\n```\n\nGuidelines:\n- Reuse an existing governance filename to merge into it; otherwise propose a new snake_case `.md` filename\n- One entry per distinct topic \u2014 do not combine unrelated topics\n- `markdown_content` is the BODY only \u2014 concise, no padding, no file-level heading\n- Only flag genuine conflicts as discrepancies \u2014 new or more-detailed info is not a discrepancy\n- Use `scope: \"shared\"` for broadly applicable facts and `scope: \"team_specific\"`\n  for facts about one team. Team-specific entries must include exactly one repository\n  team ID in `teams_involved`; use the explicit mapping supplied in the arguments and never\n  infer IDs from names or ordering. Keep recommendations distinct from observed current\n  state. Split mixed content into separate entries whenever possible.\n- Use `fact_type: \"observed\"` for current practice, `\"gap\"` for a stated deficiency,\n  and `\"recommendation\"` for proposed tooling or future-state guidance. Do not report\n  recommendations as implemented practice.\n- For documents covering multiple teams where the arguments do not supply an explicit mapping such\n  as `Team 1 -> <team-id>`, stop and report that the mapping is missing rather than inferring it;\n  return all mappings you were given in `team_mapping`.\n\nThen persist the extraction results through the deterministic CLI. Do not write\nenterprise context Markdown files directly from this command:\n\n```bash\nuv run -m sdlcd.main assess apply-enterprise-context workspace/teams/enterprise_context/temp/extractions.json --document '<source document path>' --team '<source team ID>' --run-id '<run id>'\n```\n\nFor a team-scoped document, pass the `team:` value to `--team`. For an\nenterprise-only document, omit the `--team` option. If no `run_id:` was given,\nomit `--run-id`. Run the command from the repo root after writing\nthe JSON response. The CLI\nis the deterministic persistence step in this workflow; it\nvalidates categories and filenames, creates missing category\ndirectories, appends new sections idempotently, records source provenance,\nand updates `processing_log.md` plus `things_to_clarify.md` when needed.\n",
  "editable": true,
  "path": "prompts/extract-enterprise-context.md",
  "updated_at": daysAgo(35)
 },
 "prompt:validate-outputs.md": {
  "id": "prompt:validate-outputs.md",
  "title": "Validate Outputs",
  "classification": "internal",
  "markdown": "---\ndescription: Validate quality of files modified by the assessment pipeline\nargument-hint: \"document: <source document path> team: <TEAM-ID | enterprise>\"\n---\n\n# Validate Outputs\n\nYou are a document quality validator. Check the quality of files that were modified by the assessment pipeline.\n\n## Input\n\nParse these from `$ARGUMENTS` (labeled, space-separated, any order; values may be quoted):\n\n- `document:` \u2014 required. Repo-root-relative path to the source document.\n- `team:` \u2014 required. Team id, or `enterprise` for enterprise-only runs.\n\nIf `document:` or `team:` is missing, STOP and name the one that is. Do not guess.\n\nRead the source document and all files that were recently modified. Find them in the run ledger at `workspace/runs/`, which is readable with the tools you have. You have no shell \u2014 do not attempt to run `git status` or any other command.\n\n## Validation Categories\n\n### 1. Traceability\nFor each modified file, verify the source document is referenced (path, filename, or a Source Documents section). If no attribution: **FAIL**.\n\n### 2. Fabrication\nFlag claims, numbers, or details in modified files that cannot be traced to the source. Allow standardizing terminology, formatting, categorization, and summarization. Flag novel facts not present in the source.\n\n### 3. Template Conformance\nVerify documents follow their expected structure (headers, sections). Minor deviations: **WARN**. Completely wrong: **FAIL**.\n\n### 4. Content Placement\nEnterprise content belongs in `enterprise_context/`, team content in `workspace/teams/<id>/`. Misplaced: **WARN**.\n\n### 5. Contradiction Detection\nCross-check modified files against each other for inconsistencies. Contradictions: **WARN**.\n\n## Output\n\nReport your findings directly on stdout. For each file checked, state:\n- File path\n- Traceability: PASS / WARN / FAIL\n- Fabrication: PASS / WARN / FAIL\n- Template: PASS / WARN / FAIL\n- Placement: PASS / WARN / FAIL\n\nEnd with an overall assessment and any recommended fixes.\n",
  "editable": true,
  "path": "prompts/validate-outputs.md",
  "updated_at": daysAgo(35)
 },
 "prompt:process-self-assessment.md": {
  "id": "prompt:process-self-assessment.md",
  "title": "Process Self-Assessment",
  "classification": "internal",
  "markdown": "---\ndescription: Score a team's self-certified Forms submission against the maturity rubric with a per-dimension reasoning log\nargument-hint: \"team: <TEAM-ID> [dimensions: 1-6] [submission: <envelope-id>]\"\n---\n\n# Process Self-Assessment\n\nYou are scoring a team's self-certified Microsoft Forms submission against the maturity rubric.\nSelf-reported evidence carries different weight than an interview transcript: you must verify the\nteam's own claims against the rubric rather than trust them, and cap confidence accordingly.\n\n## Input\n\nParse these from `$ARGUMENTS` (labeled, space-separated, any order; values may be quoted):\n\n- `team:` \u2014 required. Team id, e.g. `TEAM-002`.\n- `dimensions:` \u2014 optional. e.g. `1-6` or `4,7`. Blank = all informed dimensions.\n- `submission:` \u2014 optional. Envelope id. Blank = latest envelope for the team.\n\nIf `team:` is missing, STOP and report it. Do not guess.\n\nRead these files:\n\n1. The rubric: `sdlcd/assessment/dimensions/rubric.yaml` \u2014 contains all 17 dimensions with level 0-5 descriptions\n2. The envelope: `workspace/teams/<team>/submissions/sub-<stamp>-form<Id>-<submitter>.json` \u2014 the `submission:`\n   input if given, otherwise the latest envelope for the team by filename sort (envelope ids sort\n   chronologically)\n3. Manually fetched link evidence: `workspace/teams/<team>/submissions/evidence/<envelope_id>/` \u2014 if any files\n   there are binary (`.pdf`, `.docx`, `.xlsx`, images), FIRST run:\n\n   ```bash\n   uv run -m sdlcd.main submissions ingest-evidence --team <TEAM-ID> --envelope <envelope-id>\n   ```\n\n   This converts them to markdown alongside the originals.\n   Then read the resulting `.md` outputs \u2014 do not attempt to read the binary files directly.\n4. Shared enterprise context: `workspace/teams/enterprise_context/{standards,process,organization,tooling}/`\n   and team context: `workspace/teams/<team>/context/` \u2014 governance and risk-control rules. Factor these into\n   what \"good\" looks like for each dimension; they are not evidence that the team implements them.\n\n## Task\n\n1. Score ONLY the dimensions the envelope actually informs \u2014 a dimension is informed when its\n   `dimension_hints` entry has a non-empty `main_answer`, `self_rating`, or `evidence_context` \u2014\n   intersected with the requested `dimensions:` range. Dimensions outside that intersection are\n   skipped, not scored as low.\n2. N/A claims are never self-granting (full design: `docs/scoring-model.md` \u00a7 \"N/A branching and\n   exceptions\"). When a dimension's `dimension_hints` entry has `claimed_na: true`, check the\n   team's `team.json` `archetype` + `exceptions[]` (entries with `status: approved`) and the\n   registry `workspace/teams/enterprise_context/organization/assessment_exceptions.yaml`\n   (`archetypes.<archetype>.na_dimensions` + `known_exceptions` with `status: approved`). Covered \u2192\n   set `is_na: true` and cite the specific exception (archetype/known-exception/approved request) in\n   the reasoning log's `conclusion`. Claimed-but-not-covered \u2192 do NOT self-grant N/A: score the\n   dimension on whatever evidence exists (low confidence if none), set `na_claimed: true` on that\n   score entry, and note in `conclusion` that this raises a pending exception request for a human\n   to review.\n3. The `main_answer` is a level-descriptor sentence the team CHOSE from the form. Do not trust it at\n   face value \u2014 verify it against the rubric's actual level descriptions for that dimension and\n   determine which level the wording truly matches. Teams sometimes pick the wrong descriptor.\n4. The `self_rating` (Not started..Leading) is a CLAIM from the rating matrix, not evidence. Use it\n   as a signal to cross-check against `main_answer` and `evidence_context`, never as a standalone\n   basis for a level.\n5. Confidence \u2014 use the evidence-class model (full design: `docs/scoring-model.md`).\n   Class, not item count, drives confidence; repeating the same account across\n   questions is one source, not corroboration:\n\n   | Class | In this flow | Anchor |\n   | --- | --- | --- |\n   | Attested | Every survey answer, self-rating, and evidence-context text | 0.3 |\n   | Documented | Fetched evidence files that *describe* (diagrams, runbooks, policies) | 0.5 |\n   | Observed | Fetched evidence files that *show the practice happening* (pipeline runs, dashboards, metrics, code) | 0.9 |\n\n   `confidence = strongest class anchor (+0.1 if independent classes agree,\n   \u22120.2 if they conflict)`; bands: <0.40 low \u00b7 0.40\u20130.69 moderate \u00b7 0.70+ high.\n   A survey alone is Attested-only \u2192 always `\"low\"`, regardless of how\n   detailed the answers are. Show the arithmetic in `confidence_weighting`,\n   written out in words, never as notation \u2014 see \"Writing style\" below.\n6. Level calibration \u2014 **it is very hard to get past level 3**:\n   - Levels 0\u20133 may be supported by consistent answers plus reasonable evidence context.\n   - Level 4 requires verifiable corroboration (fetched artifacts, code/pipeline links, dashboards,\n     metrics) demonstrating the \"Measured\" practices. Level 5 additionally requires evidence of\n     sustained practice over time (trends, repeated measurements, improvement loops).\n   - A level-4/5 descriptor choice or \"Advanced/Leading\" self-rating with no corroborating evidence\n     means verification reaches **3** and stops there. Set `cap_applied: true`, say so in the\n     reasoning log in the report's own words (verification reached level 3 and stopped there \u2014\n     never \"capped\", \"marked down\" or \"revised down\"), and add a `follow_up_question` naming the\n     specific evidence that would carry it further.\n7. On ambiguity between two adjacent levels, prefer the LOWER level and add a `follow_up_question`\n   that would resolve the ambiguity.\n8. Never fabricate evidence, quotes, or corroboration that isn't present in the read files.\n9. Confidence vocabulary is exactly `low`, `moderate`, or `high` \u2014 never `\"medium\"`.\n10. A link whose status is `rejected` is NOT evidence \u2014 never treat it as corroboration and never ask\n   for it again in a follow-up. If its reason is `sensitive-pii`, do not raise it at all; instead note\n   \"evidence withheld as sensitive\" in that dimension's reasoning log. For any other reject reason\n   (`not-relevant`, `no-context`, `broken-link`), a follow-up question asking for better-contextualized\n   evidence is appropriate.\n11. On each score entry, set `self_claimed_level` to the level the team's self-rating implies via the\n   standard map (`docs/scoring-model.md` \u00a7 Certification: Not started=0, Developing=2, Established=3,\n   Advanced=4, Leading=5) \u2014 `null` if the dimension carries no self-rating. Set `evidence_class` to the\n   strongest class actually present (`\"attested\"`, `\"documented\"`, or `\"observed\"`). Set `cap_applied`\n   to `true` only when the level-4/5 cap in item 6 fired for this dimension, else `false`.\n\n**CONTEXT OVERFLOW \u2014 headless failure path.** If you cannot read all required inputs within your\ncontext window, STOP immediately. Report on stdout exactly which inputs did not fit and stop; do\nnot produce partial scores. Do NOT write\n`workspace/teams/<team>/temp/self_assessment_scores.json` and do NOT run `assess apply-scores` \u2014\na partial pass is worse than a failed run, because it would be recorded as a completed scoring.\nThere is nobody here to re-prompt, so the run must end as a failure with the reason on stdout:\nmake the last line of your reply exactly\n\n```\nRUN FAILED: context overflow \u2014 did not fit: <comma-separated list of inputs>\n```\n\nand terminate with a non-zero status. The operator's remedy is a scoped re-run \u2014\n`/process-self-assessment team: <TEAM-ID> dimensions: 1-6` (then `7-12`, `13-17`). Never silently\ntruncate or guess.\n\n### Writing style \u2014 these sentences are read by the team\n\n`rationale`, `follow_up_questions`, and every free-text field of the `reasoning_log`\n(`descriptor_match`, `confidence_weighting`, `conclusion`) are printed in the team's report and\nread by non-technical people on the assessed team. Write them for that reader:\n\n- **Complete sentences only.** No semicolon-joined fragment chains, no headline-style clauses\n  standing in for a sentence.\n- **No notation.** Never use `->`, `\u2192`, `=`, or a bare equation. Never write anything shaped like\n  `Attested class, anchor 0.3, -0.2 for main-answer/self-rating conflict = 0.1 -> low`.\n- **Express the confidence arithmetic in words.** It still has to be shown \u2014 as prose: \"This\n  starts at 0.3 because the only evidence is the team's own account. The conflict between the\n  answer and the self-rating subtracts 0.2, landing at 0.1 \u2014 low confidence.\"\n- **Name things by what the reader knows.** \"The team's answer\", \"the runbook they uploaded\",\n  \"the pipeline history we can see\" \u2014 not \"Attested class\", \"anchor\", \"band\", \"envelope\",\n  \"dimension_hints\", \"evidence_class\".\n- **Certification vocabulary** (CLAUDE.md \u00a76): claimed level, verified level, evidence requested.\n  Never \"grade\", \"capped\", \"penalty\", \"marked down\" or \"revised down\". Where a claim outruns its\n  evidence, say that verification reached level N and stopped there, and name the artifact that\n  would carry it further.\n- **A missing artifact is a request, not a fault.** Address each follow-up question to the team\n  and be specific about what would help.\n\nNone of this changes the schema: same field names, same enums, same verbs.\n\n### Reasoning log\n\nFor EVERY scored dimension, produce a `reasoning_log` entry that shows your work: which questions\nyou cited, what descriptor the team chose and which rubric level it actually matches, what the\nself-rating implied, what corroborating evidence (if any) you found, how confidence was weighted,\nand your conclusion. Worked exemplar:\n\n> \"The team answered all three questions for this dimension with statements describing level-3\n> practice, and added some context of their own. Everything here is the team's own account, which\n> on its own carries low confidence. Three answers pointing at level 3, with nothing yet to verify\n> them, puts the verified level at 3 with low confidence.\"\n\n## Output\n\nWrite a JSON file to `workspace/teams/<team>/temp/self_assessment_scores.json` with this schema:\n\n```json\n{\n  \"team_id\": \"<team-id>\",\n  \"envelope_id\": \"sub-<UTC stamp>-form41-jsmith\",\n  \"scores\": [\n    {\n      \"dimension_id\": \"6\",\n      \"is_na\": false,\n      \"suggested_level\": 3,\n      \"confidence\": \"low\",\n      \"rationale\": \"The statement the team picked and the rating they gave themselves both describe level-3 practice, so they agree with each other. Nothing was uploaded that shows the practice actually running, so verification reaches level 3 and stops there. Confidence starts at 0.3 because the only evidence is the team's own account, and there is nothing else to add to it or set against it, so it stays at 0.3 \u2014 low confidence.\",\n      \"evidence_excerpts\": [],\n      \"follow_up_questions\": [\"Could you share a recent deployment run or a dashboard that shows this happening, so we can verify it?\"],\n      \"na_claimed\": false,\n      \"self_claimed_level\": 3,\n      \"evidence_class\": \"attested\",\n      \"cap_applied\": false\n    }\n  ],\n  \"reasoning_log\": [\n    {\n      \"dimension_id\": \"6\",\n      \"questions_cited\": [\n        {\"question\": \"Which statement best describes your deployment process?\", \"answer\": \"We deploy on a fixed schedule with manual approval gates.\"}\n      ],\n      \"descriptor_match\": \"The statement the team picked describes deploying on a fixed schedule with someone approving each release by hand. That is what the rubric calls level 3 for this dimension.\",\n      \"self_rating\": \"Established\",\n      \"self_rating_implied_level\": 3,\n      \"corroborating_evidence\": [],\n      \"confidence_weighting\": \"The only evidence for this dimension is what the team told us on the form. Nothing was uploaded that we could read, and nothing we could watch running. That means there is nothing to add to their account and nothing that disagrees with it, so confidence starts at 0.3 and stays at 0.3 \u2014 low confidence.\",\n      \"conclusion\": \"All three answers for this dimension describe level-3 practice, and the rating the team gave themselves agrees, so the verified level is 3. Because the only evidence is the team's own account, confidence is low, and we have asked for one artifact that would let us verify it.\"\n    }\n  ],\n  \"skipped_dimensions\": [\n    {\"dimension_id\": \"9\", \"reason\": \"The form carried no answer, no self-rating, and no context for this dimension, so there was nothing to assess.\"}\n  ]\n}\n```\n\nThen run this command to persist the scores to `assessment.json`:\n\n```bash\nuv run -m sdlcd.main assess apply-scores workspace/teams/<TEAM-ID>/temp/self_assessment_scores.json --team <TEAM-ID>\n```\n\nReport which dimensions were scored, with their levels and confidence. Then report which dimensions\nwere skipped and why, which follow-up questions were added, and the path of the scoring log the verb\nprinted.\n\nFinish by reading the team's improvement plan and reporting what it says:\n\n```bash\nuv run -m sdlcd.main assess recommendations --team <TEAM-ID>\n```\n\nGive its summary sentence and the top two or three entries \u2014 the dimension, what kind of entry it\nis, and the headline. This is the whole point of processing a submission: the team gets a picture of\nwhere they stand and, in the same breath, what would change it. Keep the plan's distinction intact.\nWhere the team's own rating already describes the practice, the ask is for something we can check\nfor ourselves, and saying \"you need to build this\" would be both wrong and insulting. Do not\nre-rank, re-word, or invent entries \u2014 the plan comes from the same certification you just reported.\n",
  "editable": true,
  "path": "prompts/process-self-assessment.md",
  "updated_at": daysAgo(35)
 },
 "prompt:develop-jira-story.md": {
  "id": "prompt:develop-jira-story.md",
  "title": "Develop Jira Story",
  "classification": "internal",
  "markdown": "---\ndescription: Draft a Jira story for one entry in a team's improvement plan, grounded in enterprise governance patterns\nargument-hint: \"team: <TEAM-ID> [dimension: 6] [gap: \\\"<short gap description>\\\"]\"\n---\n\n# Develop Jira Story\n\nYou are drafting a practical Jira story that acts on one entry in a team's improvement plan, with\nevery acceptance criterion grounded in an actual enterprise governance pattern rather than generic\nadvice.\n\n## Input\n\nParse these from `$ARGUMENTS` (labeled, space-separated, any order; values may be quoted):\n\n- `team:` \u2014 required. Team id, as the workspace folder names it.\n- `dimension:` \u2014 optional. Dimension focus, e.g. `6`. Blank = the plan's top-ranked entry.\n- `gap:` \u2014 optional. Gap description in the team's own words.\n\nIf `team:` is missing, STOP; a story needs a team to attach to. Do not guess.\n\n**Start by reading the team's improvement plan.** It is computed deterministically from the same\ncertification the team's scorecard shows, so a story must never disagree with it about what matters\nnext:\n\n```\nuv run -m sdlcd.main assess recommendations --team <team> --json\n```\n\nThat prints the ranked plan: per entry a `dimension_id`, a `kind`, a `headline`, `verified_level`,\n`claimed_level`, `next_level`, `why`, `what_would_help`, `level_up_criteria`, and `open_questions`.\nDo not re-derive the ranking yourself and do not pick a dimension by your own reasoning \u2014 the plan\nalready weighed the team's own stated priorities against how far below target each dimension sits.\n\nThen read:\n\n1. `workspace/teams/<team>/assessment.json` \u2014 dimension levels and open follow-up questions\n2. The latest `workspace/teams/<team>/reports/scoring_log_*.md` \u2014 the most recent rationale for how\n   levels were assigned, in the words the team has already been given\n3. `sdlcd/assessment/dimensions/rubric.yaml` \u2014 the focus dimension's current-level and next-level\n   descriptions and `level_up_criteria`\n4. Shared enterprise context: `workspace/teams/enterprise_context/{standards,process,organization,tooling}/` \u2014\n   every acceptance criterion you write must cite the specific enterprise pattern or governance rule\n   it enforces, by filename\n5. `workspace/teams/enterprise_context/templates/STORY_TEMPLATE.md` \u2014 the story's file format. It\n   owns the metadata table and the section structure, and the deterministic verbs read what it\n   defines, so copy it rather than writing a table of your own\n\n## Task\n\n1. Pick the focus entry: if `dimension:` was given, use that dimension's entry from the plan;\n   otherwise use the entry ranked 1. If the requested dimension has no entry in the plan (it is\n   already at or above target, or not applicable), STOP and say so rather than inventing work.\n2. **Write the story that the entry's `kind` calls for. These are not the same story.**\n\n   - `close_the_claim` \u2014 the team's own rating already describes this practice, and verification\n     stopped lower because the evidence on file does not reach that far. **Do not write a story\n     telling the team to build something they say they already have.** The work is producing or\n     locating the artifact: exporting the pipeline history, attaching the dashboard, pointing at the\n     runbook. Acceptance criteria are about the artifact existing, being current, and being\n     reachable by the assessment \u2014 not about changing how the team works. Say plainly in the summary\n     that this may already be done and the story exists to make it checkable.\n   - `advance_practice` \u2014 the practice genuinely is not in place. The story advances the dimension\n     from its verified level to the next one, and the target level's `level_up_criteria` from\n     `rubric.yaml`, quoted, are the basis for the Definition of Done.\n   - `answer_question` \u2014 the dimension could not be assessed yet. The story is about answering the\n     specific outstanding questions in `open_questions`, quoted verbatim, so the next pass has\n     something to work from.\n\n3. Write acceptance criteria where each one is mapped to a specific enterprise pattern \u2014 cite the\n   enterprise context filename it enforces (e.g. \"per `standards/ci_pipeline_policy.md`\").\n4. Anything unknown (the Jira project, the priority, the owner, the exact repo, a specific tooling\n   detail) becomes a `[NEEDS INPUT]` marker with an `[ID: X_Qn]` question id.\n5. **Writing style \u2014 the team reads this story.** The summary, the acceptance criteria, and any\n   sentence explaining *why* this dimension was picked are read by non-technical people on the\n   assessed team. Write complete plain-English sentences: no semicolon-joined fragment chains, no\n   arrow notation (`->`), no bare equations. Where you refer to how the level was reached, express\n   it in words (\"the only evidence so far is the team's own account, so verification reached level\n   3 and stopped there\") rather than the confidence arithmetic in notation, and name things by what\n   the reader knows \u2014 the team's answer, the runbook they uploaded, the pipeline history we can see\n   \u2014 not \"Attested class\", \"anchor\", \"band\" or \"envelope\". Use the certification vocabulary\n   (CLAUDE.md \u00a76): claimed level, verified level, evidence requested \u2014 never \"grade\", \"capped\",\n   \"penalty\", \"marked down\" or \"revised down\". A missing artifact is a request, not a fault.\n6. **Never promise a level, and never estimate human effort.** Attaching an artifact does not\n   guarantee a higher verified level \u2014 verification lands wherever the evidence actually reaches.\n   Write \"this is what we would need to confirm Level 3\", not \"this moves the team to Level 3\". And\n   the story carries no time estimate, no story-point guess, and no \"quick win\" framing: sizing is\n   the team's call, made with context you do not have.\n7. Do NOT call Jira or any API. This is a draft file only.\n\n## Output\n\nWrite to `workspace/teams/<team>/stories/<UTC %Y%m%dT%H%M%SZ>-<slug>.md`, following\n`workspace/teams/enterprise_context/templates/STORY_TEMPLATE.md` \u2014 the template owns the file's\nshape, including its section headings, its `[NEEDS INPUT] [ID: S_Qn]` convention, and its metadata\ntable. **Read the template and copy its metadata table verbatim**, filling every cell rather than\nretyping the table from memory. The table below is reproduced from that file so you know what you\nare looking for; if the two ever differ, the template is right and this copy is stale:\n\n```markdown\n| Field | Value |\n| --- | --- |\n| Project key | [NEEDS INPUT] [ID: S_Q1] |\n| Issue type | Story |\n| Team | [TEAM-ID] |\n| Dimension | [the dimension number this story advances, digits only] |\n| Verified level | [the level the evidence on file reaches, as a whole number] |\n| Claimed level | [the level the team's own rating implies, or \"none on file\"] |\n| Level this story works toward | [the level this story would help confirm] |\n| Plan entry | [Close the claim, Advance the practice, or Answer the question] |\n| Priority | [NEEDS INPUT] [ID: S_Q2] |\n| Owner | [NEEDS INPUT] [ID: S_Q3] |\n| Labels | maturity-dim-[the same dimension number] |\n| Generated From | [repo-root-relative path of the scoring log or evidence this story was drafted from] |\n| Jira Key |  |\n```\n\nRow by row, what the cells have to contain for the story to work end to end:\n\n- `Project key` is the Jira project the issue is created in. The push verb refuses the story without\n  it, and it is spelled exactly `Project key` \u2014 not \"Jira project key\".\n- `Dimension` holds the dimension number on its own (`6`, not \"Dimension 6: Testing\"). Both the\n  dashboard's story list and the improvement plan resolve a story to its dimension from this cell,\n  and a story whose dimension cannot be resolved is listed as belonging to no dimension at all.\n- `Labels` carries `maturity-dim-<n>` for the same number. It is what Jira gets, and it is also the\n  fallback the dimension is resolved from if the `Dimension` cell is unusable.\n- `Plan entry` is the human-readable name of the entry's `kind`: `Close the claim`, `Advance the\n  practice`, or `Answer the question`. Never write the raw key (`close_the_claim`) into the story \u2014\n  that is an internal identifier, and the story is read by people.\n- `Jira Key` stays empty. The push verb rewrites that one row in place after Jira creates the issue,\n  and the dashboard reads it back to tell a pushed story from one still waiting, so the row must be\n  present even while it is empty.\n\nKeep every row as `| Field | Value |`, write each field exactly once, and keep the table unbroken\nfrom its header to its last row \u2014 the parser stops at the first line that is not a table row, so a\nblank line or a note in the middle of the table hides every row below it. There is no `Target\nsprint` row and no arrow notation anywhere in the table: levels are named in words, one per row.\n\nFollow the metadata table with the template's story body: summary, acceptance criteria (each citing\nits enterprise pattern), Definition of Done, and every `[NEEDS INPUT]` item with its `[ID: X_Qn]`\nquestion id collected in one place at the end.\n\nReport: the story path, the remaining `[NEEDS INPUT]` items, and the push command:\n\n```bash\nuv run -m sdlcd.main jira push-story --team <TEAM-ID> --file <story path>\n```\n\nNote that it refuses to push while `[NEEDS INPUT]` markers remain in the file.\n",
  "editable": true,
  "path": "prompts/develop-jira-story.md",
  "updated_at": daysAgo(35)
 },
 "prompt:draft-confluence-page.md": {
  "id": "prompt:draft-confluence-page.md",
  "title": "Draft Confluence Page",
  "classification": "internal",
  "markdown": "---\ndescription: Draft a new Confluence page as a local markdown file, ready for one-click publishing from the dashboard\nargument-hint: \"parent: <parent-page-id> title: \\\"<page title>\\\" [tracker_entry: <n>] [guidance: \\\"<what it should cover>\\\"]\"\n---\n\n# Draft Confluence Page\n\nYou are drafting a new Confluence page as local markdown, for review and one-click publishing\nfrom the dashboard. You do not publish anything \u2014 you only write the draft file.\n\n## Input\n\nParse these from `$ARGUMENTS` (labeled, space-separated, any order; values may be quoted):\n\n- `parent:` \u2014 required. Parent page id (from the dashboard's New page panel).\n- `title:` \u2014 required. Page title; usually quoted.\n- `tracker_entry:` \u2014 optional. Tracker entry number from the New page panel. Informational only \u2014\n  the launcher stamps the tracker row from this run's exit code. Do not edit the tracker yourself.\n- `guidance:` \u2014 optional. What the page should cover.\n\nGuidance may also arrive as free-form text after the labeled arguments (the dashboard appends\n`What it's about: \u2026` and `What it relates to: \u2026` paragraphs). Treat any such trailing text as\nadditional guidance.\n\nIf `parent:` or `title:` is missing, STOP and name it. Do not guess.\n\nRead these files:\n\n1. `workspace/confluence/state/tree.json` \u2014 the synced page tree (id, title, parent_id, slug_path for every\n   page). Use it to find the Parent page's node and resolve its `slug_path`, then walk `parent_id`\n   up the tree to collect the full ancestor chain.\n2. The parent page's markdown (`workspace/confluence/pages/<slug_path from tree.json>`) and the same file for\n   each ancestor resolved in step 1 \u2014 this is what \"sibling tone\" and \"where this page sits in the\n   tree\" are grounded in. If the parent has children already listed in `tree.json`, read a couple of\n   their markdown files too as sibling examples.\n3. `workspace/confluence/comments/*.json` and `workspace/confluence/state/comment_ledger.json` \u2014 open feedback anywhere\n   in the tree that might bear on what this new page should cover or clarify.\n4. `workspace/teams/enterprise_context/{standards,process,organization,tooling}/` \u2014 governance and process\n   patterns the page's content should align with.\n\n## Task\n\n1. Resolve the `parent:` id against `tree.json`. If it does not exist in the tree, stop and report that\n   the parent id was not found \u2014 do not guess a parent.\n2. Write the page body in the supported markdown dialect **only**: GFM tables, nested lists, task\n   lists, fenced code blocks with a language, `> [!NOTE|TIP|IMPORTANT|WARNING]` admonitions, `---`\n   thematic breaks. **No raw HTML** \u2014 anything that would require it does not belong in the draft.\n3. Match the tone, heading depth, and structural conventions of the sibling/ancestor pages you read \u2014\n   this should read as if it belongs in the same space, not as a generic document.\n4. Ground every factual claim in the context you read (parent/ancestor pages, comments, enterprise\n   context). Never fabricate program facts, dates, decisions, or figures that aren't backed by what\n   you read. If the guidance asks for something not supported by the read context, write the\n   section as a clearly-marked placeholder/open question rather than inventing content.\n5. Write for a non-technical reader: complete plain-English sentences, no semicolon-joined fragment\n   chains, no arrow notation (`->`), no bare equations. If the page explains how an assessment\n   result was reached, express the confidence arithmetic in words (\"this starts at 0.3 because the\n   only evidence is the team's own account\") and name things by what the reader knows rather than\n   internal vocabulary (\"Attested class\", \"anchor\", \"band\", \"envelope\"). Use the certification\n   vocabulary (CLAUDE.md \u00a76): claimed level, verified level, evidence requested \u2014 never \"grade\",\n   \"capped\", \"penalty\", \"marked down\" or \"revised down\".\n6. PII rule: for enterprise-team participants, use role labels (\"the team's tech lead\"), never\n   personal names \u2014 consistent with the PII policy for personal conversations elsewhere in this repo.\n\n## Output\n\nCreate `workspace/confluence/drafts/` if it does not exist. Write the draft to\n`workspace/confluence/drafts/<kebab-title>.md` where `<kebab-title>` is the `title:` input, kebab-cased. The file's\n**exact** first line must be:\n\n```\n<!-- draft: parent_id=<PARENT> title=<TITLE> -->\n```\n\nfollowed by a blank line, then `# <TITLE>`, then the body.\n\nReport: the draft's file path, a one-line summary of what it covers, and: \"Open the dashboard's New\npage panel \u2014 the draft appears there for review and publishing.\"\n",
  "editable": true,
  "path": "prompts/draft-confluence-page.md",
  "updated_at": daysAgo(35)
 },
 "prompt:suggest-confluence-content.md": {
  "id": "prompt:suggest-confluence-content.md",
  "title": "Suggest Confluence Content",
  "classification": "internal",
  "markdown": "---\ndescription: Suggest content improvements and new pages from the space's context and comment history\nargument-hint: \"focus: <page title | whole space>\"\n---\n\n# Suggest Confluence Content\n\nYou are reading the synced Confluence space to surface concrete, actionable content suggestions \u2014\nthings to fix, clarify, or add \u2014 grounded in what reviewers actually flagged and what the space\nalready contains. You do not edit or publish anything; you only write a suggestions draft.\n\n## Input\n\nParse these from `$ARGUMENTS` (labeled, space-separated, any order; values may be quoted):\n\n- `focus:` \u2014 required. A page title, or `whole space`.\n\nIf `focus:` is missing, STOP and ask what to look at. Do not guess.\n\nRead these files:\n\n1. `workspace/confluence/state/tree.json` \u2014 resolve the `focus:` title to a page id and `slug_path`. If focus is\n   `whole space`, use the full tree.\n2. The markdown for the focus page and its children (or, for `whole space`, everything under\n   `workspace/confluence/pages/`) \u2014 this is the content you're evaluating.\n3. `workspace/confluence/comments/*.json` and `workspace/confluence/state/comment_ledger.json` \u2014 pay special attention to\n   comments with ledger `status` `open` or with a `last_change_run` after `first_seen_at` (edited):\n   unresolved feedback is the richest source of suggestions. Note each comment's id.\n4. Recent scoring logs under `workspace/teams/*/reports/` \u2014 if relevant to the focus, use them to ground\n   suggestions about program/assessment content in what's actually been scored, not assumption.\n5. `workspace/teams/enterprise_context/{standards,process,organization,tooling}/` \u2014 governance and process\n   context that content should stay consistent with.\n\n## Task\n\nProduce 3\u20137 concrete suggestions. For each one, state:\n\n- **What** to change or add.\n- **Where** \u2014 the page title (and, for a new page, the intended parent page title).\n- **Why** \u2014 cite the specific comment id, or the context/file, that motivates it. Never invent a\n  motivation that isn't traceable to something you read.\n- **Next step** \u2014 one ready-to-run action:\n  - For a new page: a `/draft-confluence-page` command line, e.g.\n    `` /draft-confluence-page title: \"...\" parent: <parent_page_id> guidance: \"...\" ``\n  - For an edit to an existing page: `edit pages/<slug> section <heading>`.\n\nDo not fabricate program facts. If a suggestion is a hunch not directly grounded in the read\ncontext, say so explicitly in the \"why\" rather than presenting it as evidence-backed.\n\nWrite every What / Where / Why in complete plain-English sentences \u2014 no semicolon-joined fragment\nchains, no arrow notation (`->`), no bare equations. Where a suggestion touches assessment results,\nuse the certification vocabulary (CLAUDE.md \u00a76): claimed level, verified level, evidence requested\n\u2014 never \"grade\", \"capped\", \"penalty\", \"marked down\" or \"revised down\".\n\n## Output\n\nCreate `workspace/confluence/drafts/` if it does not exist. Write to\n`workspace/confluence/drafts/suggestions-<UTC %Y%m%dT%H%M%SZ>.md` (UTC timestamp at generation time). The\nfile's **exact** first line must be:\n\n```\n<!-- draft: parent_id= title=Content suggestions <date> -->\n```\n\nfollowed by a blank line, then `# Content suggestions`, then one `## Suggestion N \u2014 <short name>`\nsection per suggestion, each containing the What / Where / Why / Next step above.\n\nReport: the draft's file path and the list of suggestion titles.\n",
  "editable": true,
  "path": "prompts/suggest-confluence-content.md",
  "updated_at": daysAgo(35)
 },
 "prompt:draw-diagram.md": {
  "id": "prompt:draw-diagram.md",
  "title": "Draw Diagram",
  "classification": "internal",
  "markdown": "---\ndescription: Generate a draw.io diagram and embed it in a Confluence page's local markdown, ready for one-click publishing\nargument-hint: \"name: <kebab-name> page: <target-page-id> about: \\\"<what to diagram>\\\" [context: <path,path>]\"\n---\n\n# Draw Diagram\n\nYou are authoring a new draw.io diagram as local files, for review and one-click\npublishing from the dashboard. You do not publish anything or upload any attachment \u2014\nyou only write the diagram source and embed it in the target page's markdown. See\n`docs/drawio.md` for the full exchange format this plugs into.\n\n## Input\n\nParse these from `$ARGUMENTS` (labeled, space-separated, any order; values may be quoted):\n\n- `name:` \u2014 required. Diagram name, kebab-case, e.g. `auth-sequence`.\n- `page:` \u2014 required. Target page id (from the dashboard's page tree) \u2014 where the diagram gets embedded.\n- `about:` \u2014 required. What this diagram should show; usually quoted.\n- `context:` \u2014 optional. Comma-separated repo-root-relative paths to read for grounding.\n\nIf `name:`, `page:` or `about:` is missing, STOP and name the missing one. Do not guess.\n\nRead these files:\n\n1. `workspace/confluence/state/tree.json` \u2014 resolve the `page:` id to its `slug_path`. If it does\n   not exist in the tree, stop and report that the target page was not found \u2014 do not guess one.\n2. The target page's markdown (`workspace/confluence/pages/<slug_path from tree.json>`) \u2014 read it in full\n   so you know where the diagram fits contextually and don't duplicate content it already covers.\n3. Every path listed in `context:`, if any \u2014 these are what the diagram's content should be\n   grounded in. Never invent architecture, flows, or relationships that aren't backed by what you\n   read; if the request implies something not supported by the context, diagram what you can support\n   and note the gap in your report rather than fabricating detail.\n\n## Task\n\nGenerate **valid** draw.io XML: a single `<mxfile>` wrapping one `<diagram>` wrapping one\n`<mxGraphModel>`. Keep the layout simple and legible:\n\n- Plain rectangles (`vertex=\"1\"` `mxCell` with a `<mxGeometry>`) for entities/steps, plain arrows\n  (`edge=\"1\"` `mxCell` with `source`/`target`) for relationships/flow. No fancy styles, shadows,\n  gradients, or custom shape libraries \u2014 the default `rounded=0;whiteSpace=wrap;html=1;` vertex style\n  and default edge style are enough.\n- Lay out top-to-bottom or left-to-right in a simple grid; leave real spacing between cells\n  (`mxGeometry` `x`/`y`/`width`/`height`) so nothing overlaps.\n- Label every vertex and, where it clarifies the relationship, every edge.\n- Keep it as simple as the `about:` input allows \u2014 a diagram that's hard to read at a\n  glance has failed regardless of how much detail it captures.\n\n## Output\n\n1. Create `workspace/confluence/diagrams/` if it does not exist. Write the generated XML to\n   `workspace/confluence/diagrams/<name>.drawio` where `<name>` is the `name:` input,\n   kebab-cased (matches `slugify_diagram_name()` in\n   `sdlcd/workflows/confluence_sync/store/workspace.py`).\n2. Embed the diagram in the target page: open\n   `workspace/confluence/pages/<slug_path>` and insert\n\n   ````\n   ```drawio name=<name>\n   ```\n   ````\n\n   at the point in the document that fits the content you read in step 2 above (e.g. right after the\n   section it illustrates). Do not inline the XML in the fence body \u2014 the file you just wrote in step\n   1 is the diagram's source; the fence only needs to reference it by name. Don't touch anything else\n   in the page's markdown, and never edit inside a ` ```confluence-raw ` fence.\n\nReport: the diagram's file path, the page it was embedded in and roughly where, and a one-line\ndescription of what it shows. Note explicitly: \"The deterministic publish step ships this diagram\n(and this page's edits) to Confluence \u2014 nothing is published yet.\"\n",
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

export interface KnowledgeComment {
  /** Immutable reply target; absent on legacy fixture rows. */
  parent_id?: string | null;
  id: string;
  doc_id: string;
  body: string;
  author: string;
  created_at: string;
  /** ISO when the author changed the text; the panel renders "(edited)". */
  edited_at?: string | null;
  /**
   * ISO when the author removed it. A SOFT delete: the row keeps its place in
   * the thread and says it was removed, because a hard delete leaves a gap in
   * a conversation other people are mid-way through reading.
   */
  deleted_at?: string | null;
}

/**
 * Comments on a document.
 *
 * These did not exist here at all, and the consequence was visible rather than
 * theoretical: `POST /knowledge/doc/comment` had an INSERT and no SELECT
 * anywhere, so a comment was write-only. The pane assembled its thread from
 * this session's SSE echoes plus the realtime gateway's channel, which means
 * that with the gateway offline a comment vanished on reload and the drawer
 * then said "No comments on this document yet" — a sentence that was false,
 * about a comment the reader had just written.
 *
 * Seeded so the surface shows a real thread rather than an empty box, and
 * REGISTERED so `POST /api/__mock/reset` undoes anything a session adds, which
 * is what the mock floor asks of a write.
 */
export interface KnowledgeReaction {
  target_id: string;
  emoji: string;
  actor: string;
  created_at: string;
}

/**
 * Reactions on a document or on one of its comments.
 *
 * Reactions used to exist ONLY over the realtime gateway — no endpoint, no
 * broker event, no persistence — so with the gateway down the control could
 * not reach anything, and even with it up a reaction did not survive a
 * restart. This is the durable half, the same move the comment thread got.
 *
 * `target_id` is a doc id or a comment id; the two namespaces do not collide
 * (`prompt:…` / `rule:…` / `ec:…` versus `kc-…` / `comment-…`). One row per
 * (target, emoji, actor) — the key IS the toggle, so reacting twice is an add
 * then a remove rather than a count of two.
 */
export const knowledgeReactionsFixture = defineFixture<KnowledgeReaction>({
  key: 'assessment-knowledge-reactions',
  scenarios: {
    default: () => [
      { target_id: 'prompt:classify-transcript.md', emoji: '👍', actor: 'u-asha', created_at: daysAgo(3) },
      { target_id: 'prompt:classify-transcript.md', emoji: '👍', actor: 'u-jonas', created_at: daysAgo(3) },
      { target_id: 'kc-classify-01', emoji: '🎯', actor: 'u-farah', created_at: daysAgo(3) },
      { target_id: 'kc-rubric-01', emoji: '👍', actor: 'u-farah', created_at: daysAgo(5) },
      { target_id: 'page:100002', emoji: '🎯', actor: 'u-jonas', created_at: daysAgo(6) },
    ],
    empty: () => [],
    // A document whose reactions cannot be read is not a document nobody
    // reacted to; the bar has to be able to tell those apart.
    error: () => { throw new Error('assessment_knowledge_reactions unavailable: relation does not exist'); },
  },
});

export const knowledgeReactions = (targetId: string): KnowledgeReaction[] =>
  knowledgeReactionsFixture.rows().filter((r) => r.target_id === targetId);

export const knowledgeCommentsFixture = defineFixture<KnowledgeComment>({
  key: 'assessment-knowledge-comments',
  scenarios: {
    default: () => [
      {
        parent_id: null, id: 'kc-classify-01', doc_id: 'prompt:classify-transcript.md',
        author: 'u-asha',
        body: 'Worth flagging: the dimension ids here are plain numbers ("1".."17"). '
          + 'We had a run last month that emitted "DIM-01" and apply-classification rejected '
          + 'every envelope until someone read the verb output.',
        created_at: daysAgo(4),
      },
      {
        parent_id: 'kc-classify-01', id: 'kc-classify-02', doc_id: 'prompt:classify-transcript.md',
        author: 'u-farah',
        body: 'Agreed — and the strictness is deliberate, since relevant_dimension_ids is what '
          + 'decides which dimensions a later /score-dimensions pass touches at all.',
        created_at: daysAgo(4),
        // One seeded comment carries an edit so the panel's "(edited)" marker
        // is reachable without an auditor having to write and rewrite a
        // comment first. `deleted_at` is deliberately NOT seeded: a tombstone
        // in the seed is a comment nobody ever wrote, and the state is one
        // POST + one DELETE away for anyone who wants to see it.
        edited_at: daysAgo(3),
      },
      // A thread on the synced Rubric Overview page (page:100002) — the one the
      // documents parity journey opens. It predates the move of document
      // comments to platform-api, so it is what the one-time import carries
      // across (providers/document-comment-import.ts): ids, authors, times and
      // the reply edge survive, and the reaction below stays keyed by the same
      // comment id.
      {
        parent_id: null, id: 'kc-rubric-01', doc_id: 'page:100002',
        author: 'u-jonas',
        body: 'The "Partially met" band needs an example — two teams scored the same evidence differently last cycle.',
        created_at: daysAgo(6),
      },
      {
        parent_id: 'kc-rubric-01', id: 'kc-rubric-02', doc_id: 'page:100002',
        author: 'u-farah',
        body: 'Agreed. I will add the release-gate example from the payments review to the draft.',
        created_at: daysAgo(5),
      },
      {
        parent_id: 'kc-rubric-02', id: 'kc-rubric-03', doc_id: 'page:100002',
        author: 'u-jonas',
        body: 'Thanks — the payments example is the one I had in mind.',
        created_at: hoursAgo(2),
      },
      {
        parent_id: null, id: 'kc-evidence-01', doc_id: 'rule:what-counts-as-evidence.md',
        author: 'u-jonas',
        body: 'The "verbal confirmation" line is the one teams push back on most. '
          + 'It is not a judgement about the team, it is about what a later reader can check.',
        created_at: daysAgo(2),
      },
      {
        parent_id: 'kc-evidence-01', id: 'kc-evidence-02', doc_id: 'rule:what-counts-as-evidence.md',
        author: 'u-farah',
        body: '@Asha Nair can you check the verbal-confirmation line against last cycle?',
        created_at: hoursAgo(5),
      },
      // The two failed runs, and who is doing something about each.
      {
        parent_id: null, id: 'kc-confluence-01', doc_id: 'prompt:suggest-confluence-content.md',
        author: 'u-jonas',
        body: 'Suggest Confluence Content failed for Data Platform because the ENG-DATA space is not linked to the team. '
          + 'Farah, can you link it before Elena\'s review?',
        created_at: at(HB.t4Failed - 0.5),
      },
      {
        parent_id: 'kc-confluence-01', id: 'kc-confluence-02', doc_id: 'prompt:suggest-confluence-content.md',
        author: 'u-farah',
        body: 'Yes. I have asked the Confluence admins for read access to the space and will link it, then re-run, once it lands.',
        created_at: at(HB.t4Failed - 3),
      },
      {
        parent_id: null, id: 'kc-selfassess-01', doc_id: 'prompt:process-self-assessment.md',
        author: 'u-farah',
        body: 'Process Self-Assessment stopped for Notifications Service: no repositories are linked, so the three answers had nothing to be checked against. '
          + 'I will ask Martina for the repository URLs.',
        created_at: at(HB.t5Failed - 1),
      },
      {
        parent_id: 'kc-selfassess-01', id: 'kc-selfassess-02', doc_id: 'prompt:process-self-assessment.md',
        author: 'u-asha',
        body: 'She mentioned two services on the intake call, the sender and the template renderer. Worth asking for both.',
        created_at: at(HB.t5Failed - 3),
      },
    ],
    empty: () => [],
    // A thread that cannot be read is not a thread with nothing in it. The
    // drawer has to say which of the two it is looking at.
    error: () => { throw new Error('assessment_knowledge_comments unavailable: relation does not exist'); },
  },
});

export const knowledgeComments = (docId: string): KnowledgeComment[] =>
  knowledgeCommentsFixture.rows()
    .filter((c) => c.doc_id === docId)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));

export const knowledgeDocsFixture = defineFixture<KnowledgeDoc>({
  key: 'assessment-knowledge-docs',
  scenarios: {
    default: () => Object.values(seedKnowledgeDocs()),
    empty: () => [],
    // The SECTIONS fixture beside this one has had an `error` branch all
    // along, so a failed tree read was auditable while a failed DOCUMENT read
    // was not — the rail could say it was broken and the pane it opens into
    // could not. `DocPane` has an ErrorState for exactly this ("Couldn't load
    // this document"); without a branch here there was no way to reach it on
    // purpose, and no way to tell that state apart from a document that is
    // genuinely empty.
    error: () => {
      throw new Error('assessment_knowledge_docs unavailable: relation does not exist');
    },
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
