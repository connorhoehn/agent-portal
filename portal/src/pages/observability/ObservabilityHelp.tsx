// Help overlay — a click-to-expand "what are these tabs?" panel.
// Rendered above the SubNav so a new researcher can learn the surface area
// without leaving the page. Each entry: WHEN to open it + WHAT to look at.
// Keep blurbs short — this is a refresher, not documentation.

import { useState } from 'react';
import type { CSSProperties } from 'react';

interface HelpEntry {
  group: 'Operate' | 'Triage' | 'Quality' | 'Eval' | 'Governance';
  path: string;
  label: string;
  when: string;
  look: string;
}

const ENTRIES: HelpEntry[] = [
  // Operate — daily health + cost
  { group: 'Operate', path: 'oncall', label: 'On-Call',
    when: 'A drift alarm fired at 3am, or you start the day and want one screen of system health.',
    look: 'Active alarms strip, the unified timeline (drift + cost + errors + deploys), HITL SLA.' },
  { group: 'Operate', path: 'summary', label: 'Summary',
    when: 'You want a 24h headline number for an exec or your own scan.',
    look: 'Total invocations, error rate, token usage, latency p50.' },
  { group: 'Operate', path: 'cost', label: 'Cost',
    when: 'Weekly cost review or a "why is the Bedrock bill spiking" investigation.',
    look: 'Stacked bars per agent over time with deploy markers; top-N expensive invocations; A2A overhead.' },
  { group: 'Operate', path: 'traffic', label: 'Traffic',
    when: 'Capacity question — "can we hold 3× traffic" or "who is hitting us most".',
    look: 'RPS-over-time area chart, hour-of-week heatmap, top users by cost.' },
  { group: 'Operate', path: 'agents', label: 'Agent Metrics',
    when: 'Quick per-agent operational stats from CloudWatch native metrics.',
    look: 'Bedrock invocations + tokens by model.' },

  // Triage — debug a specific failure
  { group: 'Triage', path: 'invocations', label: 'Recent',
    when: 'Eyeball check — what just ran. No filters.',
    look: 'The most recent 50 calls with prompt/response snippet + status chips.' },
  { group: 'Triage', path: 'invocations/search', label: 'Search',
    when: 'A user reported a bad answer — you need to find that specific call.',
    look: 'Filter by agent, prompt substring, score range, time window, prompt-version.' },
  { group: 'Triage', path: 'capability-events', label: 'Capability Events',
    when: 'A code-interpreter or browser invocation misbehaved.',
    look: 'Per-event detail: which sandbox URL, which exec, screenshots.' },
  { group: 'Triage', path: 'sessions', label: 'Sessions',
    when: 'Replay a multi-turn conversation thread.',
    look: 'Per-session URLs visited, extracted text, judge scores in order.' },
  { group: 'Triage', path: 'memory', label: 'Memory',
    when: 'Agent seems to "forget" or retrieve stale context.',
    look: 'Per-agent retrieve/write counts, p99 latency, cold-session warnings.' },

  // Quality — model output behavior
  { group: 'Quality', path: 'drift', label: 'Drift',
    when: 'You want to know if outputs are getting worse over time.',
    look: 'P95 cosine distance to centroid, schema conformance, judge P05 (worst tail). By-template breakdown.' },
  { group: 'Quality', path: 'quality', label: 'Quality',
    when: 'You want the headline "are responses any good" view + label them.',
    look: 'Judge score time series, histogram, recent invocations with 👍/👎 feedback.' },
  { group: 'Quality', path: 'guardrail-rules', label: 'Guardrail Rules',
    when: 'You see "BLOCKED" interventions and need to know which rule fired.',
    look: 'Top firing rules with severity, click → per-rule interventions + matched text.' },

  // Eval — pre-deploy gate + judge sanity
  { group: 'Eval', path: 'harness', label: 'Harness',
    when: "Before merging a prompt change — run the curated test set and check for regressions.",
    look: 'Recent runs, pass-rate sparkline, run detail (regressions vs baseline + cost delta).' },
  { group: 'Eval', path: 'calibration', label: 'Calibration',
    when: '"Can I trust the judge?" — periodically re-run judge against human-graded cases.',
    look: 'MAE trend, judge-vs-human scatter, worst-disagreement cases.' },
  { group: 'Eval', path: 'model-compare', label: 'Model Compare',
    when: 'Nova v2 dropped — should we move? Or you ran the same test set on a different model.',
    look: 'Side-by-side run picker, per-case score deltas, cost + latency deltas, MAE differences.' },

  // Governance — who saw / approved / changed
  { group: 'Governance', path: 'authz', label: 'Authz Log',
    when: 'A "who can do X" question, or a Cedar policy audit trail.',
    look: 'Live ALLOW/DENY decisions stream with role + action + resource.' },
  { group: 'Governance', path: 'approvals', label: 'Approval Queue',
    when: 'You\'re the human in the loop for high-stakes actions.',
    look: 'Pending approvals with txId, agent, payload, approve/reject + note.' },
];

