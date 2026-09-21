// Computer Lab × chat — a visual prototype.
//
// THE IDEA. Chat is where everyone already is, so chat is where work gets
// started: type `/run`, pick the initiative, and the fleet opens BESIDE the
// conversation rather than replacing it. What opens is the real Computer Lab
// — the microVM multiplexer — with the queue of agents this conversation has
// dispatched sitting above it.
//
// THE PROBLEM IT IS TRYING TO SOLVE. The Active Now prototype's fourth pane
// showed node detail that was ahead of the product: an artifact node offering
// a slide preview, when nothing in the platform generates slides. A detail
// pane that invents its own contents teaches a viewer to distrust the whole
// screen, and it is the pane a demo lingers on.
//
// The answer here is a rule, applied to every inspector tab: PROVENANCE
// FIRST. Each one opens by saying what produced this and how — a run, a
// session, a skill — and shows nothing it cannot attribute. That gives three
// honest states instead of one fabricated one:
//
//   produced      a named run/skill did this: inputs, tool calls, cost, output
//   running       the session is live: what it has done so far, nothing more
//   unavailable   no capability registered can produce this — say so, name
//                 what would, and offer the action that would change it
//
// The third state is the interesting one. "No `pptx` skill is registered on
// this fleet" is a more useful screen than a fake slide preview, because it
// is a thing somebody can go and fix.
//
// WHAT IS REAL HERE. The chrome, the tokens and the Computer Lab are the
// shipped library — `ComputerLab` runs on its own fixtures with the provider
// disabled, so the panes, the terminals and the keyboard layer are the real
// ones. The conversation, the queue and the inspector contents are fixtures
// in this file, shaped after what the middleware actually returns
// (`agent_change_requests`, `bot_runs`, the devbox event stream) so that
// building them for real is a matter of wiring, not redesign.
//
// NOT FOR SHIPPING. Portal pages compose from the library; this file is a
// sketch to argue with. When a direction is agreed, it gets rebuilt from
// library composites, and anything missing goes to the library first.

import { useEffect, useMemo, useState } from 'react';
import { Avatar, Badge, Button, Tabs } from '@connorhoehnslalom/ui-components/shared';
import {
  ComputeProvider, ComputerLab, fixtureComputers, fixtureModels, fixtureRuntimeStatus,
  installMockShellSocket, installMockTailSource, mockShellUrl, mockTailUrl,
} from '@connorhoehnslalom/ui-components/compute';
import type { ComputeClient } from '@connorhoehnslalom/ui-components/compute';

// ─── Fixtures ────────────────────────────────────────────────────────────────
//
// Shaped after the seeded cast (schema/seed_program.sql) rather than invented
// names, so this prototype and the running app describe the same org.

interface Conversation {
  id: string;
  name: string;
  kind: 'dm' | 'channel';
  preview: string;
  when: string;
  unread?: number;
}

const CONVERSATIONS: Conversation[] = [
  { id: 'c-auth', name: '# auth-migration', kind: 'channel', preview: 'Nora: the shim cookie one is ready to hand off', when: '2m', unread: 3 },
  { id: 'c-nora', name: 'Nora DaSilva', kind: 'dm', preview: 'can you run that against the reader branch?', when: '18m' },
  { id: 'c-obs', name: '# observability', kind: 'channel', preview: 'Layla: span projector is still 1m behind', when: '1h' },
  { id: 'c-eli', name: 'Eli Garcia', kind: 'dm', preview: 'envelope is refreshed for sprint 42', when: '3h' },
];

const ACTIVE_NOW = [
  { name: 'Nora DaSilva', busy: true },
  { name: 'Eli Garcia', busy: true },
  { name: 'Layla Hassan', busy: false },
  { name: 'Priya Desai', busy: false },
];

type MessageKind = 'text' | 'run';

interface Message {
  id: string;
  author: string;
  mine?: boolean;
  at: string;
  kind: MessageKind;
  body: string;
  /** Present on `run` messages — the dispatch this message started. */
  run?: QueuedRun;
}

/** One dispatch. Mirrors what `POST /api/bots/dispatch-work` hands back. */
interface QueuedRun {
  id: string;
  command: string;
  instruction: string;
  initiative: string;
  model: string;
  computer: string;
  status: 'queued' | 'running' | 'review' | 'blocked';
  spendUsd: number;
  forecastUsd: [number, number];
}

