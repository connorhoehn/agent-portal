/** Self-disclosed profiles for the fictional demo cast. These are profile
 * statements, separate from inferred graph specialties and score evidence. */
export const demoPublicProfiles: Record<string, {
  skills: string[];
  credentials: { title: string; issuer: string; year: string }[];
  learning: { title: string; provider: string; year: string }[];
  projects: { id: string; name: string; role: string; contribution: string }[];
}> = {
  'p-004': {
    skills: ['OpenTelemetry', 'Platform engineering', 'TypeScript', 'Incident response'],
    credentials: [{ title: 'Certified Kubernetes Administrator', issuer: 'CNCF', year: '2025' }],
    learning: [{ title: 'OpenTelemetry instrumentation workshop', provider: 'Platform engineering cohort', year: '2026' }],
    projects: [{ id: 'p-observability', name: 'Observability Platform', role: 'Initiative owner', contribution: 'Collector rollout, alert quality, and telemetry cost controls.' }],
  },
  'p-008': {
    skills: ['Service reliability', 'Prometheus', 'SLOs', 'Terraform'],
    credentials: [{ title: 'AWS Certified DevOps Engineer – Professional', issuer: 'AWS', year: '2025' }],
    learning: [{ title: 'Site reliability engineering bootcamp', provider: 'Engineering learning cohort', year: '2024' }],
    projects: [{ id: 'p-observability', name: 'Observability Platform', role: 'Reliability lead', contribution: 'Burn-rate alerts, RED dashboards, and retirement of the StatsD bridge.' }],
  },
  'p-011': {
    skills: ['Telemetry pipelines', 'Capacity planning', 'CI guardrails', 'Go'],
    credentials: [{ title: 'Certified Kubernetes Application Developer', issuer: 'CNCF', year: '2025' }],
    learning: [{ title: 'Production readiness workshop', provider: 'Platform engineering cohort', year: '2026' }],
    projects: [{ id: 'p-observability', name: 'Observability Platform', role: 'Senior SRE', contribution: 'Metric cardinality budgets, burst-ingest resilience, and dependency outage tests.' }],
  },
  'p-002': {
    skills: ['Technical strategy', 'Architecture reviews', 'Engineering leadership', 'Delivery planning'],
    credentials: [{ title: 'AWS Certified Solutions Architect – Professional', issuer: 'AWS', year: '2024' }],
    learning: [{ title: 'Engineering leadership program', provider: 'Leadership learning cohort', year: '2025' }],
    projects: [{ id: 'p-observability', name: 'Observability Platform', role: 'Initiative sponsor', contribution: 'Aligning delivery priorities, review decisions, and the validation plan.' }],
  },
};
