// One decision, in full: the question, where it stands, the call and its
// rationale, and — in the context rail — the initiative and work item it
// belongs to, the people (the decider first), the discussion and the history.
// Reads three existing endpoints. Its one write (G54) decides a waiting
// decision through POST /api/graph/decisions/:id/decide; since G57 that is the
// decision dialogue in the page's agent box (decisionDialogue.ts), not a card
// here: the page hands the docked composer its numbered options through
// `onPrompt`, while the decision is open or escalated, with
// can('DecideDecision'), and when the server says this viewer may decide it;
// the route checks all of it again. A viewer who cannot decide sees who it
// waits on (the Waiting section); one who holds a higher grant they are not
// acting as (G58) is also offered the role switch.

import { useEffect, useMemo } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';
import {
  Avatar, Button, Card, Chip, DetailSection, Inline, KeyValue, LoadingState, MetaLine, PageSection,
  RailLayout, RailSection, SectionLabel, Stack, T,
} from '@connorhoehn/ui-components/shared';
import type { ComposerPrompt } from '@connorhoehn/ui-components/social/rich-composer';
import { RecordNotFound, UnavailableNotice, isNotFoundError } from '../../components/UnavailableNotice';
import { useFetch } from '../../hooks/useFetch';
import { useSession } from '../../lib/auth';
import { useCapabilities } from '../../lib/capabilities';
import { useCrumbLabel } from '../../lib/crumbLabels';
import { absoluteTime, relativeTime } from '../../lib/relativeTime';
import { roleSwitchOffer } from '../../lib/roleSwitchOffer';
import { toastError } from '../../lib/toastStore';
import { usePublishPageContext } from '../../lib/voice/pageContext';
import { writeJson } from '../../lib/writeJson';
import {
  DECISIONS_SOURCE, STATUS_TONE, asInstant, contributors, decidedLine, decidedWhen, decider, decisionPageContext,
  historyOf, isWaiting, outcomeLine, showDecideControl, standingLine, statusLabel, waitingNotice,
} from './decisionFormat';
import { decisionDialogue } from './decisionDialogue';
import { RecordLink } from './RecordLink';
import type { DecideBody, DecisionDetail, DecisionInitiativeRow, InitiativeName } from './types';

