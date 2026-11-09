// One decision, in full: the question, where it stands, the call and its
// rationale, and — in the context rail — the initiative and work item it
// belongs to, the people (the decider first), the discussion and the history.
// Reads three existing endpoints. Its one write (G54) is the Decide card: a
// waiting decision is resolved or rejected with what was decided and why,
// through POST /api/graph/decisions/:id/decide. The card shows only with
// can('DecideDecision'), while the decision is open or escalated, and when the
// server says this viewer may decide it; the route checks all of it again.

import { useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';
import {
  Avatar, Card, Chip, ConfirmButton, DetailSection, FormField, Inline, KeyValue, LoadingState, MetaLine, PageSection,
  RailLayout, RailSection, SectionLabel, Stack, T, Textarea,
} from '@connorhoehn/ui-components/shared';
import { RecordNotFound, UnavailableNotice, isNotFoundError } from '../../components/UnavailableNotice';
import { useFetch } from '../../hooks/useFetch';
import { useCapabilities } from '../../lib/capabilities';
import { useCrumbLabel } from '../../lib/crumbLabels';
import { absoluteTime, relativeTime } from '../../lib/relativeTime';
import { toastError, toastPending, toastSuccess } from '../../lib/toastStore';
import { usePublishPageContext } from '../../lib/voice/pageContext';
import { writeJson } from '../../lib/writeJson';
import {
  DECISIONS_SOURCE, RATIONALE_MAX, STATUS_TONE, asInstant, contributors, decideBody, decider, decisionPageContext,
  historyOf, outcomeLine, showDecideControl, standingLine, statusLabel,
} from './decisionFormat';
import { RecordLink } from './RecordLink';
import type { DecideBody, DecisionDetail, DecisionInitiativeRow, InitiativeName } from './types';

/** The Decide card: the outcome and why, then Resolve or Reject, each confirmed in place. */
function DecideCard({ decision, onDecided }: { decision: DecisionDetail; onDecided: () => void }) {
  const [rationale, setRationale] = useState('');
  const [busy, setBusy] = useState(false);
  const draft = decideBody('resolved', rationale);
  const length = rationale.trim().length;
  const tooLong = length > RATIONALE_MAX;

  async function decide(outcome: DecideBody['outcome']) {
    const ready = decideBody(outcome, rationale);
    if ('error' in ready || busy) return;
    setBusy(true);
    const tid = toastPending(outcome === 'resolved' ? 'Resolving' : 'Rejecting', decision.topic);
    try {
      const res = await writeJson<DecisionDetail>(`/api/graph/decisions/${encodeURIComponent(decision.id)}/decide`, 'POST', ready.body);
      if (!res.ok) throw new Error(res.error ?? 'unknown error');
      toastSuccess(tid, outcome === 'resolved' ? 'Decision resolved' : 'Decision rejected', decision.topic);
      setRationale('');
      onDecided();
    } catch (err) {
      toastError(tid, 'Not decided', (err as Error).message);
    } finally { setBusy(false); }
  }

  return (
    <Card padding="md" data-testid="decision-decide">
      <Stack gap="sm">
        <SectionLabel as="div">Decide</SectionLabel>
        <FormField label="What was decided, and why" required
          hint={`${length}/${RATIONALE_MAX} characters. Kept on the record and in its history.`}
          error={tooLong ? `Keep it to ${RATIONALE_MAX} characters.` : undefined}>
          {(wiring) => (
            <Textarea {...wiring} rows={3} value={rationale} invalid={tooLong} disabled={busy}
              placeholder="The outcome, and the reason for it"
              onChange={(e) => setRationale(e.target.value)} data-testid="decision-rationale" />
          )}
        </FormField>
        <Inline gap="sm" justify="end">
          <ConfirmButton label="Reject" question="Reject this decision?" confirmLabel="Reject" size="sm"
            disabled={'error' in draft} busy={busy} onConfirm={() => decide('rejected')} data-testid="decision-reject" />
          <ConfirmButton label="Resolve" question="Resolve this decision?" confirmLabel="Resolve" size="sm" variant="primary"
            disabled={'error' in draft} busy={busy} onConfirm={() => decide('resolved')} data-testid="decision-resolve" />
        </Inline>
      </Stack>
    </Card>
  );
}

export default function DecisionRecordPage({ onDecided }: { onDecided?: () => void } = {}) {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { can, ready } = useCapabilities();
  const { data: decision, isLoading, error, refresh } =
    useFetch<DecisionDetail>(id ? `/api/graph/decisions/${encodeURIComponent(id)}` : null, 20_000);
  const pid = decision?.projectId ? encodeURIComponent(decision.projectId) : null;
  // The escalation columns and the held-up work item live on the initiative's own read of the table.
  const { data: siblings } = useFetch<DecisionInitiativeRow[]>(pid ? `/api/graph/projects/${pid}/decisions` : null, 30_000);
  const { data: initiative } = useFetch<InitiativeName>(pid ? `/api/graph/projects/${pid}` : null, 60_000);
  useCrumbLabel(id, decision?.topic);
  const mayDecide = !!decision && ready && showDecideControl(decision, can);
  usePublishPageContext(decision ? decisionPageContext(decision, pathname, mayDecide) : null);

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
  // Once decided in the product, the line names who made the call, not who was assigned it.
  const standing = standingLine({ ...decision, escalatedAt: row?.escalatedAt ?? null, requiredRole: row?.requiredRole ?? null },
    (settled ? decision.decidedBy?.name : null) ?? who?.name ?? null, relativeTime);
  const outcome = outcomeLine(decision, relativeTime);
  const history = historyOf(decision, row, projectName);
  const projectHref = decision.projectId ? `/iq/projects/${encodeURIComponent(decision.projectId)}` : null;

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
                {event.at && <T tone="tertiary" title={absoluteTime(asInstant(event.at))}>{relativeTime(asInstant(event.at))}</T>}</Inline>
              <T tone="secondary" wrap>{event.detail}</T>
            </Stack>
          ))}
        </Stack>
      </RailSection>
    </>
  );

  return (
    <PageSection size="sm" title={decision.topic}
      actions={<RecordLink to="/iq/decisions">← All decisions</RecordLink>}
      data-testid="decision-record">
      <Stack gap="md">
        <Inline align="center" gap="sm">
          <Chip tone={STATUS_TONE[decision.status] ?? 'neutral'} size="sm" dot="static">{statusLabel(decision.status)}</Chip>
          <MetaLine size="sm" items={[standing]} />
        </Inline>
        <RailLayout rail={rail}>
          <Stack gap="md">
            <Card padding="md">
              <KeyValue labelWidth="w-28" items={[
                { label: 'Decider', value: who ? `${who.name}${who.title ? `, ${who.title}` : ''}` : 'Not assigned', muted: !who },
                { label: 'Needs', value: row?.requiredRole ?? 'Any steward', muted: !row?.requiredRole },
                ...(settled && decision.decidedAt ? [{ label: 'Decided', value: relativeTime(asInstant(decision.decidedAt)) }] : []),
                ...(settled && decision.decidedBy ? [{ label: 'Decided by', value: decision.decidedBy.name }] : []),
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
            {mayDecide && <DecideCard decision={decision} onDecided={() => { refresh(); onDecided?.(); }} />}
          </Stack>
        </RailLayout>
      </Stack>
    </PageSection>
  );
}
