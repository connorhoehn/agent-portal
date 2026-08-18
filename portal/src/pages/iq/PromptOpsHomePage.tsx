// Prompt Management overview — the guided entry point.
//
// Before this page, /iq/prompts dropped you straight into the Bedrock library
// browser and /iq/canary into a live A/B diagram with Halt/Manual-weight
// controls, with no answer to the first question an operator actually has:
// "what's deployed right now, and what should I do next?"
//
// Everything here is REAL state, never illustrative:
//   - library count      → GET /api/observability/canary/library (Bedrock)
//   - active experiment  → GET /api/observability/canary/weight  (SSM)
//   - subjects/judge     → GET /api/observability/canary/prompts  (Bedrock ARNs)
//   - past experiments   → GET /api/iq/prompts/experiments        (Aurora)
// If a surface has no data, it says so plainly instead of rendering an empty
// dashboard that implies something exists.

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
interface ExperimentsResponse { experiments?: Array<{ id: string; outcome?: string; endedAt?: string }> }

/** `…:prompt/ABC123:1` → { id: 'ABC123', version: '1' } (version '' = DRAFT). */
function parseArn(arn: string | undefined): { id: string; version: string } {
  const tail = (arn ?? '').split('/').pop() ?? '';
  const [id = '', version = ''] = tail.split(':');
  return { id, version };
}

/** Human label for a subject: prompt name + version, falling back to the id. */
function subjectLabel(arn: string | undefined, names: Map<string, string>): string {
  const { id, version } = parseArn(arn);
  if (!id) return '—';
  return `${names.get(id) ?? id} · ${version ? `v${version}` : 'DRAFT'}`;
}

export default function PromptOpsHomePage() {
  const navigate = useNavigate();
  const { data: library } = useFetch<LibraryResponse>('/api/observability/canary/library', 30_000);
  const { data: weight } = useFetch<WeightResponse>('/api/observability/canary/weight', 10_000);
  const { data: prompts } = useFetch<PromptsResponse>('/api/observability/canary/prompts', 30_000);
  const { data: experiments } = useFetch<ExperimentsResponse>('/api/iq/prompts/experiments', 60_000);

  const promptCount = library?.prompts?.length ?? 0;
  const recent = [...(library?.prompts ?? [])]
    .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
    .slice(0, 4);

  const promptNames = new Map((library?.prompts ?? []).map((p) => [p.id, p.name]));
  // A canary where both sides resolve to the same prompt AND version can't
  // learn anything — the judge scores two identical answers. Worth saying so.
  const aArn = prompts?.subject_a?.arn;
  const bArn = prompts?.subject_b?.arn;
  const degenerate = Boolean(aArn && bArn && aArn === bArn);

  const halted = weight?.control?.halted === true;
  const weightB = weight?.weight_b ?? 0;
  // An experiment is live when traffic is actually split (or explicitly halted
  // mid-run). weight_b === 0 with no halt means nothing is rolling out.
  const experimentLive = halted || weightB > 0;
  const pastCount = experiments?.experiments?.length ?? 0;

  return (
    <PageSection title="Prompt Management">
      <p className="text-[13px] text-text-secondary mt-1 mb-5 max-w-2xl">
        Author prompts in the Bedrock library, try them against real org data, then roll a
        change out gradually with an A/B canary that an LLM judge scores automatically.
      </p>

      {/* ── Current state ── */}
      <div className="grid gap-4 mb-6 grid-cols-1 md:grid-cols-3">
        <Card>
          <div className="text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">Prompt library</div>
          <div className="text-[26px] font-bold text-text-primary leading-tight mt-1">{promptCount}</div>
          <div className="text-[12px] text-text-secondary">
            {promptCount === 0 ? 'no prompts in Bedrock yet' : 'managed prompts in Bedrock'}
          </div>
          <Link to="/iq/prompts" className="inline-block mt-3 text-[12px] font-semibold text-primary no-underline hover:underline">
            Open Prompt Studio →
          </Link>
        </Card>

        <Card>
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
              <Link to="/iq/canary" className="inline-block mt-3 text-[12px] font-semibold text-primary no-underline hover:underline">
                Open live experiment →
              </Link>
            </>
          ) : (
            <>
              <div className="text-[15px] font-bold text-text-primary mt-1">No experiment running</div>
              <div className="text-[12px] text-text-secondary mt-0.5">100% of traffic on the baseline prompt</div>
              <button
                onClick={() => void navigate('/iq/canary')}
                className="mt-3 px-3 py-1.5 rounded-md border-none bg-primary text-white text-[12px] font-semibold cursor-pointer"
              >
                Start an experiment
              </button>
            </>
          )}
        </Card>

        <Card>
          <div className="text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">Past experiments</div>
          <div className="text-[26px] font-bold text-text-primary leading-tight mt-1">{pastCount}</div>
          <div className="text-[12px] text-text-secondary">
            {pastCount === 0
              ? 'none completed yet — finish a canary to build history'
              : 'completed rollouts with recorded outcomes'}
          </div>
          {pastCount > 0 && (
            <Link to="/iq/history" className="inline-block mt-3 text-[12px] font-semibold text-primary no-underline hover:underline">
              View history →
            </Link>
          )}
        </Card>
      </div>

      {/* ── Guided path ── */}
      <Card className="mb-6">
        <div className="text-xs font-semibold text-text-secondary tracking-wide select-none mb-3">HOW A CHANGE SHIPS</div>
        <ol className="list-none p-0 m-0 grid gap-3 grid-cols-1 md:grid-cols-3">
          {[
            {
              n: 1,
              title: 'Author',
              body: 'Edit a prompt in the studio and save it as a new version. Drafts stay unpublished until you are ready.',
              cta: 'Prompt Studio',
              to: '/iq/prompts',
            },
            {
              n: 2,
              title: 'Test',
              body: 'Run it with real people and skills from the org graph, optionally behind a guardrail, and read the output.',
              cta: 'Test a prompt',
              to: '/iq/prompts',
            },
            {
              n: 3,
              title: 'Roll out',
              body: 'Start a canary: baseline vs challenger, weighted traffic, judge scores, automatic promote or rollback.',
              cta: experimentLive ? 'Open experiment' : 'Start a canary',
              to: '/iq/canary',
            },
          ].map((step) => (
            <li key={step.n} className="border border-border rounded-lg p-3.5">
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-primary text-white text-[11px] font-bold">
                  {step.n}
                </span>
                <span className="text-[13px] font-bold text-text-primary">{step.title}</span>
              </div>
              <p className="text-[12px] leading-relaxed text-text-secondary mt-2 mb-3">{step.body}</p>
              <Link to={step.to} className="text-[12px] font-semibold text-primary no-underline hover:underline">
                {step.cta} →
              </Link>
            </li>
          ))}
        </ol>
      </Card>

      {/* ── Recently edited ── */}
      {recent.length > 0 && (
        <Card>
          <div className="text-xs font-semibold text-text-secondary tracking-wide select-none mb-2">RECENTLY UPDATED</div>
          <div className="flex flex-col">
            {recent.map((p) => (
              <Link
                key={p.id}
                to="/iq/prompts"
                className="flex items-center gap-3 py-2 border-b border-border last:border-b-0 no-underline min-w-0"
              >
                <span className="text-[12.5px] font-semibold text-text-primary truncate">{p.name}</span>
                <span className="text-[11px] text-text-tertiary truncate flex-1">{p.description ?? ''}</span>
              </Link>
            ))}
          </div>
        </Card>
      )}
    </PageSection>
  );
}
