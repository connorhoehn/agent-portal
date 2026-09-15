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
import { Badge, Button, Card, CardHeader, CatalogGrid, Chip, EmptyState, Inline, InlineAlert, PageSection, Stack, StatCard, StatusDot, Tooltip } from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { useSession } from '../../lib/auth';
import { T } from './Text';
import { parseArn, runtimeForSystemPrompt, subjectLabel, systemPromptForRuntime } from './promptOpsFormat';

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

export default function PromptOpsHomePage() {
  const navigate = useNavigate();
  const { session } = useSession();
  // Same platform-role test as the rail (iqSubNavCatalog.ts PROMPT_MGMT_PLATFORM_GROUPS).
  // This page is wired for a `ViewObservability` read, which member deliberately
  // holds as an all-hands read (member.cedar) — so its data loads fine and the
  // libraryError branch below never fires. Without this check a member who
  // reaches the URL directly (⌘K, a bookmark, or before the route guard's
  // session fetch resolves) saw the full page: eleven CTAs into Studio,
  // Test-a-prompt and Rollout, every one a platform route that bounces them
  // straight back out (DEFECTS.md #10).
  const isPlatform = session?.role === 'org-leader' || session?.role === 'hr-admin' || session?.role === 'admin';
  const { data: library, error: libraryError } = useFetch<LibraryResponse>('/api/observability/canary/library', 30_000);
  const { data: weight } = useFetch<WeightResponse>('/api/observability/canary/weight', 10_000);
  const { data: prompts } = useFetch<PromptsResponse>('/api/observability/canary/prompts', 30_000);
  const { data: experiments, error: experimentsError } = useFetch<ExperimentsResponse>('/api/iq/prompts/experiments', 60_000);
  const { data: runtimesResp } = useFetch<{ agents: AgentRuntime[] }>('/api/agents', 30_000);
  const runtimes = runtimesResp?.agents;

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

  const steps = [
    { n: 1, title: 'Author', body: 'Edit a prompt in the studio and save it as a new version. Drafts stay unpublished until you publish.', cta: 'Prompt Studio', to: '/iq/prompts' },
    { n: 2, title: 'Test', body: 'Run it against real people and skills from the org graph, optionally behind a guardrail, and read the output.', cta: 'Test a prompt', to: '/iq/prompts' },
    { n: 3, title: 'Roll out', body: 'Start a canary: baseline vs challenger, weighted traffic, judge scores, automatic promote or rollback.', cta: experimentLive ? 'Open experiment' : 'Start a canary', to: '/iq/canary' },
  ];

  // This surface's guided path — Author, Test, Roll out — and its full
  // library listing all point at platform-only routes. Explain that plainly
  // instead of rendering links that redirect the moment they're clicked.
  if (!isPlatform) {
    return (
      <PageSection title="What is deployed">
        <Stack gap="none" className="max-w-xl">
          <EmptyState
            title="This is a platform surface"
            description={
              <>
                Authoring, testing and rolling out prompts — Studio, Versions, Evals and
                Rollout — is limited to the org-leader and HR Admin roles.{' '}
                <Link to="/iq/library" className="font-semibold text-primary no-underline hover:underline">
                  Browse the library
                </Link>{' '}
                instead, or switch role from the identity menu, top right.
              </>
            }
          />
        </Stack>
      </PageSection>
    );
  }

  // The whole surface is driven by the prompt library, which is ViewObservability-
  // gated. If it's denied, say so plainly rather than rendering an empty library
  // that reads as "nothing is deployed".
  if (libraryError) {
    return (
      <PageSection title="What is deployed">
        <UnavailableNotice
          error={libraryError}
          what="the prompt library"
          source="Prompt management is limited to the org-leader and HR Admin roles"
        />
      </PageSection>
    );
  }

  return (
    <PageSection title="What is deployed">
      <T className="mt-1 mb-5 max-w-3xl text-[13px] leading-relaxed text-text-secondary" wrap>
        Every prompt here is wired to something running. <b>Agent system prompts</b> are resolved
        from this library by each deployed agent on every invocation (60&nbsp;s cache) — edit one and
        the live fleet picks it up within a minute, no rebuild. <b>Canary prompts</b> are invoked by
        ARN by the A/B rollout surface. If the library is ever unreachable, agents fall back to the
        prompt baked into their image, so a Bedrock outage cannot take the fleet down.
      </T>

      {/* ── What is deployed ── */}
      <CatalogGrid columns={2} className="mb-5">
        <Card padding="md">
          <Stack gap="sm">
            <CardHeader title="Deployed agents" meta={<Chip tone="success" size="xs">prompt resolved from library</Chip>} />
            <StatCard label="Deployed" value={deployedRuntimes.length} hint={`runtimes · ${healthy} healthy`} />
            <Inline gap="xs" wrap>
              {deployedRuntimes.map((r) => {
                const shortName = r.name.replace(/^orgiq_/, '');
                const promptName = systemPromptForRuntime(r.name);
                const hasEntry = libraryNames.has(promptName);
                const detail = hasEntry
                  ? `${r.name} · ${r.status} · resolves ${promptName} from the library`
                  : `${r.name} · ${r.status} · no library entry — running its baked prompt`;
                return (
                  <Tooltip key={r.id} content={detail}>
                    <Chip tone={r.status === 'healthy' ? 'success' : 'neutral'} dot="static" size="xs">
                      {shortName}{hasEntry ? '' : ' •'}
                    </Chip>
                  </Tooltip>
                );
              })}
              {deployedRuntimes.length === 0 && (
                <T className="text-[12px] text-text-tertiary">no runtimes deployed</T>
              )}
            </Inline>
            <T className="text-[11px] leading-snug text-text-tertiary" wrap>
              Each runtime reads <code>orgiq-&lt;agent&gt;-system-prompt</code> from the library on every
              invocation and rebuilds itself when the text changes. Tool wiring and model choice still
              require a code change and redeploy.
            </T>
          </Stack>
        </Card>

        <Card padding="md">
          <Stack gap="sm">
            <CardHeader title="Canary prompts" meta={<Chip tone="success" size="xs">edits apply immediately</Chip>} />
            <StatCard label="Live" value={livePrompts.length} hint="invoked by ARN by the rollout surface" />
            <Stack gap="xs">
              {livePrompts.map((p) => (
                <Inline key={p.id} gap="sm" align="center">
                  <StatusDot color="var(--color-success)" size="xs" />
                  <T className="min-w-0 truncate text-[12px] font-semibold text-text-primary">{p.name}</T>
                  <T className="min-w-0 truncate text-[11px] text-text-tertiary">{p.description ?? ''}</T>
                </Inline>
              ))}
              {livePrompts.length === 0 && (
                <T className="text-[12px] text-text-tertiary">none — start a canary to wire prompts live</T>
              )}
            </Stack>
            <T className="text-[11px] leading-snug text-text-tertiary" wrap>
              The canary subjects and judge. Used by the A/B rollout surface, not by the agent fleet.
            </T>
          </Stack>
        </Card>
      </CatalogGrid>

      {/* ── Rollout + history ── */}
      <CatalogGrid columns={2} className="mb-5">
        <Card padding="md">
          <Stack gap="sm">
            <CardHeader title="Rollout" />
            {experimentLive ? (
              <Stack gap="sm">
                <Inline gap="sm" align="center">
                  <StatusDot color={halted ? 'var(--color-danger)' : 'var(--color-success)'} size="sm" />
                  <T className="text-[15px] font-bold text-text-primary">
                    {halted ? 'Halted' : `${100 - weightB}% A / ${weightB}% B`}
                  </T>
                </Inline>
                <Stack gap="none">
                  <T className="truncate text-[12px] text-text-secondary" title={aArn}>A · {subjectLabel(aArn, promptNames)}</T>
                  <T className="truncate text-[12px] text-text-secondary" title={bArn}>B · {subjectLabel(bArn, promptNames)}</T>
                </Stack>
                {degenerate && (
                  <InlineAlert tone="warning">
                    Both sides point at the same prompt version — the judge is scoring identical
                    answers, so no promote/rollback signal can emerge. Publish a challenger version
                    and restart the experiment.
                  </InlineAlert>
                )}
                <Link to="/iq/canary" className="text-[12px] font-semibold text-primary no-underline hover:underline">
                  Open live experiment →
                </Link>
              </Stack>
            ) : (
              <Stack gap="sm">
                <T className="text-[15px] font-bold text-text-primary">No experiment running</T>
                <T className="text-[12px] text-text-secondary">100% of canary traffic on the baseline prompt</T>
                <Button variant="primary" size="sm" onClick={() => void navigate('/iq/canary')} className="self-start">
                  Start an experiment
                </Button>
              </Stack>
            )}
          </Stack>
        </Card>

        <Card padding="md">
          <Stack gap="sm">
            <CardHeader title="Past experiments" />
            <StatCard
              label="Past"
              value={experimentsError ? '—' : pastCount}
              hint={experimentsError ? 'unknown' : pastCount === 0 ? 'none completed yet' : 'completed rollouts'}
            />
            {/* Experiment history lives in Aurora. A failed load used to render
                a confident 0 and tell you to go run a canary, when the truth
                was that we could not see the ones already there. */}
            <T className="text-[12px] leading-snug text-text-tertiary" wrap>
              {experimentsError
                ? 'Experiment history is unreachable, so this is unknown rather than none.'
                : pastCount === 0
                  ? 'Finish a canary — promote or roll back — and its outcome is recorded here.'
                  : 'Recorded outcomes with judge scores and controller decisions.'}
            </T>
            {pastCount > 0 && (
              <Link to="/iq/history" className="text-[12px] font-semibold text-primary no-underline hover:underline">
                View history →
              </Link>
            )}
          </Stack>
        </Card>
      </CatalogGrid>

      {/* ── Guided path ── */}
      <Card padding="md" className="mb-5">
        <Stack gap="md">
          <CardHeader title="How a change ships" />
          <CatalogGrid columns={3}>
            {steps.map((step) => (
              <Card key={step.n} padding="md">
                <Stack gap="xs">
                  <Inline gap="sm" align="center">
                    <Badge variant="count" value={step.n} color="accent" />
                    <T className="text-[13px] font-bold text-text-primary">{step.title}</T>
                  </Inline>
                  <T className="text-[12px] leading-relaxed text-text-secondary" wrap>{step.body}</T>
                  <Link to={step.to} className="text-[12px] font-semibold text-primary no-underline hover:underline">
                    {step.cta} →
                  </Link>
                </Stack>
              </Card>
            ))}
          </CatalogGrid>
        </Stack>
      </Card>

      {/* ── Full library, classified ── */}
      <Card padding="none" className="overflow-hidden">
        <CardHeader
          className="px-3.5 pt-3 pb-2.5 border-b border-border"
          title="Prompt library"
          subtitle={`${allPrompts.length} in Bedrock`}
          action={<Link to="/iq/prompts" className="text-[12px] font-semibold text-primary no-underline hover:underline">Open Prompt Studio →</Link>}
        />
        <Stack gap="none">
          {[
            { rows: livePrompts, badge: 'live · canary', tone: 'success' as const, note: 'invoked by ARN' },
            { rows: agentCopies, badge: 'live · agent', tone: 'success' as const, note: 'resolved at run time' },
            { rows: otherPrompts, badge: 'unused', tone: 'neutral' as const, note: 'not wired to anything' },
          ].flatMap(({ rows, badge, tone, note }) =>
            rows.map((p) => (
              <Link
                key={p.id}
                to="/iq/prompts"
                className="flex min-w-0 items-center gap-3 border-b border-border px-3.5 py-2 no-underline last:border-b-0 hover:bg-surface-hover"
              >
                <Chip tone={tone} size="xs">{badge}</Chip>
                <T className="min-w-0 truncate text-[12.5px] font-semibold text-text-primary">{p.name}</T>
                <T className="min-w-0 flex-1 truncate text-[11px] text-text-tertiary">{p.description ?? ''}</T>
                <T className="hidden shrink-0 text-[10px] text-text-tertiary md:inline">{note}</T>
              </Link>
            )),
          )}
          {allPrompts.length === 0 && (
            <EmptyState title="No prompts in the Bedrock library yet." />
          )}
        </Stack>
      </Card>
    </PageSection>
  );
}
