import { useState, useRef } from 'react';
import { PageSection, Card } from '@connorhoehnslalom/ui-components/shared';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ExecResult {
  id: string;
  code: string;
  output: string;
  durationMs: number;
  sessionId: string;
  error?: string;
  ranAt: string;
}

// ─── Demo snippets ────────────────────────────────────────────────────────────

const SNIPPETS: { label: string; code: string }[] = [
  {
    label: 'PageRank — sample graph',
    code: `# Iterative PageRank on a small org graph (no network needed)
import math

nodes = ['alice', 'bob', 'carol', 'dave', 'eve']
edges = [
    ('alice', 'bob'), ('alice', 'carol'), ('bob', 'dave'),
    ('carol', 'dave'), ('dave', 'eve'), ('eve', 'alice'),
    ('bob', 'carol'), ('carol', 'eve'),
]

d = 0.85
N = len(nodes)
pr = {n: 1 / N for n in nodes}
in_links = {n: [] for n in nodes}
for src, dst in edges:
    in_links[dst].append(src)
out_count = {n: sum(1 for s, _ in edges if s == n) for n in nodes}

for _ in range(30):
    new_pr = {}
    for n in nodes:
        rank = (1 - d) / N
        for src in in_links[n]:
            rank += d * pr[src] / max(out_count[src], 1)
        new_pr[n] = rank
    pr = new_pr

ranked = sorted(pr.items(), key=lambda x: x[1], reverse=True)
print("PageRank scores:")
for name, score in ranked:
    bar = '█' * int(score * 200)
    print(f"  {name:<8} {score:.4f}  {bar}")
`,
  },
  {
    label: 'Betweenness centrality',
    code: `# Brandes betweenness centrality
from collections import deque

nodes = ['alice', 'bob', 'carol', 'dave', 'eve', 'frank']
edges = [
    ('alice', 'bob'), ('alice', 'carol'), ('bob', 'dave'),
    ('carol', 'dave'), ('dave', 'eve'), ('eve', 'frank'),
    ('bob', 'carol'), ('carol', 'eve'), ('alice', 'dave'),
]
# Build adjacency (undirected)
adj = {n: set() for n in nodes}
for u, v in edges:
    adj[u].add(v); adj[v].add(u)

bc = {n: 0.0 for n in nodes}

for s in nodes:
    stack, paths, sigma, dist, delta = [], {n: [] for n in nodes}, {n: 0 for n in nodes}, {n: -1 for n in nodes}, {n: 0.0 for n in nodes}
    sigma[s] = 1; dist[s] = 0
    q = deque([s])
    while q:
        v = q.popleft(); stack.append(v)
        for w in adj[v]:
            if dist[w] < 0:
                q.append(w); dist[w] = dist[v] + 1
            if dist[w] == dist[v] + 1:
                sigma[w] += sigma[v]; paths[w].append(v)
    while stack:
        w = stack.pop()
        for v in paths[w]:
            delta[v] += (sigma[v] / sigma[w]) * (1 + delta[w])
        if w != s:
            bc[w] += delta[w]

ranked = sorted(bc.items(), key=lambda x: x[1], reverse=True)
print("Betweenness centrality (higher = more of a connector):")
for name, score in ranked:
    bar = '█' * int(score * 3)
    print(f"  {name:<8} {score:.2f}  {bar}")
`,
  },
  {
    label: 'Expertise distribution analysis',
    code: `# Simulate score distribution and compute stats
import math, random
random.seed(42)

people = [
    {'name': 'Alice', 'skills': 8, 'collabs': 12, 'projects': 5},
    {'name': 'Bob',   'skills': 5, 'collabs': 7,  'projects': 3},
    {'name': 'Carol', 'skills': 6, 'collabs': 9,  'projects': 4},
    {'name': 'Dave',  'skills': 3, 'collabs': 4,  'projects': 2},
    {'name': 'Eve',   'skills': 7, 'collabs': 11, 'projects': 6},
    {'name': 'Frank', 'skills': 2, 'collabs': 3,  'projects': 1},
]

# Weighted in-degree proxy
for p in people:
    p['raw'] = p['skills'] * 1.0 + p['collabs'] * 0.8 + p['projects'] * 1.2

max_raw = max(p['raw'] for p in people)
for p in people:
    p['score'] = round(p['raw'] / max_raw * 100, 1)

scores = [p['score'] for p in people]
mean = sum(scores) / len(scores)
variance = sum((s - mean) ** 2 for s in scores) / len(scores)
stddev = math.sqrt(variance)

print(f"Expertise Score Distribution")
print(f"  Mean:   {mean:.1f}")
print(f"  StdDev: {stddev:.1f}")
print(f"  Min:    {min(scores):.1f}  Max: {max(scores):.1f}")
print()
people.sort(key=lambda p: p['score'], reverse=True)
print("Leaderboard:")
for i, p in enumerate(people, 1):
    bar = '█' * int(p['score'] / 5)
    print(f"  {i}. {p['name']:<8} {p['score']:>5.1f}  {bar}")
`,
  },
  {
    label: 'JSON entity extraction helper',
    code: `# Parse & deduplicate entities from raw NER output
import json, re

raw = """
  Alice Smith (alice@acme.com) — Platform Engineering lead
  Works with Bob Jones on the Kubernetes migration project.
  Skills: Python, Kubernetes, AWS, Terraform
  Bob Jones joined the DevOps team in Q1.
  Alice and Carol Lee collaborate on Architecture reviews.
"""

# Extract names (Title Case word pairs)
names = list(dict.fromkeys(re.findall(r'\\b([A-Z][a-z]+ [A-Z][a-z]+)\\b', raw)))
# Extract skills (capitalised single words after "Skills:")
skills_match = re.search(r'Skills:\\s*([^\\n]+)', raw)
skills = [s.strip() for s in skills_match.group(1).split(',')] if skills_match else []
# Extract emails
emails = re.findall(r'[\\w.+-]+@[\\w-]+\\.[a-z]+', raw)

result = {
    "people": [{"id": n.lower().replace(' ', '_'), "name": n} for n in names],
    "skills": [{"id": s.lower().replace(' ', '_'), "name": s} for s in skills],
    "emails": emails,
}
print(json.dumps(result, indent=2))
`,
  },
];