export default function DecisionRecordPage({ onDecided, onPrompt }: {
  onDecided?: () => void;
  /** G57: the decision dialogue for the page's composer (CollectionCommandHost `prompts`); null when there is none. */
  onPrompt?: (prompt: ComposerPrompt | null) => void;
} = {}) {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { can, ready } = useCapabilities();
  const { session, setRole } = useSession();
  const { data: decision, isLoading, error, refresh } =
    useFetch<DecisionDetail>(id ? `/api/graph/decisions/${encodeURIComponent(id)}` : null, 20_000);
  const pid = decision?.projectId ? encodeURIComponent(decision.projectId) : null;
  // The escalation columns and the held-up work item live on the initiative's own read of the table.
  const { data: siblings } = useFetch<DecisionInitiativeRow[]>(pid ? `/api/graph/projects/${pid}/decisions` : null, 30_000);
  const { data: initiative } = useFetch<InitiativeName>(pid ? `/api/graph/projects/${pid}` : null, 60_000);
  useCrumbLabel(id, decision?.topic);
  const mayDecide = !!decision && ready && showDecideControl(decision, can);
  usePublishPageContext(decision ? decisionPageContext(ready ? decision : { id: decision.id, topic: decision.topic, status: decision.status }, pathname, mayDecide) : null);

  // G57: the dialogue the composer draws while this decision waits on the viewer.
  const optionsKey = JSON.stringify(decision?.options ?? []);
  const prompt = useMemo(() => (decision ? decisionDialogue(decision, mayDecide, async (body: DecideBody) => {
    const res = await writeJson<DecisionDetail>(`/api/graph/decisions/${encodeURIComponent(decision.id)}/decide`, 'POST', body);
    if (!res.ok) return res.error ?? 'unknown error';
    refresh(); onDecided?.();
    return null;
  }) : null),
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the prompt is the decision's id, topic, status and options
  [decision?.id, decision?.topic, decision?.status, optionsKey, mayDecide]);
  useEffect(() => { onPrompt?.(prompt); }, [prompt, onPrompt]);
  useEffect(() => () => onPrompt?.(null), [onPrompt]);

  if (error && isNotFoundError(error)) {
    return <RecordNotFound heading="Decision" size="md" title="Decision not found" body="No decision has this id." backLabel="All decisions" onBack={() => navigate('/iq/decisions')} />;
  }
  if (error) return <UnavailableNotice error={error} what="this decision" source={DECISIONS_SOURCE} onRetry={refresh} />;
  if (isLoading || !decision) return <LoadingState label="Loading decision…" />;

  const row = siblings?.find((s) => s.id === decision.id) ?? null;
  const who = decider(decision.participants);
  const others = contributors(decision.participants);
  const settled = decision.status === 'resolved' || decision.status === 'rejected';
  const projectName = initiative?.name ?? null;
  const waiting = ready && !mayDecide ? waitingNotice(decision) : null;
  // Waiting, the line names the decider; settled, it says when — who made the call is the Decided row's.
  const standing = standingLine({ ...decision, escalatedAt: row?.escalatedAt ?? null, requiredRole: row?.requiredRole ?? null },
    who?.name ?? null, relativeTime);
  const outcome = outcomeLine(decision);
  const decided = decidedLine(decision, relativeTime);
  const history = historyOf(decision, row, projectName);
  const projectHref = decision.projectId ? `/iq/projects/${encodeURIComponent(decision.projectId)}` : null;
  // G58: waiting on someone else, but the viewer holds org-leader or admin here without acting as it.
  const switchTo = isWaiting(decision.status) && decision.viewerMayDecide === false ? roleSwitchOffer(session, 'decide') : null;

  const rail = (
    <>
      <RailSection title="Initiative">
        {projectHref && projectName
          ? <RecordLink to={projectHref}>{projectName}</RecordLink>
          : <T tone="tertiary">Organisation-wide — no single initiative owns it</T>}
        {row?.workItemId && row.workItemTitle && projectHref && (
          <Stack gap="none">
            <SectionLabel as="div">Holding up</SectionLabel>
            <RecordLink to={`${projectHref}?item=${encodeURIComponent(row.workItemId)}`}>{row.workItemTitle}</RecordLink>
          </Stack>
        )}
      </RailSection>

      <RailSection title="People">
        {who && (
          <Inline align="center" gap="xs">
            <Avatar name={who.name} src={who.avatarUrl ?? undefined} size={24} />
            <T>{who.name}</T>
            <Chip tone="accent" size="xs">decider</Chip>
          </Inline>
        )}
        {others.map((p) => (
          <Inline key={p.personId} align="start" gap="sm" wrap={false}>
            <Avatar name={p.name} src={p.avatarUrl ?? undefined} size={24} />
            <Stack gap="none" className="min-w-0"><T wrap>{p.name}</T>
            {p.title && <T size="xs" tone="secondary" wrap>{p.title}</T>}</Stack>
          </Inline>
        ))}
        {decision.participants.length === 0 && <T tone="tertiary">Nobody is recorded on this decision yet.</T>}
      </RailSection>

      {projectHref && (
        <RailSection title="Discussion">
          <RecordLink to={`${projectHref}?tab=decisions&decision=${encodeURIComponent(decision.id)}`}>Talk it through on the initiative</RecordLink>
          <T tone="tertiary" wrap>The initiative’s discussion pane keeps the thread this decision came out of.</T>
        </RailSection>
      )}

      <RailSection title="History">
        <Stack gap="xs" data-testid="decision-history">
          {history.map((event) => (
            <Stack key={event.id} gap="none">
              <Inline align="center" gap="xs"><T weight="semibold">{event.label}</T>
                {event.at && <T tone="tertiary" title={absoluteTime(asInstant(event.at))}>{decidedWhen(event.at, relativeTime)}</T>}</Inline>
              <T tone="secondary" wrap>{event.detail}</T>
            </Stack>
          ))}
        </Stack>
      </RailSection>
    </>
  );

  return (
    <PageSection size="sm" title={decision.topic}
      // Under 40rem the frame's own back control ("All decisions", StackedCatalogLayout narrow) says this once.
      actions={<RecordLink to="/iq/decisions" className="@max-[40rem]:hidden">← All decisions</RecordLink>}
      data-testid="decision-record">
      <Stack gap="md">
        <Inline align="center" gap="sm">
          <Chip tone={STATUS_TONE[decision.status] ?? 'neutral'} size="sm" dot="static">{statusLabel(decision.status)}</Chip>
          <MetaLine size="sm" items={[standing]} />
          {switchTo && (
            <Button size="sm" variant="secondary" onClick={() => { void setRole(switchTo.role).catch((err: unknown) => toastError(null, 'Could not switch role', err instanceof Error ? err.message : 'Try again.')); }}
              data-testid="decision-switch-role">{switchTo.label}</Button>
          )}
        </Inline>
        <RailLayout rail={rail}>
          <Stack gap="md">
            <Card padding="md">
              <KeyValue labelWidth="w-28" items={[
                { label: 'Decider', value: who ? `${who.name}${who.title ? `, ${who.title}` : ''}` : 'Not assigned', muted: !who },
                { label: 'Needs', value: row?.requiredRole ?? 'Any steward', muted: !row?.requiredRole },
                // The one line that says who made the call (walk, 9 November: "by" once per screen).
                ...(settled && decided ? [{ label: decision.status === 'rejected' ? 'Rejected' : 'Decided', value: decided }] : []),
              ]} />
            </Card>
            {outcome && (
              <DetailSection first variant="heading" title="The decision">
                <T size="sm" weight="semibold" wrap as="p" data-testid="decision-outcome">{outcome}</T>
              </DetailSection>
            )}
            <DetailSection first={!outcome} variant="heading" title={outcome ? 'Background' : settled ? 'The decision and its rationale' : 'The question'}>
              <T size="sm" tone="secondary" wrap as="p">
                {decision.summary ?? (settled ? 'No rationale was recorded with this decision.' : 'The question has not been written up yet.')}
              </T>
            </DetailSection>
            {waiting && (
              <DetailSection variant="heading" title="Waiting" data-testid="decision-waiting">
                <Stack gap="xs">
                  <T size="sm" tone="secondary" wrap as="p">{waiting.line}</T>
                  {waiting.name && waiting.personId && <RecordLink to={`/iq/people/${encodeURIComponent(waiting.personId)}`}>{waiting.name}</RecordLink>}
                </Stack>
              </DetailSection>
            )}
          </Stack>
        </RailLayout>
      </Stack>
    </PageSection>
  );
}
