// Prompt Management overview — the guided entry point, and the honest answer
// to "what is actually deployed and running?"
//
// That answer has two halves, and conflating them is the single most
// misleading thing this surface could do:
//
//   1. CANARY prompts — the A/B subjects + judge. The middleware invokes
//      these BY ARN at request time (ConverseStream), so an edit here changes
//      behavior on the very next request.
//   2. AGENT SYSTEM PROMPTS — the `*-system-prompt` entries. Each deployed
//      agent resolves its own entry from the library on every invocation
//      (60s cache, agents/_shared/prompt_source.py), so an edit reaches the
//      running fleet within a minute with no rebuild and no redeploy. The
//      literal in agents/*/main.py is now only a fallback for when the
//      library is unreachable.
//
// Everything rendered here is real state — library from Bedrock, rollout from
// SSM, runtimes from the AgentCore control plane, experiments from Aurora.

import { Link, useNavigate } from 'react-router';
import { PageSection, Card } from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';

interface LibraryPrompt { id: string; name: string; updatedAt?: string; description?: string }
interface LibraryResponse { prompts?: LibraryPrompt[] }
interface WeightResponse { weight_b: number; control?: { halted?: boolean } }
interface PromptsResponse {
  subject_a?: { arn: string; label: string };
  subject_b?: { arn: string; label: string };
  judge?: { arn: string };
}
interface ExperimentsResponse { experiments?: Array<{ id: string }> }
interface AgentRuntime { id: string; name: string; status: string; invocationsLast24h?: number }

/** `…:prompt/ABC123:1` → { id: 'ABC123', version: '1' } (version '' = DRAFT). */
function parseArn(arn: string | undefined): { id: string; version: string } {
  const tail = (arn ?? '').split('/').pop() ?? '';
  const [id = '', version = ''] = tail.split(':');
  return { id, version };
}

function subjectLabel(arn: string | undefined, names: Map<string, string>): string {
  const { id, version } = parseArn(arn);
  if (!id) return '—';
  return `${names.get(id) ?? id} · ${version ? `v${version}` : 'DRAFT'}`;
}

/** `orgiq-search-system-prompt` → `orgiq_search` (the runtime that owns it). */
function runtimeForSystemPrompt(name: string): string | null {
  const m = /^orgiq-(.+)-system-prompt$/.exec(name);
  return m?.[1] ? `orgiq_${m[1].replace(/-/g, '_')}` : null;
}