const GROUP_ORDER: HelpEntry['group'][] = ['Operate', 'Triage', 'Quality', 'Eval', 'Governance'];
const GROUP_BLURB: Record<HelpEntry['group'], string> = {
  Operate: 'Daily-driver health & cost views.',
  Triage: '"Find that one failure" workflow.',
  Quality: 'Are the model outputs any good?',
  Eval: 'Decisions about prompt or model changes.',
  Governance: 'Who saw what + who approved what.',
};

export function ObservabilityHelp() {
  const [open, setOpen] = useState(false);

  return (
    <div style={wrap}>
      <button onClick={() => setOpen((v) => !v)} style={toggle} aria-expanded={open}>
        <span>{open ? '▾' : '▸'}</span>
        <span>What are these tabs?</span>
        <span style={toggleHint}>{open ? 'tap to collapse' : 'click for a tour'}</span>
      </button>
      {open && (
        <div style={panel}>
          {GROUP_ORDER.map((g) => {
            const entries = ENTRIES.filter((e) => e.group === g);
            return (
              <section key={g} style={section}>
                <header style={sectionHead}>
                  <span style={sectionLabel}>{g}</span>
                  <span style={sectionBlurb}>{GROUP_BLURB[g]}</span>
                </header>
                <div style={grid}>
                  {entries.map((e) => (
                    <div key={e.path} style={card}>
                      <div style={cardTitle}>{e.label}</div>
                      <div style={cardBody}>
                        <div style={rowLabel}>When</div>
                        <div style={rowText}>{e.when}</div>
                        <div style={rowLabel}>Look at</div>
                        <div style={rowText}>{e.look}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

const wrap: CSSProperties = {
  padding: 0,
};

const toggle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 8,
  width: '100%',
  padding: '6px 12px',
  background: 'transparent',
  border: 'none',
  borderBottom: '1px solid var(--color-border)',
  color: 'var(--color-text-secondary)',
  fontSize: 11,
  fontWeight: 500,
  cursor: 'pointer',
  textAlign: 'left',
};

const toggleHint: CSSProperties = {
  marginLeft: 'auto',
  fontSize: 10,
  color: 'var(--color-text-tertiary)',
  fontWeight: 400,
};

const panel: CSSProperties = {
  padding: '8px 12px 12px',
  background: 'var(--color-bg)',
  borderBottom: '1px solid var(--color-border)',
  maxHeight: 360,
  overflowY: 'auto',
};

const section: CSSProperties = {
  marginBottom: 12,
};

const sectionHead: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  marginBottom: 4,
};

const sectionLabel: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  color: 'var(--color-text-tertiary)',
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
};

const sectionBlurb: CSSProperties = {
  fontSize: 10.5,
  color: 'var(--color-text-tertiary)',
  fontStyle: 'italic',
};

const grid: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};

const card: CSSProperties = {
  background: 'var(--color-surface)',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-sm)',
  padding: '8px 10px',
};

const cardTitle: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--color-text-primary)',
  marginBottom: 4,
};

const cardBody: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'auto 1fr',
  rowGap: 2,
  columnGap: 6,
};

const rowLabel: CSSProperties = {
  fontSize: 9.5,
  fontWeight: 700,
  color: 'var(--color-text-tertiary)',
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
  paddingTop: 1,
};

const rowText: CSSProperties = {
  fontSize: 11.5,
  color: 'var(--color-text-secondary)',
  lineHeight: 1.4,
};