const SEED_RUNS: QueuedRun[] = [
  {
    id: 'run-4471', command: '/run', instruction: 'Clear the legacy shim cookie on logout',
    initiative: 'Auth Migration', model: 'Sonnet', computer: 'auth-migration-3',
    status: 'review', spendUsd: 0.09, forecastUsd: [0.03, 0.30],
  },
  {
    id: 'run-4472', command: '/run', instruction: 'Backfill integration tests for the refresh path',
    initiative: 'Auth Migration', model: 'Haiku', computer: 'auth-migration-2',
    status: 'running', spendUsd: 0.04, forecastUsd: [0.02, 0.18],
  },
  {
    id: 'run-4469', command: '/deck', instruction: 'Turn the sprint review into slides',
    initiative: 'Auth Migration', model: 'Sonnet', computer: '—',
    status: 'blocked', spendUsd: 0, forecastUsd: [0, 0],
  },
];

const SEED_MESSAGES: Message[] = [
  { id: 'm1', author: 'Nora DaSilva', at: '09:14', kind: 'text',
    body: 'Logout still leaves the shim cookie behind. wi-auth-e2-b3 if you want the repro.' },
  { id: 'm2', author: 'You', mine: true, at: '09:16', kind: 'text',
    body: 'Two points and it is in the sprint — let us just put an agent on it.' },
  { id: 'm3', author: 'You', mine: true, at: '09:16', kind: 'run', body: '', run: SEED_RUNS[0]! },
  { id: 'm4', author: 'Nora DaSilva', at: '09:22', kind: 'text',
    body: 'Diff looks right. I approved it — the gate had already passed it on the protected-path check.' },
  { id: 'm5', author: 'Eli Garcia', at: '09:31', kind: 'run', body: '', run: SEED_RUNS[2]! },
  { id: 'm6', author: 'Eli Garcia', at: '09:31', kind: 'text',
    body: 'that one will not go — there is no deck skill on this fleet yet' },
];

/** The composer's command menu. `trigger`/`label`/`hint` are the library's
 *  own `ComposerCommand` shape, so this list is a drop-in when it is wired. */
const COMMANDS = [
  { trigger: '/run', label: 'Dispatch an agent', hint: 'pick an initiative · spends your sprint envelope', argument: 'initiative' },
  { trigger: '/terminal', label: 'Open a cloud terminal', hint: 'attach a shell to one of your computers', argument: 'computer' },
  { trigger: '/doc', label: 'Edit a document', hint: 'opens the document beside this conversation', argument: 'document' },
  { trigger: '/schedule', label: 'Put it on a schedule', hint: 'becomes a cron mission with its own budget', argument: 'initiative' },
  { trigger: '/deck', label: 'Build a deck', hint: 'no skill registered — see why', argument: 'document', unavailable: true },
];

/**
 * A ComputeClient with nothing behind it.
 *
 * `enabled={false}` stops the provider polling, but a terminal pane still has
 * to ASK for a shell URL before it can open a socket — so without this the
 * panes render and then sit on `error · Failed to fetch reattach`, which reads
 * as a broken product rather than an unplugged one. `mockShellUrl` and
 * `mockTailUrl` are the library's own answer: they mint the `mock-shell:` /
 * `mock-tail:` URLs the installed simulators recognise, which is the only
 * channel through which a simulator learns which shell it is meant to be.
 *
 * Every mutating method resolves without doing anything. A prototype should
 * not pretend to stop a machine it never started.
 */
const fixtureClient: ComputeClient = {
  getStatus: async () => fixtureRuntimeStatus,
  listComputers: async () => fixtureComputers,
  createComputer: async () => fixtureComputers[0]!,
  adoptComputer: async () => {},
  renameComputer: async () => {},
  removeComputer: async () => {},
  stopSession: async () => {},
  runTask: async () => {},
  runCommand: async () => {},
  getShellUrl: async (sessionId, shellId) => mockShellUrl(sessionId, shellId),
  tail: (boxId: string) => ({ url: mockTailUrl(boxId), withCredentials: false }),
} as unknown as ComputeClient;

// ─── Inspector contents ──────────────────────────────────────────────────────
//
// The point of the prototype. Every tab leads with provenance.