export default function PromptOpsHomePage() {
  const navigate = useNavigate();
  const { data: library } = useFetch<LibraryResponse>('/api/observability/canary/library', 30_000);
  const { data: weight } = useFetch<WeightResponse>('/api/observability/canary/weight', 10_000);
  const { data: prompts } = useFetch<PromptsResponse>('/api/observability/canary/prompts', 30_000);
  const { data: experiments, error: experimentsError } = useFetch<ExperimentsResponse>('/api/iq/prompts/experiments', 60_000);
  const { data: runtimes } = useFetch<AgentRuntime[]>('/api/agents', 30_000);

  const allPrompts = library?.prompts ?? [];
  const promptNames = new Map(allPrompts.map((p) => [p.id, p.name]));

  const liveArns = new Set(
    [prompts?.subject_a?.arn, prompts?.subject_b?.arn, prompts?.judge?.arn]
      .map((a) => parseArn(a).id)
      .filter(Boolean),
  );
  const livePrompts = allPrompts.filter((p) => liveArns.has(p.id));
  const agentCopies = allPrompts.filter((p) => runtimeForSystemPrompt(p.name));
  const otherPrompts = allPrompts.filter(
    (p) => !liveArns.has(p.id) && !runtimeForSystemPrompt(p.name),
  );

  // Prompt-driven agents only. orgiq_devbox runs Claude Code in a microVM and
  // has no managed system prompt, so counting it here would overstate what this
  // library controls.
  const deployedRuntimes = (runtimes ?? []).filter(
    (r) => r.name.startsWith('orgiq') && r.name !== 'orgiq_devbox',
  );
  const libraryNames = new Set(allPrompts.map((p) => p.name));
  const healthy = deployedRuntimes.filter((r) => r.status === 'healthy').length;

  const aArn = prompts?.subject_a?.arn;
  const bArn = prompts?.subject_b?.arn;
  const degenerate = Boolean(aArn && bArn && aArn === bArn);
  const halted = weight?.control?.halted === true;
  const weightB = weight?.weight_b ?? 0;
  const experimentLive = halted || weightB > 0;
  const pastCount = experiments?.experiments?.length ?? 0;

  return (
    <PageSection title="Prompt Management">
      <p className="text-[13px] text-text-secondary mt-1 mb-5 max-w-3xl leading-relaxed">
        Every prompt here is wired to something running. <b>Agent system prompts</b> are resolved
        from this library by each deployed agent on every invocation (60&nbsp;s cache) — edit one and
        the live fleet picks it up within a minute, no rebuild. <b>Canary prompts</b> are invoked by
        ARN by the A/B rollout surface. If the library is ever unreachable, agents fall back to the
        prompt baked into their image, so a Bedrock outage cannot take the fleet down.
      </p>

      {/* ── What is deployed ── */}
      <div className="grid gap-4 mb-5 grid-cols-1 lg:grid-cols-2">
        <Card padding="md" className="flex flex-col">
          <div className="flex items-baseline gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">Deployed agents</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-success-bg text-success font-semibold">prompt resolved from library</span>
          </div>
          <div className="flex items-baseline gap-2 mt-1">
            <span className="text-[24px] font-bold text-text-primary leading-none">{deployedRuntimes.length}</span>
            <span className="text-[12px] text-text-secondary">
              runtimes · {healthy} healthy
            </span>
          </div>
          <div className="flex flex-wrap gap-1.5 mt-3">
            {deployedRuntimes.map((r) => (
              <span
                key={r.id}
                title={
                  libraryNames.has(`orgiq-${r.name.replace(/^orgiq_/, '').replace(/_/g, '-')}-system-prompt`)
                    ? `${r.name} · ${r.status} · resolves orgiq-${r.name.replace(/^orgiq_/, '').replace(/_/g, '-')}-system-prompt from the library`
                    : `${r.name} · ${r.status} · no library entry — running its baked prompt`
                }
                className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-border text-[11px] text-text-secondary"
              >
                <span aria-hidden="true" className={`w-1.5 h-1.5 rounded-full ${r.status === 'healthy' ? 'bg-success' : 'bg-text-tertiary'}`} />
                {r.name.replace(/^orgiq_/, '')}
                {!libraryNames.has(`orgiq-${r.name.replace(/^orgiq_/, '').replace(/_/g, '-')}-system-prompt`) && (
                  <span className="text-warning" title="no library entry — using baked prompt">•</span>
                )}
              </span>
            ))}
            {deployedRuntimes.length === 0 && (
              <span className="text-[12px] text-text-tertiary">no runtimes deployed</span>
            )}
          </div>
          <div className="mt-auto pt-3 text-[11px] text-text-tertiary leading-snug">
            Each runtime reads <code>orgiq-&lt;agent&gt;-system-prompt</code> from the library on every
            invocation and rebuilds itself when the text changes. Tool wiring and model choice still
            require a code change and redeploy.
          </div>
        </Card>

        <Card padding="md" className="flex flex-col">
          <div className="flex items-baseline gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">Canary prompts</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-success-bg text-success font-semibold">edits apply immediately</span>
          </div>
          <div className="flex items-baseline gap-2 mt-1">
            <span className="text-[24px] font-bold text-text-primary leading-none">{livePrompts.length}</span>
            <span className="text-[12px] text-text-secondary">invoked by ARN by the rollout surface</span>
          </div>
          <div className="flex flex-col gap-1 mt-3">
            {livePrompts.map((p) => (
              <div key={p.id} className="flex items-center gap-2 min-w-0">
                <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full bg-success shrink-0" />
                <span className="text-[12px] font-semibold text-text-primary truncate">{p.name}</span>
                <span className="text-[11px] text-text-tertiary truncate">{p.description ?? ''}</span>
              </div>
            ))}
            {livePrompts.length === 0 && (
              <span className="text-[12px] text-text-tertiary">none — start a canary to wire prompts live</span>
            )}
          </div>
          <div className="mt-auto pt-3 text-[11px] text-text-tertiary leading-snug">
            The canary subjects and judge. Used by the A/B rollout surface, not by the agent fleet.
          </div>
        </Card>
      </div>

      {/* ── Rollout + history ── */}
      <div className="grid gap-4 mb-5 grid-cols-1 md:grid-cols-2">
        <Card padding="md" className="flex flex-col">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">Rollout</div>
          {experimentLive ? (
            <>
              <div className="flex items-center gap-2 mt-1">
                <span aria-hidden="true" className={`w-2 h-2 rounded-full ${halted ? 'bg-danger' : 'bg-success'}`} />
                <span className="text-[15px] font-bold text-text-primary">
                  {halted ? 'Halted' : `${100 - weightB}% A / ${weightB}% B`}
                </span>
              </div>
              <div className="text-[12px] text-text-secondary mt-1 leading-snug">
                <div className="truncate" title={aArn}>A · {subjectLabel(aArn, promptNames)}</div>
                <div className="truncate" title={bArn}>B · {subjectLabel(bArn, promptNames)}</div>
              </div>
              {degenerate && (
                <div className="mt-2 px-2 py-1.5 rounded-md bg-warning-bg text-warning text-[11px] leading-snug">
                  Both sides point at the same prompt version — the judge is scoring identical
                  answers, so no promote/rollback signal can emerge. Publish a challenger version
                  and restart the experiment.
                </div>
              )}
              <Link to="/iq/canary" className="mt-auto pt-3 text-[12px] font-semibold text-primary no-underline hover:underline">
                Open live experiment →
              </Link>
            </>
          ) : (
            <>
              <div className="text-[15px] font-bold text-text-primary mt-1">No experiment running</div>
              <div className="text-[12px] text-text-secondary mt-0.5">100% of canary traffic on the baseline prompt</div>
              <button
                onClick={() => void navigate('/iq/canary')}
                className="mt-auto self-start mt-3 px-3 py-1.5 rounded-md border-none bg-primary text-white text-[12px] font-semibold cursor-pointer"
              >
                Start an experiment
              </button>
            </>
          )}
        </Card>

        <Card padding="md" className="flex flex-col">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">Past experiments</div>
          <div className="flex items-baseline gap-2 mt-1">
            <span className="text-[24px] font-bold text-text-primary leading-none">
              {experimentsError ? '—' : pastCount}
            </span>
            <span className="text-[12px] text-text-secondary">
              {experimentsError ? 'unknown' : pastCount === 0 ? 'none completed yet' : 'completed rollouts'}
            </span>
          </div>
          <div className="text-[12px] text-text-tertiary mt-1 leading-snug">
            {/* Experiment history lives in Aurora. A failed load used to render
                a confident 0 and tell you to go run a canary, when the truth
                was that we could not see the ones already there. */}
            {experimentsError
              ? 'Experiment history is unreachable, so this is unknown rather than none.'
              : pastCount === 0
                ? 'Finish a canary — promote or roll back — and its outcome is recorded here.'
                : 'Recorded outcomes with judge scores and controller decisions.'}
          </div>
          {pastCount > 0 && (
            <Link to="/iq/history" className="mt-auto pt-3 text-[12px] font-semibold text-primary no-underline hover:underline">
              View history →
            </Link>
          )}
        </Card>
      </div>

      {/* ── Guided path ── */}
      <Card padding="md" className="mb-5">
        <div className="text-xs font-semibold text-text-secondary tracking-wide select-none mb-3">HOW A CHANGE SHIPS</div>
        <ol className="list-none p-0 m-0 grid gap-3 grid-cols-1 md:grid-cols-3">
          {[
            { n: 1, title: 'Author', body: 'Edit a prompt in the studio and save it as a new version. Drafts stay unpublished until you publish.', cta: 'Prompt Studio', to: '/iq/prompts' },
            { n: 2, title: 'Test', body: 'Run it against real people and skills from the org graph, optionally behind a guardrail, and read the output.', cta: 'Test a prompt', to: '/iq/prompts' },
            { n: 3, title: 'Roll out', body: 'Start a canary: baseline vs challenger, weighted traffic, judge scores, automatic promote or rollback.', cta: experimentLive ? 'Open experiment' : 'Start a canary', to: '/iq/canary' },
          ].map((step) => (
            <li key={step.n} className="border border-border rounded-lg p-3.5 flex flex-col">
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-primary text-white text-[11px] font-bold">{step.n}</span>
                <span className="text-[13px] font-bold text-text-primary">{step.title}</span>
              </div>
              <p className="text-[12px] leading-relaxed text-text-secondary mt-2 mb-3">{step.body}</p>
              <Link to={step.to} className="mt-auto text-[12px] font-semibold text-primary no-underline hover:underline">
                {step.cta} →
              </Link>
            </li>
          ))}
        </ol>
      </Card>

      {/* ── Full library, classified ── */}
      <Card className="overflow-hidden">
        <div className="px-3.5 py-3 border-b border-border flex items-center gap-2">
          <span className="text-xs font-semibold text-text-secondary tracking-wide select-none">PROMPT LIBRARY</span>
          <span className="text-[11px] text-text-tertiary">{allPrompts.length} in Bedrock</span>
          <div className="flex-1" />
          <Link to="/iq/prompts" className="text-[12px] font-semibold text-primary no-underline hover:underline">Open Prompt Studio →</Link>
        </div>
        <div className="flex flex-col">
          {[
            { rows: livePrompts, badge: 'live · canary', tone: 'bg-success-bg text-success', note: 'invoked by ARN' },
            { rows: agentCopies, badge: 'live · agent', tone: 'bg-success-bg text-success', note: 'resolved at run time' },
            { rows: otherPrompts, badge: 'unused', tone: 'bg-surface-hover text-text-tertiary', note: 'not wired to anything' },
          ].flatMap(({ rows, badge, tone, note }) =>
            rows.map((p) => (
              <Link
                key={p.id}
                to="/iq/prompts"
                className="flex items-center gap-3 px-3.5 py-2 border-b border-border last:border-b-0 no-underline min-w-0 hover:bg-surface-hover"
              >
                <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded shrink-0 ${tone}`}>{badge}</span>
                <span className="text-[12.5px] font-semibold text-text-primary truncate">{p.name}</span>
                <span className="text-[11px] text-text-tertiary truncate flex-1">{p.description ?? ''}</span>
                <span className="text-[10px] text-text-tertiary shrink-0 hidden md:inline">{note}</span>
              </Link>
            )),
          )}
          {allPrompts.length === 0 && (
            <div className="px-3.5 py-6 text-center text-[12px] text-text-tertiary">No prompts in the Bedrock library yet.</div>
          )}
        </div>
      </Card>
    </PageSection>
  );
}
