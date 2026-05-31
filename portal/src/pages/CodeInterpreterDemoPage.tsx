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

// ─── Class helpers ────────────────────────────────────────────────────────────

const editorClass =
  'w-full min-h-[280px] text-[12.5px] leading-relaxed bg-surface text-text-primary ' +
  'border border-border rounded-md px-3.5 py-3 resize-y outline-none box-border ' +
  'font-["Fira_Code","Cascadia_Code","JetBrains_Mono",monospace]';

const outputClass =
  'w-full min-h-40 text-[12.5px] leading-relaxed text-text-secondary bg-[var(--color-bg)] ' +
  'border border-border rounded-md px-3.5 py-3 resize-none outline-none box-border cursor-default ' +
  'font-["Fira_Code","Cascadia_Code","JetBrains_Mono",monospace]';

function statusChip(ok: boolean) {
  return (
    <span className={`px-2 py-0.5 rounded-full text-[11px] font-semibold ${ok ? 'bg-success-bg text-success' : 'bg-danger-bg text-danger'}`}>
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
      <div className="grid grid-cols-[1fr_380px] gap-5 items-start">

        {/* ── Left: editor + output ── */}
        <div className="flex flex-col gap-3">
          <Card>
            <div className="flex items-center gap-2 mb-2.5">
              <span className="text-xs font-semibold text-text-secondary">
                SNIPPET
              </span>
              <select
                onChange={e => setCode(SNIPPETS[Number(e.target.value)].code)}
                className="flex-1 px-2 py-1 text-xs bg-[var(--color-bg)] text-text-primary border border-border rounded-sm"
              >
                {SNIPPETS.map((s, i) => (
                  <option key={i} value={i}>{s.label}</option>
                ))}
              </select>
              <button
                onClick={run}
                disabled={running}
                className={`px-[18px] py-1.5 border-none rounded-md font-semibold text-[13px] whitespace-nowrap ${running ? 'bg-surface-hover text-text-secondary cursor-not-allowed' : 'bg-primary text-white cursor-pointer'}`}
              >
                {running ? '⏳ Running…' : '▶ Run'}
              </button>
            </div>

            <textarea
              className={editorClass}
              value={code}
              onChange={e => setCode(e.target.value)}
              spellCheck={false}
            />
          </Card>

          <Card>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xs font-semibold text-text-secondary">
                OUTPUT
              </span>
              {active && (
                <>
                  {statusChip(!active.error)}
                  <span className="text-[11px] text-text-tertiary">
                    {active.durationMs}ms · session {active.sessionId.slice(-8)}
                  </span>
                </>
              )}
            </div>
            <textarea
              className={outputClass}
              readOnly
              value={active ? (active.error ? `ERROR: ${active.error}\n\n${active.output}` : active.output) : ''}
            />
          </Card>
        </div>

        {/* ── Right: execution history ── */}
        <Card className="!p-0 overflow-hidden">
          <div className="px-3.5 py-3 border-b border-border text-xs font-semibold text-text-secondary">
            EXECUTION HISTORY
          </div>
          {history.length === 0 ? (
            <div className="p-5 text-center text-[13px] text-text-tertiary">
              No executions yet — hit Run
            </div>
          ) : (
            <div className="overflow-y-auto max-h-[600px]">
              {history.map(entry => (
                <div
                  key={entry.id}
                  onClick={() => { setSelected(entry); setCode(entry.code); }}
                  className={`px-3.5 py-2.5 border-b border-border cursor-pointer ${active?.id === entry.id ? 'bg-surface-hover' : 'bg-transparent'}`}
                >
                  <div className="flex justify-between items-center mb-1">
                    {statusChip(!entry.error)}
                    <span className="text-[11px] text-text-tertiary">
                      {entry.durationMs}ms
                    </span>
                  </div>
                  <div className="font-mono text-[11px] text-text-secondary overflow-hidden text-ellipsis whitespace-nowrap">
                    {entry.code.trim().split('\n').find(l => l.trim() && !l.startsWith('#')) ?? entry.code.trim().slice(0, 60)}
                  </div>
                  <div className="text-[11px] text-text-tertiary mt-0.5">
                    {new Date(entry.ranAt).toLocaleTimeString()} · {entry.sessionId.slice(-8)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* ── How it works explainer ── */}
      <Card className="mt-5">
        <div className="text-xs font-semibold text-text-secondary mb-2">
          HOW IT WORKS
        </div>
        <div className="grid grid-cols-4 gap-3">
          {[
            { step: '1', label: 'Start Session', detail: 'AWS provisions an isolated Python 3 sandbox (RESTRICTED network)' },
            { step: '2', label: 'Execute Code', detail: 'Your Python runs in the sandbox — stdout/stderr captured and returned' },
            { step: '3', label: 'Stream Results', detail: 'Output streams back via InvokeCodeInterpreter event stream' },
            { step: '4', label: 'Stop Session', detail: 'Session is terminated and sandbox destroyed after execution' },
          ].map(({ step, label, detail }) => (
            <div key={step} className="p-3 bg-[var(--color-bg)] rounded-md border border-border">
              <div className="flex items-center gap-1.5 mb-1">
                <span className="w-5 h-5 rounded-full bg-primary text-white text-[11px] font-bold flex items-center justify-center">
                  {step}
                </span>
                <span className="text-xs font-semibold">{label}</span>
              </div>
              <div className="text-[11px] text-text-secondary leading-normal">{detail}</div>
            </div>
          ))}
        </div>
      </Card>
    </PageSection>
  );
}
