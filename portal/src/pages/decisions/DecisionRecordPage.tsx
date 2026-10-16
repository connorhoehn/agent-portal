// One decision, in full: the question, where it stands, the call and its
// rationale, and — in the context rail — the initiative and work item it
// belongs to, the people (the decider first), the discussion and the history.
// Reads three existing endpoints; it writes nothing (deciding happens where
// the work is: the initiative's board and its discussion).

import { useNavigate, useParams } from 'react-router';
import {
  Avatar, Card, Chip, DetailSection, Inline, KeyValue, LoadingState, MetaLine, PageSection,
  RailLayout, RailSection, SectionLabel, Stack, T,
} from '@connorhoehnslalom/ui-components/shared';
import { RecordNotFound, UnavailableNotice, isNotFoundError } from '../../components/UnavailableNotice';
import { useFetch } from '../../hooks/useFetch';
import { useCrumbLabel } from '../../lib/crumbLabels';
import { absoluteTime, relativeTime } from '../../lib/relativeTime';
import {
  DECISIONS_SOURCE, STATUS_TONE, asInstant, contributors, decider, historyOf, standingLine, statusLabel,
} from './decisionFormat';
import { RecordLink } from './RecordLink';
import type { DecisionDetail, DecisionInitiativeRow, InitiativeName } from './types';

export default function DecisionRecordPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { data: decision, isLoading, error, refresh } =
    useFetch<DecisionDetail>(id ? `/api/graph/decisions/${encodeURIComponent(id)}` : null, 20_000);
  const pid = decision?.projectId ? encodeURIComponent(decision.projectId) : null;
  // The escalation columns and the held-up work item live on the initiative's own read of the table.
  const { data: siblings } = useFetch<DecisionInitiativeRow[]>(pid ? `/api/graph/projects/${pid}/decisions` : null, 30_000);
  const { data: initiative } = useFetch<InitiativeName>(pid ? `/api/graph/projects/${pid}` : null, 60_000);
  useCrumbLabel(id, decision?.topic);

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
  const standing = standingLine({ ...decision, escalatedAt: row?.escalatedAt ?? null, requiredRole: row?.requiredRole ?? null }, who?.name ?? null, relativeTime);
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
            <Avatar name={who.name} size={18} />
            <T>{who.name}</T>
            <Chip tone="accent" size="xs">decider</Chip>
          </Inline>
        )}
        {others.map((p) => (
          <Inline key={p.personId} align="center" gap="xs">
            <Avatar name={p.name} size={18} />
            <T className="truncate">{p.name}</T>
            {p.title && <T tone="tertiary" className="truncate">{p.title}</T>}
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
              ]} />
            </Card>
            <DetailSection first variant="heading" title={settled ? 'The decision and its rationale' : 'The question'}>
              <T size="sm" tone="secondary" wrap as="p">
                {decision.summary ?? (settled ? 'No rationale was recorded with this decision.' : 'The question has not been written up yet.')}
              </T>
            </DetailSection>
          </Stack>
        </RailLayout>
      </Stack>
    </PageSection>
  );
}