// ─── Styles ───────────────────────────────────────────────────────────────────

const editorStyle: React.CSSProperties = {
  width: '100%',
  minHeight: 280,
  fontFamily: '"Fira Code", "Cascadia Code", "JetBrains Mono", monospace',
  fontSize: 12.5,
  lineHeight: 1.6,
  background: 'var(--color-surface)',
  color: 'var(--color-text)',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-md)',
  padding: '12px 14px',
  resize: 'vertical',
  outline: 'none',
  boxSizing: 'border-box',
};

const outputStyle: React.CSSProperties = {
  ...editorStyle,
  minHeight: 160,
  resize: 'none',
  color: 'var(--color-text-secondary)',
  background: 'var(--color-bg)',
  cursor: 'default',
};

function statusChip(ok: boolean) {
  return (
    <span style={{
      padding: '2px 8px',
      borderRadius: 99,
      fontSize: 11,
      fontWeight: 600,
      background: ok ? 'var(--color-success-bg, #dcfce7)' : 'var(--color-error-bg, #fee2e2)',
      color: ok ? 'var(--color-success, #16a34a)' : 'var(--color-error, #dc2626)',
    }}>
      {ok ? 'OK' : 'ERROR'}
    </span>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function CodeInterpreterDemoPage() {
  const [code, setCode] = useState(SNIPPETS[0].code);
  const [running, setRunning] = useState(false);
  const [history, setHistory] = useState<ExecResult[]>([]);
  const [selected, setSelected] = useState<ExecResult | null>(null);
  const idRef = useRef(0);

  async function run() {
    if (running || !code.trim()) return;
    setRunning(true);
    const startedAt = new Date().toISOString();
    try {
      const res = await fetch('/api/capabilities/code-interpreter/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, language: 'python' }),
      });
      const data = await res.json();
      const entry: ExecResult = {
        id: String(++idRef.current),
        code,
        output: data.output ?? '',
        durationMs: data.durationMs ?? 0,
        sessionId: data.sessionId ?? '',
        error: data.error,
        ranAt: startedAt,
      };
      setHistory(prev => [entry, ...prev].slice(0, 20));
      setSelected(entry);
    } finally {
      setRunning(false);
    }
  }

  const active = selected ?? history[0] ?? null;

  return (
    <PageSection title="Code Interpreter — Live Demo">
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 380px', gap: 20, alignItems: 'start' }}>

        {/* ── Left: editor + output ── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Card>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)' }}>
                SNIPPET
              </span>
              <select
                onChange={e => setCode(SNIPPETS[Number(e.target.value)].code)}
                style={{
                  flex: 1, padding: '4px 8px', fontSize: 12,
                  background: 'var(--color-bg)', color: 'var(--color-text)',
                  border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)',
                }}
              >
                {SNIPPETS.map((s, i) => (
                  <option key={i} value={i}>{s.label}</option>
                ))}
              </select>
              <button
                onClick={run}
                disabled={running}
                style={{
                  padding: '6px 18px',
                  background: running ? 'var(--color-surface-hover)' : 'var(--color-primary)',
                  color: running ? 'var(--color-text-secondary)' : '#fff',
                  border: 'none',
                  borderRadius: 'var(--radius-md)',
                  fontWeight: 600,
                  fontSize: 13,
                  cursor: running ? 'not-allowed' : 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                {running ? '⏳ Running…' : '▶ Run'}
              </button>
            </div>

            <textarea
              style={editorStyle}
              value={code}
              onChange={e => setCode(e.target.value)}
              spellCheck={false}
            />
          </Card>

          <Card>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)' }}>
                OUTPUT
              </span>
              {active && (
                <>
                  {statusChip(!active.error)}
                  <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
                    {active.durationMs}ms · session {active.sessionId.slice(-8)}
                  </span>
                </>
              )}
            </div>
            <textarea
              style={outputStyle}
              readOnly
              value={active ? (active.error ? `ERROR: ${active.error}\n\n${active.output}` : active.output) : ''}
            />
          </Card>
        </div>

        {/* ── Right: execution history ── */}
        <Card style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--color-border)', fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)' }}>
            EXECUTION HISTORY
          </div>
          {history.length === 0 ? (
            <div style={{ padding: 20, textAlign: 'center', fontSize: 13, color: 'var(--color-text-tertiary)' }}>
              No executions yet — hit Run
            </div>
          ) : (
            <div style={{ overflowY: 'auto', maxHeight: 600 }}>
              {history.map(entry => (
                <div
                  key={entry.id}
                  onClick={() => { setSelected(entry); setCode(entry.code); }}
                  style={{
                    padding: '10px 14px',
                    borderBottom: '1px solid var(--color-border)',
                    cursor: 'pointer',
                    background: active?.id === entry.id ? 'var(--color-surface-hover)' : 'transparent',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                    {statusChip(!entry.error)}
                    <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
                      {entry.durationMs}ms
                    </span>
                  </div>
                  <div style={{
                    fontFamily: 'monospace',
                    fontSize: 11,
                    color: 'var(--color-text-secondary)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}>
                    {entry.code.trim().split('\n').find(l => l.trim() && !l.startsWith('#')) ?? entry.code.trim().slice(0, 60)}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 2 }}>
                    {new Date(entry.ranAt).toLocaleTimeString()} · {entry.sessionId.slice(-8)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* ── How it works explainer ── */}
      <Card style={{ marginTop: 20 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 8 }}>
          HOW IT WORKS
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
          {[
            { step: '1', label: 'Start Session', detail: 'AWS provisions an isolated Python 3 sandbox (RESTRICTED network)' },
            { step: '2', label: 'Execute Code', detail: 'Your Python runs in the sandbox — stdout/stderr captured and returned' },
            { step: '3', label: 'Stream Results', detail: 'Output streams back via InvokeCodeInterpreter event stream' },
            { step: '4', label: 'Stop Session', detail: 'Session is terminated and sandbox destroyed after execution' },
          ].map(({ step, label, detail }) => (
            <div key={step} style={{ padding: 12, background: 'var(--color-bg)', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <span style={{
                  width: 20, height: 20, borderRadius: '50%', background: 'var(--color-primary)',
                  color: '#fff', fontSize: 11, fontWeight: 700,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  {step}
                </span>
                <span style={{ fontSize: 12, fontWeight: 600 }}>{label}</span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>{detail}</div>
            </div>
          ))}
        </div>
      </Card>
    </PageSection>
  );
}
