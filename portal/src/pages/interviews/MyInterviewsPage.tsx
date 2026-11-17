// /interviews/my-interviews — the interviewer's home (docs/interviews-tenant-plan.md
// "Pages"): the interviews assigned to them, lead or panel, as one desk — what
// to accept, what to prepare, what is coming up, which scorecards are due, what
// is done (GET /api/interviews/interviews, already only theirs). One table, one
// filter row.
//
// Row I1.4: a seat still to answer carries Accept and Decline. Accept is one
// click, confirmed in place on the row; Decline asks for the reason in the
// composer's prompt deck (never a dialog), and the recruiter is told.
//
// The panel's notice (decision 5, its last sentence): an Accept the server answers
// with `needsNotice` opens the prompt deck with the candidate's own notice (same
// text and version, read from that answer) and one line that it applies to the
// panel too. "I have read it — accept" acknowledges, then accepts; "Not now"
// changes nothing. Not a consent: someone who will not be recorded declines.
// Row I6.4: a person whose accepted rounds are still to come and who has not read
// the current version is offered it once per visit ("I have read it" / "Not now");
// it blocks nothing, the seats stay accepted and the room still opens.
//
// Row I5.3: a "Scorecard due" row opens the scorecard; a round whose scorecard is in opens it read-only.
// Row I1.7: rows in "To prepare" and "Upcoming" open the Prepare page; a ready or live round the viewer sits on also
// has "Open the room". Scoring (I5.3) is a later row.

import type { ComposerPrompt } from '@connorhoehn/ui-components/social/rich-composer';
import { Button, Chip, CollectionToolbar, DataTable, Disclosure, Inline, Stack, T, Tabs, type DataTableColumn } from '@connorhoehn/ui-components/shared';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { CollectionCommandHost } from '../../components/collections/CollectionCommandHost';
import { CollectionCommandPage } from '../../components/collections/CollectionCommandPage';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { useFetch } from '../../hooks/useFetch';
import { useSession } from '../../lib/auth';
import { ofTotal } from '../../lib/plural';
import {
  INTERVIEWS_API, candidateHref, ROUND_TYPE_LABELS, deskLabel, deskTone, matches, whenLabel,
  type InterviewRow, type ItemsResponse,
} from '../../lib/interviews';
import { DESK_TABS, deskTabCounts, deskTabRows, firstDeskTab, isLive, type DeskTab } from '../../lib/interviewsDesk';
import { roomHref } from '../../lib/interviewsRoom';
import { canOpenRoom, preparePath, roomPath } from '../../lib/interviewsPrepare';
import { hasScorecard, scorecardPath } from '../../lib/interviewsScorecard';
import {
  NOTICE_LATER, NOTICE_READ, PANEL_NOTICE_PATH, REASON_MAX, acceptSeat, acknowledgePanelNotice, answerChangedNotice, answerPanelNotice, declineSeat, noticeParagraphs, reasonProblem,
  shouldReaskNotice, type PanelNotice, type PanelNoticeStatus,
} from '../../lib/interviewsAssign';
import { PersonCell } from './interviewsCells';
import { interviewsCollectionAdapter } from './interviewsCollectionCommands';

const COLUMNS: DataTableColumn<InterviewRow>[] = [
  {
    key: 'when', header: 'When', numeric: true, width: '168px', sortable: true, compare: (a, b) => (a.scheduledAt ?? '').localeCompare(b.scheduledAt ?? ''),
    render: (r) => <T size="sm" title={r.scheduledAt ? new Date(r.scheduledAt).toLocaleString() : undefined}>{whenLabel(r.scheduledAt)}</T>,
  },
  {
    key: 'candidate', header: 'Candidate', sortable: true, compare: (a, b) => a.candidate.name.localeCompare(b.candidate.name),
    render: (r) => <PersonCell name={r.candidate.name} title={`${r.candidate.name}, ${r.candidate.headline}`} testId="interviews-desk-candidate" to={candidateHref(r.candidate.id)} />,
  },
  { key: 'round', header: 'Round', render: (r) => <T size="sm" title={`${ROUND_TYPE_LABELS[r.round.type]}, ${r.round.minutes} minutes`}>{r.round.name}</T> },
  { key: 'opening', header: 'Opening', render: (r) => <T size="sm" title={`${r.opening.title}, ${r.opening.team}`}>{r.opening.title}</T> },
  {
    key: 'seat', header: 'With', render: (r) => (r.seat === 'panel'
      ? <PersonCell id={r.lead.id} name={r.lead.name} title={`${r.lead.name} leads; you are on the panel`} />
      : r.panel.length ? <PersonCell id={r.panel[0]!.id} name={r.panel[0]!.name} title={`${r.panel.map((p) => p.name).join(', ')} on the panel; you lead`} />
        : <T size="sm" tone="secondary">You lead</T>),
  },
  {
    key: 'desk', header: 'Waiting for', width: '176px',
    render: (r) => (isLive(r)
      ? <Chip tone="success" size="sm" data-testid="interviews-desk-live">Live now</Chip>
      : <Chip tone={deskTone(r)} size="sm" data-testid="interviews-desk-state">{deskLabel(r)}</Chip>),
  },
];