type Provenance =
  | { state: 'produced'; by: string; kind: string; at: string }
  | { state: 'running'; by: string; kind: string; since: string }
  | { state: 'unavailable'; missing: string; wouldBe: string };

function ProvenanceLine({ p }: { p: Provenance }) {
  if (p.state === 'unavailable') {
    return (
      <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2">
        <div className="text-xs font-semibold uppercase tracking-wide text-warning">Not available</div>
        <div className="mt-1 text-sm text-text">
          Nothing on this fleet can produce it. <span className="font-mono text-xs">{p.missing}</span> is
          not registered.
        </div>
        <div className="mt-1 text-xs text-text-secondary">{p.wouldBe}</div>
      </div>
    );
  }
  const live = p.state === 'running';
  return (
    <div className="rounded-md border border-border bg-surface-inset px-3 py-2">
      <div className="flex items-center gap-2">
        <span className={`h-1.5 w-1.5 rounded-full ${live ? 'bg-success' : 'bg-text-tertiary'}`} />
        <span className="text-xs font-semibold uppercase tracking-wide text-text-tertiary">
          {live ? 'Running' : 'Produced'}
        </span>
      </div>
      <div className="mt-1 text-sm text-text">
        <span className="font-medium">{p.kind}</span> · <span className="font-mono text-xs">{p.by}</span>
      </div>
      <div className="mt-0.5 text-xs text-text-secondary">
        {live ? `started ${p.since}` : `finished ${p.at}`}
      </div>
    </div>
  );
}

const TOOL_CALLS = [
  { name: 'Read', target: 'src/auth/session-cookie.ts' },
  { name: 'Grep', target: '"shimCookie" · 3 files' },
  { name: 'Edit', target: 'src/auth/session-cookie.ts · +6 −1' },
  { name: 'Bash', target: 'npm test -- session → 41 passed' },
];

const DIFF = `diff --git a/src/auth/session-cookie.ts b/src/auth/session-cookie.ts
@@ -31,6 +31,7 @@ export function cookieOptions(secure: boolean) {
   return {
     httpOnly: true,
     sameSite: 'lax',
+    partitioned: secure,
     secure,
     path: '/',
   };`;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-4">
      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">{title}</div>
      {children}
    </div>
  );
}

