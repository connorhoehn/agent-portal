// Which enterprise standard each dimension is measured against
// (docs/assessment-ux-goal.md slice 5). The standards themselves live in the
// enterprise-context knowledge tree (`GET /api/assessment/knowledge/tree`,
// the Enterprise page) as editable documents; this table only says WHICH
// document governs a dimension, by the tree's own node id, so the detail pane
// can name the standard and link into the explorer at `?doc=<id>`.
//
// A dimension with no entry is an honest gap, not a rendering fault: the
// pane says so and links to the standards folder, because "there is no
// enterprise standard for performance testing yet" is itself a finding an
// assessment should surface to the SDLC owners.

export interface DimensionStandard {
  /** Knowledge-tree node id, e.g. `ec:standards/ci-cd-standards.md`. */
  docId: string;
  /** The clause of the standard the dimension's rubric encodes. */
  clause: string;
}

export const STANDARDS_FOLDER_ID = 'ec:standards';

const CI_CD = 'ec:standards/ci-cd-standards.md';
const SECURITY = 'ec:standards/security-baseline.md';
const RACI = 'ec:organization/raci.md';
const TOOLS = 'ec:tooling/approved-tools.md';

export const DIMENSION_STANDARDS: Record<string, DimensionStandard> = {
  '1': { docId: CI_CD, clause: 'CI on every push; a passing build before merge' },
  '2': { docId: CI_CD, clause: 'pipeline definitions in version control on the approved template' },
  '3': { docId: CI_CD, clause: 'required checks — build, automated tests, lint / static analysis' },
  '4': { docId: CI_CD, clause: 'pipeline definitions live in version control' },
  '5': { docId: CI_CD, clause: 'automated tests are a required check' },
  '6': { docId: SECURITY, clause: 'SAST and dependency scanning in CI for customer-data repositories' },
  '8': { docId: SECURITY, clause: 'findings triaged within 5 business days' },
  '9': { docId: RACI, clause: 'who scores, approves and publishes' },
  '10': { docId: SECURITY, clause: 'runtime findings triaged within 5 business days' },
  '11': { docId: TOOLS, clause: 'Terraform and Ansible for environments' },
  '12': { docId: CI_CD, clause: 'a passing build before merge' },
  '13': { docId: TOOLS, clause: 'GitLab CI, Terraform, Ansible, Grafana, Splunk; new tooling via the platform review board' },
  '16': { docId: RACI, clause: 'target-level changes are the program lead\'s call' },
};

export const standardFor = (dimensionId: string): DimensionStandard | null =>
  DIMENSION_STANDARDS[dimensionId] ?? null;

/** Explorer deep link for a knowledge-tree node. */
export const enterpriseDocPath = (docId: string): string =>
  `/assessment/enterprise?doc=${encodeURIComponent(docId)}`;