export default function MyInterviewsPage() {
  const { session } = useSession();
  return <MyInterviewsWorkspace key={`${session?.sub}:${session?.tenant}:${session?.role}`} />;
}

function MyInterviewsWorkspace() {
  const navigate = useNavigate();
  const { data, error, isLoading, refresh } = useFetch<ItemsResponse<InterviewRow>>(`${INTERVIEWS_API}/interviews`, 30_000);
  const [query, setQuery] = useState('');
  /** Rows answered on this page: the confirmation shown in place until the desk reloads. */
  const [answered, setAnswered] = useState<ReadonlyMap<string, string>>(new Map());
  const [busy, setBusy] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; text: string } | null>(null);
  const [declining, setDeclining] = useState<InterviewRow | null>(null);
  const [asked, setAsked] = useState(0);
  /** The Accept waiting for the panel's notice, with the notice the server sent. */
  const [noticeFor, setNoticeFor] = useState<{ row: InterviewRow; notice: PanelNotice; n: number } | null>(null);
  /** Row I6.4: the notice changed since this person accepted; offered once per visit, blocking nothing. */
  const reask = useFetch<PanelNoticeStatus>(PANEL_NOTICE_PATH);
  const [reaskDone, setReaskDone] = useState(false);
  const [reaskNotice, setReaskNotice] = useState<{ notice: PanelNotice; n: number } | null>(null);
  const note = (id: string, text: string) => setAnswered((m) => new Map(m).set(id, text));
  const acceptedNote = (r: InterviewRow) => (r.seat === 'lead' ? 'Accepted. Choose its questions next.' : 'Accepted. You are on the panel.');

  const accept = async (r: InterviewRow) => {
    setBusy(r.id); setRowError(null);
    const out = await acceptSeat(r.id, r.revision);
    setBusy(null);
    if (!out.ok && out.needsNotice) { const notice = out.needsNotice; setNoticeFor((p) => ({ row: r, notice, n: (p?.n ?? 0) + 1 })); return; }
    if (!out.ok) { setRowError({ id: r.id, text: out.error }); refresh(); return; }
    note(r.id, acceptedNote(r));
    refresh();
  };

  const prompts = useMemo<ComposerPrompt[]>(() => (declining ? [{
    id: `interviews-decline:${declining.id}:${asked}`, scope: 'interviews-my-interviews', kind: 'text',
    eyebrow: declining.seat === 'lead' ? 'Decline to lead' : 'Decline the panel seat',
    title: `${declining.round.name} with ${declining.candidate.name}`,
    question: 'Why are you declining? The recruiter reads your reason and arranges someone else.',
    placeholder: `Your reason, up to ${REASON_MAX} characters`,
    fields: [{ label: 'Opening', value: declining.opening.title }, { label: 'When', value: whenLabel(declining.scheduledAt) }],
    options: [{ id: 'keep', label: 'Keep the round' }],
    onAnswer: async (a) => {
      if (a.kind !== 'text') { setDeclining(null); return { receipt: 'Kept. Nothing was declined.' }; }
      const problem = reasonProblem(a.text);
      if (problem) return { error: problem };
      const row = declining;
      const out = await declineSeat(row.id, row.revision, a.text.trim());
      if (!out.ok) { refresh(); return { error: out.error }; }
      setDeclining(null);
      note(row.id, 'Declined. The recruiter has been told.');
      refresh();
      return { receipt: 'Declined. The recruiter has been told.' };
    },
  }] : []), [declining, asked, refresh]);

  const noticePrompts = useMemo<ComposerPrompt[]>(() => {
    if (!noticeFor) return [];
    const { row, notice, n } = noticeFor;
    return [{
      id: `interviews-panel-notice:${row.id}:${notice.version}:${n}`, scope: 'interviews-my-interviews', kind: 'choice',
      eyebrow: row.seat === 'lead' ? 'Before you accept to lead' : 'Before you accept the panel seat',
      title: notice.title,
      question: notice.panelLine,
      fields: [
        { label: 'Round', value: `${row.round.name} with ${row.candidate.name}` },
        {
          label: 'The notice the candidate reads',
          value: (
            <Disclosure density="compact" variant="plain" summary="Read the notice" data-testid="interviews-panel-notice-fold">
              <Stack gap="xs" className="max-h-64 overflow-y-auto" data-testid="interviews-panel-notice-text">
                {noticeParagraphs(notice.text).map((p) => <T key={p} size="sm" as="p">{p}</T>)}
              </Stack>
            </Disclosure>
          ),
        },
      ],
      options: [{ id: NOTICE_READ, label: 'I have read it — accept', emphasis: 'primary' }, { id: NOTICE_LATER, label: 'Not now' }],
      onAnswer: async (a) => {
        const optionId = a.kind === 'choice' ? a.optionId : NOTICE_LATER;
        const out = await answerPanelNotice(optionId, notice, {
          acknowledge: (version) => acknowledgePanelNotice(row.id, version),
          accept: () => acceptSeat(row.id, row.revision),
        });
        if ('error' in out) {
          if (out.renotice) setNoticeFor({ row, notice: out.renotice, n: n + 1 });
          refresh();
          return { error: out.error };
        }
        setNoticeFor(null);
        if (out.accepted) { note(row.id, acceptedNote(row)); refresh(); }
        return { receipt: out.receipt };
      },
    }];
  }, [noticeFor, refresh]);
  const reaskPrompts = useMemo<ComposerPrompt[]>(() => {
    const status = reask.data;
    if (reaskDone || noticeFor || !status || !shouldReaskNotice(status)) return [];
    const roundId = status.roundId!;
    const { notice, n } = reaskNotice ?? { notice: status.notice, n: 0 };
    return [{
      id: `interviews-panel-notice-changed:${notice.version}:${n}`, scope: 'interviews-my-interviews', kind: 'choice',
      eyebrow: 'The notice has changed since you accepted',
      title: notice.title,
      question: notice.panelLine,
      fields: [
        { label: 'Your rounds', value: status.pendingRounds === 1 ? 'One round you accepted is still to come.' : `${status.pendingRounds} rounds you accepted are still to come.` },
        {
          label: 'The notice the candidate reads',
          value: (
            <Disclosure density="compact" variant="plain" summary="Read the notice" data-testid="interviews-panel-notice-changed-fold">
              <Stack gap="xs" className="max-h-64 overflow-y-auto" data-testid="interviews-panel-notice-changed-text">
                {noticeParagraphs(notice.text).map((p) => <T key={p} size="sm" as="p">{p}</T>)}
              </Stack>
            </Disclosure>
          ),
        },
      ],
      options: [{ id: NOTICE_READ, label: 'I have read it', emphasis: 'primary' }, { id: NOTICE_LATER, label: 'Not now' }],
      onAnswer: async (a) => {
        const optionId = a.kind === 'choice' ? a.optionId : NOTICE_LATER;
        const out = await answerChangedNotice(optionId, notice, (version) => acknowledgePanelNotice(roundId, version));
        if ('error' in out) {
          if (out.renotice) setReaskNotice({ notice: out.renotice, n: n + 1 });
          return { error: out.error };
        }
        setReaskDone(true);
        return { receipt: out.receipt };
      },
    }];
  }, [reask.data, reaskDone, reaskNotice, noticeFor]);
  const deck = useMemo(() => [...noticePrompts, ...reaskPrompts, ...prompts], [noticePrompts, reaskPrompts, prompts]);

  const answerCell = (r: InterviewRow) => {
    const done = answered.get(r.id);
    if (done) return <T size="xs" tone="secondary" data-testid="interviews-desk-answered">{done}</T>;
    if (r.myAnswer !== 'to-answer') {
      const prepare = !isLive(r) && (r.bucket === 'to-prepare' || r.bucket === 'upcoming');
      const card = hasScorecard(r);
      if (!prepare && !canOpenRoom(r) && !card) return null;
      return (
        <Inline gap="xs" wrap={false}>
          {card && <Button size="sm" variant={r.bucket === 'scorecard-due' ? 'primary' : 'ghost'} data-testid="interviews-desk-scorecard"
            onClick={() => void navigate(scorecardPath(r.id))}>{r.bucket === 'scorecard-due' ? 'Fill in the scorecard' : 'Your scorecard'}</Button>}
          {prepare && <Button size="sm" variant={r.bucket === 'to-prepare' && r.seat === 'lead' ? 'primary' : 'ghost'} data-testid="interviews-desk-prepare"
            onClick={() => void navigate(preparePath(r.id))}>{r.seat === 'lead' ? 'Prepare' : 'Read the plan'}</Button>}
          {isLive(r) && r.seat !== null
            ? <Button size="sm" variant="primary" data-testid="interviews-desk-join" onClick={() => void navigate(roomHref(r.id))}>Join</Button>
            : canOpenRoom(r) && <Button size="sm" variant="secondary" data-testid="interviews-desk-room" onClick={() => void navigate(roomPath(r.id))}>Open the room</Button>}
        </Inline>
      );
    }
    return (
      <Stack gap="none">
        <Inline gap="xs" wrap={false}>
          <Button size="sm" variant="primary" disabled={busy !== null} data-testid="interviews-desk-accept" onClick={() => { void accept(r); }}>Accept</Button>
          <Button size="sm" variant="ghost" disabled={busy !== null} data-testid="interviews-desk-decline"
            onClick={() => { setRowError(null); setNoticeFor(null); setAsked((n) => n + 1); setDeclining(r); }}>Decline…</Button>
        </Inline>
        {rowError?.id === r.id && <T size="xs" tone="danger">{rowError.text}</T>}
      </Stack>
    );
  };
  const [picked, setPicked] = useState<DeskTab | null>(null);
  const all = data?.items ?? [];
  const counts = deskTabCounts(all);
  const tab = picked ?? firstDeskTab(counts, all.some(isLive));
  const inTab = deskTabRows(all, tab);
  const rows = inTab.filter((r) => matches(query, r.candidate.name, r.candidate.headline, r.round.name, r.opening.title, r.opening.team, r.lead.name, deskLabel(r)));

  const adapter = interviewsCollectionAdapter('my-interviews', {
    setQuery, refresh,
    setFilter: (v) => setPicked(DESK_TABS.some((d) => d.value === v) ? (v as DeskTab) : null),
  });

  return (
    <CollectionCommandPage data-testid="interviews-my-interviews" title="My interviews"
      description="The interviews assigned to you: what to accept, what to prepare, what is coming up and which scorecards are due.">
      <Stack gap="none" className="min-h-0 min-w-0 flex-1">
        <Stack gap="md" className="min-h-0 flex-1 overflow-auto px-[var(--ui-page-gutter)]">
          <CollectionToolbar {...{
            label: 'Interview filters',
            search: { value: query, onChange: setQuery, placeholder: 'Search your interviews', 'aria-label': 'Search your interviews' },
            summary: data ? ofTotal(rows.length, inTab.length, 'interview') : undefined,
            onRefresh: refresh, refreshing: isLoading,
          }}>
            <Tabs aria-label="Your interviews" size="sm" value={tab} onValueChange={(v) => setPicked(v as DeskTab)} getItemTestId={(i) => `interviews-desk-tab-${i.id}`}
              items={DESK_TABS.map((d) => ({ id: d.value, label: d.label, badge: data ? counts[d.value] : undefined }))} />
          </CollectionToolbar>
          {error ? (
            <UnavailableNotice error={error} what="your interviews" source="Interviews are read from the rounds assigned to you" onRetry={refresh} />
          ) : (
            <DataTable narrow rowHeight="content"
              data-testid="interviews-my-interviews-table"
              aria-label="My interviews"
              data={rows}
              columns={COLUMNS}
              keyField={(r) => r.id}
              rowActions={answerCell}
              rowActionsHeader="Answer"
              rowActionsHeaderHidden
              loading={isLoading && !data}
              pageSize={25}
              emptyMessage={query.trim() ? 'No interview matches this search.' : 'Nothing here right now.'}
            />
          )}
        </Stack>
        <CollectionCommandHost adapter={adapter} prompts={deck} />
      </Stack>
    </CollectionCommandPage>
  );
}