function RunInspector({ run }: { run: QueuedRun }) {
  const [tab, setTab] = useState('run');
  const blocked = run.status === 'blocked';

  const provenance: Provenance = blocked
    ? { state: 'unavailable', missing: 'skill:deck.pptx',
        wouldBe: 'A registered deck skill would appear here with its inputs and the runtime it executes in.' }
    : run.status === 'running'
      ? { state: 'running', by: run.id, kind: `Agent run · ${run.model}`, since: '2 min ago' }
      : { state: 'produced', by: run.id, kind: `Agent run · ${run.model}`, at: '09:21' };

  const tabs = blocked
    ? [{ id: 'run', label: 'Why' }, { id: 'budget', label: 'Budget' }]
    : [{ id: 'run', label: 'Run' }, { id: 'change', label: 'Change' },
       { id: 'terminal', label: 'Terminal' }, { id: 'budget', label: 'Budget' }];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-border px-4 py-3">
        <div className="text-[11px] uppercase tracking-wide text-text-tertiary">{run.initiative}</div>
        <div className="mt-0.5 text-sm font-semibold text-text">{run.instruction}</div>
      </div>

      <div className="px-4 pt-3">
        <ProvenanceLine p={provenance} />
      </div>

      <div className="px-4 pt-3">
        <Tabs items={tabs} value={tab} onValueChange={setTab} variant="underline" size="sm" />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6">
        {tab === 'run' && !blocked && (
          <>
            <Section title="What it did">
              <ul className="space-y-1.5">
                {TOOL_CALLS.map((t) => (
                  <li key={t.target} className="flex gap-2 text-xs">
                    <span className="font-semibold text-brand">{t.name}</span>
                    <span className="truncate font-mono text-text-secondary">{t.target}</span>
                  </li>
                ))}
              </ul>
            </Section>
            <Section title="Cost">
              <div className="text-sm text-text">
                ${run.spendUsd.toFixed(4)} · 5 turns · 6.4s
              </div>
              <div className="text-xs text-text-secondary">
                forecast was ${run.forecastUsd[0].toFixed(2)}–${run.forecastUsd[1].toFixed(2)}
              </div>
            </Section>
          </>
        )}

        {tab === 'run' && blocked && (
          <Section title="What would make this work">
            <p className="text-sm text-text-secondary">
              A skill registered on the fleet that takes a document and emits a
              deck, with its own inputs, runtime and cost. Until one exists this
              panel has nothing to show, and showing a slide preview here would
              be inventing one.
            </p>
            <div className="mt-3">
              <Button size="sm" variant="secondary">Open the skill library</Button>
            </div>
          </Section>
        )}

        {tab === 'change' && (
          <>
            <Section title="Captured diff">
              <pre className="overflow-x-auto rounded-md bg-surface-inset p-3 text-[11px] leading-relaxed text-text-secondary">
                {DIFF}
              </pre>
            </Section>
            <Section title="Gate">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge tone="success">reviewer: approved</Badge>
                <Badge tone="neutral">protected paths: clean</Badge>
                <Badge tone="neutral">commit 0048a0b</Badge>
              </div>
            </Section>
            <Section title="Bound to">
              <div className="text-sm text-text">wi-auth-e2-b3 · bug · 2 pts</div>
            </Section>
          </>
        )}

        {tab === 'terminal' && (
          <>
            <Section title="Session">
              <div className="text-sm text-text">{run.computer}</div>
              <div className="text-xs text-text-secondary">
                microVM · /mnt/workspace persists · stops after 20m idle
              </div>
            </Section>
            <Section title="Attach">
              <pre className="rounded-md bg-surface-inset p-3 font-mono text-[11px] text-text-secondary">
                bedrock_agentcore:/mnt/workspace$
              </pre>
              <div className="mt-2">
                <Button size="sm" variant="secondary">Open a shell here</Button>
              </div>
            </Section>
          </>
        )}

        {tab === 'budget' && (
          <>
            <Section title="Sprint envelope">
              <div className="text-sm text-text">$14.91 left of $15.00</div>
              <div className="text-xs text-text-secondary">Sprint 42 — Session hygiene · granted by Sienna Garcia</div>
            </Section>
            <Section title="Initiative allocation">
              <div className="text-sm text-text">$45.00 allocated · $4.27 spent this period</div>
            </Section>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Chat column ─────────────────────────────────────────────────────────────

function RunCard({ run, selected, onSelect }: {
  run: QueuedRun; selected: boolean; onSelect: () => void;
}) {
  const tone = run.status === 'blocked' ? 'warning'
    : run.status === 'running' ? 'info'
      : run.status === 'review' ? 'success' : 'neutral';
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full rounded-lg border px-3 py-2.5 text-left transition-colors ${
        selected ? 'border-brand bg-brand-soft' : 'border-border bg-surface hover:border-brand/50'
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="font-mono text-[11px] text-brand">{run.command}</span>
        <Badge tone={tone as 'success'}>{run.status}</Badge>
      </div>
      <div className="mt-1 text-sm text-text">{run.instruction}</div>
      <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-text-tertiary">
        <span>{run.initiative}</span>
        <span>{run.model}</span>
        {run.computer !== '—' && <span className="font-mono">{run.computer}</span>}
        {run.spendUsd > 0 && <span>${run.spendUsd.toFixed(4)}</span>}
      </div>
    </button>
  );
}

function Composer({ onDispatch }: { onDispatch: (instruction: string) => void }) {
  const [draft, setDraft] = useState('');
  const menu = useMemo(() => {
    if (!draft.startsWith('/')) return [];
    const token = draft.split(' ')[0]!.toLowerCase();
    return COMMANDS.filter((c) => c.trigger.startsWith(token));
  }, [draft]);
  const active = draft.startsWith('/run ') && draft.length > 5;

  return (
    <div className="border-t border-border bg-surface px-3 py-2.5">
      {menu.length > 0 && (
        <div className="mb-2 overflow-hidden rounded-lg border border-border bg-surface shadow-sm">
          {menu.map((c) => (
            <button
              key={c.trigger}
              type="button"
              disabled={c.unavailable}
              onClick={() => setDraft(`${c.trigger} `)}
              className={`flex w-full items-baseline gap-2 px-3 py-2 text-left hover:bg-surface-inset ${
                c.unavailable ? 'opacity-55' : ''
              }`}
            >
              <span className="font-mono text-xs font-semibold text-brand">{c.trigger}</span>
              <span className="text-sm text-text">{c.label}</span>
              <span className="ml-auto truncate text-[11px] text-text-tertiary">{c.hint}</span>
            </button>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && active) { onDispatch(draft.slice(5)); setDraft(''); }
          }}
          placeholder="Message #auth-migration — or / for commands"
          className="min-w-0 flex-1 rounded-md border border-border bg-surface-inset px-3 py-2 text-sm text-text outline-none placeholder:text-text-tertiary focus:border-brand"
        />
        <Button size="sm" disabled={!active} onClick={() => { onDispatch(draft.slice(5)); setDraft(''); }}>
          Send
        </Button>
      </div>
      <div className="mt-1.5 text-[11px] text-text-tertiary">
        {draft.startsWith('/run')
          ? 'Sending dispatches an agent and opens the lab beside this conversation.'
          : 'Type / for commands · ⏎ to send'}
      </div>
    </div>
  );
}

// ─── The prototype ───────────────────────────────────────────────────────────

export function ComputerLabChat() {
  // The lab's terminals and tail panes talk over `mock-shell:` / `mock-tail:`
  // URLs when the library routes them to its simulator. Without this the panes
  // render and then sit on `error · Failed to fetch reattach`, which reads as
  // a broken product rather than an unplugged one. Both installs are
  // refcounted and return their uninstall.
  useEffect(() => {
    const uninstall = [installMockShellSocket(), installMockTailSource()];
    return () => uninstall.forEach((f) => f());
  }, []);

  const [messages, setMessages] = useState<Message[]>(SEED_MESSAGES);
  const [runs, setRuns] = useState<QueuedRun[]>(SEED_RUNS);
  const [labOpen, setLabOpen] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(SEED_RUNS[0]!.id);
  const [conversation, setConversation] = useState('c-auth');

  const selectedRun = runs.find((r) => r.id === selectedRunId) ?? null;

  function dispatch(instruction: string) {
    const run: QueuedRun = {
      id: `run-${4473 + runs.length}`, command: '/run', instruction,
      initiative: 'Auth Migration', model: 'Sonnet', computer: `auth-migration-${4 + runs.length}`,
      status: 'running', spendUsd: 0, forecastUsd: [0.03, 0.30],
    };
    setRuns((r) => [run, ...r]);
    setMessages((m) => [...m,
      { id: `m${m.length + 1}`, author: 'You', mine: true, at: 'now', kind: 'run', body: '', run }]);
    setSelectedRunId(run.id);
    setLabOpen(true);
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-bg text-text">
      {/* ── 1. Social rail ─────────────────────────────────────────────── */}
      <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-surface-panel">
        <div className="flex items-center gap-2 border-b border-border px-3 py-3">
          <div className="grid h-7 w-7 place-items-center rounded-md bg-brand-gradient text-xs font-bold text-white">Or</div>
          <div className="text-sm font-semibold">Org</div>
        </div>

        <div className="px-3 pt-3">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">Active now</div>
          <div className="flex flex-wrap gap-2">
            {ACTIVE_NOW.map((p) => (
              <div key={p.name} className="flex w-12 flex-col items-center gap-1">
                <div className={p.busy ? 'rounded-full ring-2 ring-brand ring-offset-2 ring-offset-surface-panel' : ''}>
                  <Avatar name={p.name} size={28} />
                </div>
                <div className="w-full truncate text-center text-[10px] text-text-tertiary">
                  {p.name.split(' ')[0]}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-4 px-3">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">Conversations</div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {CONVERSATIONS.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setConversation(c.id)}
              className={`mb-0.5 flex w-full items-start gap-2 rounded-md px-2 py-2 text-left ${
                conversation === c.id ? 'bg-brand-soft' : 'hover:bg-surface-inset'
              }`}
            >
              <Avatar name={c.name.replace('# ', '')} size={26} />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-1.5">
                  <span className="truncate text-[13px] font-medium">{c.name}</span>
                  <span className="ml-auto shrink-0 text-[10px] text-text-tertiary">{c.when}</span>
                </div>
                <div className="truncate text-[11px] text-text-tertiary">{c.preview}</div>
              </div>
            </button>
          ))}
        </div>
      </aside>

      {/* ── 2. Conversation ────────────────────────────────────────────── */}
      <section className={`flex min-w-0 flex-col border-r border-border bg-bg ${labOpen ? 'w-[400px] shrink-0' : 'flex-1'}`}>
        <header className="flex items-center gap-2 border-b border-border bg-surface px-4 py-3">
          <Avatar name="auth-migration" size={26} />
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">#&nbsp;auth-migration</div>
            <div className="text-[11px] text-text-tertiary">4 people · 2 agents working</div>
          </div>
          {!labOpen && (
            <Button size="sm" variant="secondary" className="ml-auto" onClick={() => setLabOpen(true)}>
              Open lab
            </Button>
          )}
        </header>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
          {messages.map((m) => (
            <div key={m.id} className={m.mine ? 'flex justify-end' : 'flex'}>
              <div className={`max-w-[85%] ${m.mine ? 'items-end' : ''}`}>
                {m.kind === 'text' ? (
                  <>
                    <div className="mb-0.5 flex items-baseline gap-1.5">
                      <span className="text-[11px] font-semibold text-text-secondary">{m.author}</span>
                      <span className="text-[10px] text-text-tertiary">{m.at}</span>
                    </div>
                    <div className={`rounded-lg px-3 py-2 text-sm ${
                      m.mine ? 'bg-brand-soft text-brand-ink' : 'bg-surface text-text'
                    }`}>
                      {m.body}
                    </div>
                  </>
                ) : (
                  <>
                    <div className="mb-0.5 text-[11px] text-text-tertiary">
                      {m.author} dispatched an agent · {m.at}
                    </div>
                    <RunCard
                      run={m.run!}
                      selected={selectedRunId === m.run!.id}
                      onSelect={() => { setSelectedRunId(m.run!.id); setLabOpen(true); }}
                    />
                  </>
                )}
              </div>
            </div>
          ))}
        </div>

        <Composer onDispatch={dispatch} />
      </section>

      {/* ── 3. The lab, beside the conversation ────────────────────────── */}
      {labOpen && (
        <section className="flex min-w-0 flex-1 flex-col bg-bg">
          <header className="flex items-center gap-2 border-b border-border bg-surface px-4 py-2.5">
            <span className="text-sm font-semibold">Computer Lab</span>
            <span className="text-[11px] text-text-tertiary">
              opened by <span className="font-mono">/run</span> · {runs.filter((r) => r.status === 'running').length} working
            </span>
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setLabOpen(false)}>
              Close
            </Button>
          </header>

          {/* The queue this conversation dispatched — the bridge between the
              chat on the left and the machines below. */}
          <div className="flex gap-2 overflow-x-auto border-b border-border bg-surface-panel px-3 py-2">
            {runs.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => setSelectedRunId(r.id)}
                className={`shrink-0 rounded-md border px-2.5 py-1.5 text-left ${
                  selectedRunId === r.id ? 'border-brand bg-brand-soft' : 'border-border bg-surface'
                }`}
              >
                <div className="flex items-center gap-1.5">
                  <span className={`h-1.5 w-1.5 rounded-full ${
                    r.status === 'running' ? 'bg-success'
                      : r.status === 'blocked' ? 'bg-warning' : 'bg-text-tertiary'
                  }`} />
                  <span className="font-mono text-[10px] text-text-tertiary">{r.id}</span>
                </div>
                <div className="max-w-[190px] truncate text-[11px] text-text">{r.instruction}</div>
              </button>
            ))}
          </div>

          {/* The shipped lab, on its own fixtures: real panes, real terminals,
              real keyboard layer. `enabled={false}` keeps it off the network. */}
          <div className="min-h-0 flex-1">
            <ComputeProvider client={fixtureClient} computers={fixtureComputers} models={fixtureModels} canManage>
              <ComputerLab open variant="inline" onClose={() => setLabOpen(false)} />
            </ComputeProvider>
          </div>
        </section>
      )}

      {/* ── 4. Inspector — provenance first ────────────────────────────── */}
      {labOpen && selectedRun && (
        <aside className="w-[340px] shrink-0 border-l border-border bg-surface">
          <RunInspector run={selectedRun} />
        </aside>
      )}
    </div>
  );
}
