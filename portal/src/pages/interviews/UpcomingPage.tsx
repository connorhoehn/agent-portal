// /interviews/upcoming — the recruiter's schedule (docs/interviews-tenant-plan.md "Pages", row I1.5): every
// round by time, rounds without a time last. The recruiter sets, changes or clears a round's time from its row
// with the library's DateTimeField; the change is saved only after a confirm in the composer's prompt deck
// (never a dialog), and the lead and panel are told. Times are kept in UTC and shown in the viewer's own zone,
// named. A round with a time can have the candidate's invite link: made here, shown once with a copy control,
// its status read from the invite routes, revoked through a prompt. The recruiter also sees a Consent column (row I2.5):
// not answered, all on, or what the round runs without, so they can arrange what replaces it; never why.

import { DateTimeField } from '@connorhoehn/ui-components';
import type { ComposerPrompt } from '@connorhoehn/ui-components/social/rich-composer';
import { Button, Chip, CollectionToolbar, CopyIdButton, DataTable, DropdownMenu, Inline, Stack, T, type DataTableColumn, type DropdownMenuItem } from '@connorhoehn/ui-components/shared';
import { RoundCloseDialog, roundCloseItems, type RoundCloseMode } from './RoundCloseDialog';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { CollectionCommandHost } from '../../components/collections/CollectionCommandHost';
import { CollectionCommandPage } from '../../components/collections/CollectionCommandPage';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { useFetch } from '../../hooks/useFetch';
import { useSession } from '../../lib/auth';
import { ofTotal } from '../../lib/plural';
import {
  INTERVIEWS_API, ROUND_TYPE_LABELS, candidateHref, isTimeable, matches, roundStatus, upcomingOrder, whenLabel, whenWithZone, zoneName,
  type InterviewRow, type ItemsResponse,
} from '../../lib/interviews';
import {
  CONSENT_EFFECTS_PATH, consentColumnLabel, inviteLine, issueInvite, revokeInvite, setRoundTime, showsConsentColumn, type ConsentEffect, type InviteStatus,
} from '../../lib/interviewsUpcoming';
import { finishedCount, isLive, upcomingRows, type UpcomingShow } from '../../lib/interviewsDesk';
import { conflictsLine } from '../../lib/interviewsAssign';
import { roomEntryLabel, roomHref } from '../../lib/interviewsRoom';
import { useJoinedInterviewCall } from '../../components/shell/InterviewRoomFooter';
import { PanelCell, PersonCell } from './interviewsCells';
import { interviewsCollectionAdapter } from './interviewsCollectionCommands';

type TimeFilter = '' | 'no-time' | 'timed';
type Pending =
  | { kind: 'time'; row: InterviewRow; iso: string | null }
  | { kind: 'revoke'; row: InterviewRow }
  | { kind: 'replace'; row: InterviewRow };

const sentence = (iso: string): string => whenLabel(iso);

export default function UpcomingPage() {
  const { session } = useSession();
  return <UpcomingWorkspace key={`${session?.sub}:${session?.tenant}:${session?.role}`} />;
}

/** One round's link: what became of it, and the copy control for a link just made. Making and revoking are in the row's menu. */
function InviteCell({ row, status, link }: { row: InterviewRow; status: InviteStatus | null; link: string | undefined }) {
  return (
    <Stack gap="none">
      <Inline gap="xs" align="center" wrap={false}>
        {status && status.state !== 'none'
          ? <T size="xs" tone="secondary" title={inviteLine(status, sentence)} data-testid="interviews-upcoming-invite-status">{inviteLine(status, sentence)}</T>
          : <T size="xs" tone="tertiary">No link yet</T>}
        {link && <CopyIdButton value={link} label={`Copy the invite link for ${row.candidate.name}`} data-testid="interviews-upcoming-copy" />}
      </Inline>
      {link && <T size="xs" tone="secondary" data-testid="interviews-upcoming-link-once">Link made. Copy it now: it is not shown again.</T>}
    </Stack>
  );
}

/** One round's time: what it is, and the note after a change. Changing and clearing it are in the row's menu. */
function TimeCell({ row, done, error }: { row: InterviewRow; done: string | undefined; error: string | null }) {
  return (
    <Stack gap="none">
      <T size="sm" tone={row.scheduledAt ? undefined : 'secondary'} className="block" title={row.scheduledAt ? new Date(row.scheduledAt).toLocaleString() : undefined} data-testid="interviews-upcoming-when">{whenWithZone(row.scheduledAt)}</T>
      {done && <T size="xs" tone="secondary" data-testid="interviews-upcoming-saved">{done}</T>}
      {error && <T size="xs" tone="danger">{error}</T>}
    </Stack>
  );
}

/** Reads a row's invite status once the row has a time. */
function InviteStatusLoader({ row, override, link }: { row: InterviewRow; override: InviteStatus | undefined; link: string | undefined }) {
  const { data } = useFetch<{ invite: InviteStatus }>(`${INTERVIEWS_API}/interviews/${encodeURIComponent(row.id)}/invite`, undefined, { share: true });
  return <InviteCell row={row} status={override ?? data?.invite ?? null} link={link} />;
}

/** The row's actions: Join for a live round, and one menu for the time and the link. */
function RowActions({ row, joinedId, override, busy, onJoin, onSetTime, onClearTime, onMake, onRevoke, closeItems }: {
  row: InterviewRow; joinedId: string | null; override: InviteStatus | undefined; busy: boolean; onJoin(): void; onSetTime(): void; onClearTime(): void; onMake(status: InviteStatus | null): void; onRevoke(): void;
  /** End, "Did not take place" and Cancel (RoundCloseDialog roundCloseItems), last in the menu. */
  closeItems: DropdownMenuItem[];
}) {
  const timeable = isTimeable(row.state);
  const { data } = useFetch<{ invite: InviteStatus }>(timeable && row.scheduledAt ? `${INTERVIEWS_API}/interviews/${encodeURIComponent(row.id)}/invite` : null, undefined, { share: true });
  const status = override ?? data?.invite ?? null;
  const live = status?.state === 'live';
  const items = [
    ...(timeable ? [{ label: row.scheduledAt ? 'Change the time…' : 'Set the time…', onSelect: onSetTime }] : []),
    ...(timeable && row.scheduledAt ? [{ label: 'Clear the time…', onSelect: onClearTime }] : []),
    ...(timeable && row.scheduledAt && !busy ? [{ label: live ? 'Make a new link…' : 'Make the invite link', onSelect: () => onMake(status) }] : []),
    ...(timeable && row.scheduledAt && live && !busy ? [{ label: 'Revoke the link…', danger: true, onSelect: onRevoke }] : []),
    ...closeItems,
  ];
  return (
    <Inline gap="xs" align="center" wrap={false}>
      {isLive(row) && row.seat && <Button size="sm" variant="primary" data-testid="interviews-upcoming-join" onClick={onJoin}>{roomEntryLabel(row.id, joinedId)}</Button>}
      {items.length > 0 && <DropdownMenu trigger="Actions ▾" triggerLabel={`Actions for ${row.round.name} with ${row.candidate.name}`} align="end" triggerTestId="interviews-upcoming-actions" sections={[{ items }]} />}
    </Inline>
  );
}

function UpcomingWorkspace() {
  const navigate = useNavigate();
  const joinedId = useJoinedInterviewCall();
  const { session } = useSession();
  const { data, error, isLoading, refresh } = useFetch<ItemsResponse<InterviewRow>>(`${INTERVIEWS_API}/interviews`, 30_000);
  const { session: me } = useSession();
  const recruits = ['recruiter', 'admin'].includes(String(me?.role));
  const [closing, setClosing] = useState<{ round: InterviewRow; mode: RoundCloseMode } | null>(null);
  const withConsent = showsConsentColumn(session?.role);
  const consents = useFetch<ItemsResponse<ConsentEffect>>(withConsent ? CONSENT_EFFECTS_PATH : null, 30_000);
  const consentOf = useMemo(() => new Map((consents.data?.items ?? []).map((c) => [c.interviewId, c])), [consents.data]);
  const [query, setQuery] = useState('');
  const [timeFilter, setTimeFilter] = useState<TimeFilter>('');
  const [show, setShow] = useState<UpcomingShow>('not-finished');
  const [editing, setEditing] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [asked, setAsked] = useState(0);
  const [saved, setSaved] = useState<ReadonlyMap<string, string>>(new Map());
  const [links, setLinks] = useState<ReadonlyMap<string, string>>(new Map());
  const [statuses, setStatuses] = useState<ReadonlyMap<string, InviteStatus>>(new Map());
  const [busy, setBusy] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; text: string } | null>(null);
  const zone = zoneName();
  const nowIso = new Date().toISOString();

  const ask = (p: Pending) => { setRowError(null); setAsked((n) => n + 1); setPending(p); };

  const make = async (row: InterviewRow) => {
    setBusy(row.id); setRowError(null);
    const out = await issueInvite(row.id);
    setBusy(null);
    if (!out.ok) { setRowError({ id: row.id, text: out.error }); return; }
    setLinks((m) => new Map(m).set(row.id, out.link));
    setStatuses((m) => new Map(m).set(row.id, out.invite));
  };

  const prompts = useMemo<ComposerPrompt[]>(() => {
    if (!pending) return [];
    const { row } = pending;
    const base = { scope: 'interviews-upcoming', kind: 'confirm' as const, options: [{ id: 'yes', label: 'Confirm' }, { id: 'no', label: 'Cancel' }] };
    const fields = [{ label: 'Candidate', value: row.candidate.name }, { label: 'Opening', value: row.opening.title }];
    if (pending.kind === 'time') {
      const next = pending.iso;
      return [{
        ...base, id: `interviews-time:${row.id}:${asked}`, eyebrow: next ? (row.scheduledAt ? 'Change the time' : 'Set the time') : 'Clear the time',
        title: `${row.round.name} with ${row.candidate.name}`,
        question: next
          ? `Set the time to ${whenWithZone(next)}? The lead and the panel are told.`
          : 'Clear the time? The round goes back to having none. The lead and the panel are told.',
        fields,
        onAnswer: async (a) => {
          if (a.kind !== 'confirm' || !a.confirmed) { setPending(null); setEditing(null); return { receipt: 'Kept. The time did not change.' }; }
          const out = await setRoundTime(row.id, row.revision, next);
          if (!out.ok) { if (out.stale) refresh(); return { error: out.error }; }
          setPending(null); setEditing(null);
          // Double-booking is a warning (ledger row C-17): the time is saved, and the clash is said in the same words.
          const clash = out.conflicts.length ? ` ${conflictsLine(out.conflicts)}` : '';
          setSaved((m) => new Map(m).set(row.id, next ? `Saved: ${whenWithZone(next)}.${clash}` : 'The time was cleared.'));
          refresh();
          return { receipt: next ? `The time is set.${clash}` : 'The time is cleared.' };
        },
      }];
    }
    const revoking = pending.kind === 'revoke';
    return [{
      ...base, id: `interviews-invite:${row.id}:${asked}`, eyebrow: revoking ? 'Revoke the link' : 'Make a new link',
      title: `${row.round.name} with ${row.candidate.name}`,
      question: revoking ? 'Revoke the link? Anyone holding it can no longer open it.' : 'Make a new link? The one already sent stops working.',
      fields,
      onAnswer: async (a) => {
        if (a.kind !== 'confirm' || !a.confirmed) { setPending(null); return { receipt: 'Kept. Nothing changed.' }; }
        if (revoking) {
          const out = await revokeInvite(row.id);
          if (!out.ok) return { error: out.error };
          setStatuses((m) => new Map(m).set(row.id, out.invite));
          setLinks((m) => { const n = new Map(m); n.delete(row.id); return n; });
          setPending(null);
          return { receipt: 'The link is revoked.' };
        }
        setPending(null);
        await make(row);
        return { receipt: 'A new link is made.' };
      },
    }];
  }, [pending, asked, refresh]); // eslint-disable-line react-hooks/exhaustive-deps

  const COLUMNS: DataTableColumn<InterviewRow>[] = [
    {
      key: 'candidate', header: 'Candidate', sortable: true, compare: (a, b) => a.candidate.name.localeCompare(b.candidate.name),
      render: (r) => <PersonCell name={r.candidate.name} title={`${r.candidate.name}, ${r.candidate.headline}`} testId="interviews-upcoming-candidate" to={candidateHref(r.candidate.id)} />,
    },
    {
      key: 'round', header: 'Opening and round',
      render: (r) => (
        <T size="sm" title={`${r.opening.title}, ${r.opening.team}; ${ROUND_TYPE_LABELS[r.round.type]}, ${r.round.minutes} minutes`}>{`${r.opening.title} · ${r.round.name}`}</T>
      ),
    },
    { key: 'people', header: 'Lead and panel', render: (r) => <PanelCell lead={r.lead} panel={r.panel} /> },
    {
      key: 'state', header: withConsent ? 'State and consent' : 'State', width: withConsent ? '150px' : '112px',
      render: (r) => {
        const s = roundStatus(r.state);
        const c = consentOf.get(r.id);
        return (
          <Stack gap="none">
            {isLive(r) ? <Chip tone="success" size="sm" data-testid="interviews-upcoming-live">Live now</Chip> : <Chip tone={s.tone} size="sm" data-testid="interviews-upcoming-state">{s.label}</Chip>}
            {withConsent && <T size="xs" tone={!c?.answered ? 'secondary' : undefined} title={consents.data ? consentColumnLabel(c) : undefined} data-testid="interviews-upcoming-consent">{consents.data ? consentColumnLabel(c) : '—'}</T>}
          </Stack>
        );
      },
    },
    {
      key: 'when', header: 'Time and invite link', width: '210px', sortable: true, compare: (a, b) => upcomingOrder(a, b),
      render: (r) => (isTimeable(r.state)
        ? (
          <Stack gap="none">
            <TimeCell row={r} done={saved.get(r.id)} error={rowError?.id === r.id ? rowError.text : null} />
            {r.scheduledAt
              ? <InviteStatusLoader row={r} override={statuses.get(r.id)} link={links.get(r.id)} />
              : <T size="xs" tone="tertiary">Set a time first</T>}
          </Stack>
        )
        : <T size="sm" tone="secondary" title={r.scheduledAt ? new Date(r.scheduledAt).toLocaleString() : undefined}>{whenWithZone(r.scheduledAt)}</T>),
    },
  ];

  const everything = data?.items ?? [];
  const all = upcomingRows(everything, show);
  const finished = finishedCount(everything);
  const editingRow = editing ? all.find((r) => r.id === editing) ?? null : null;
  const rows = all.filter((r) => (timeFilter === '' || (timeFilter === 'timed') === (r.scheduledAt !== null))
    && matches(query, r.candidate.name, r.candidate.headline, r.opening.title, r.opening.team, r.round.name, r.lead.name, ...r.panel.map((p) => p.name)));

  const adapter = interviewsCollectionAdapter('upcoming', {
    setQuery, refresh,
    setFilter: (v) => { setShow(v === 'finished' ? 'finished' : 'not-finished'); setTimeFilter((v === 'no-time' || v === 'timed' ? v : '') as TimeFilter); },
  });

  return (
    <CollectionCommandPage data-testid="interviews-upcoming" title="Upcoming"
      description="Every round by time. Set a time from the row, then send the candidate their link.">
      <Stack gap="none" className="min-h-0 min-w-0 flex-1">
        <Stack gap="md" className="min-h-0 flex-1 overflow-auto px-[var(--ui-page-gutter)]">
          <CollectionToolbar {...{
            label: 'Upcoming filters',
            search: { value: query, onChange: setQuery, placeholder: 'Search rounds', 'aria-label': 'Search rounds' },
            filters: [
              {
                id: 'show', label: 'Show', value: show, emptyValue: 'not-finished', onChange: (v: string) => setShow(v === 'finished' ? 'finished' : 'not-finished'),
                options: [{ value: 'not-finished', label: 'Not finished' }, { value: 'finished', label: data ? `Finished (${finished})` : 'Finished' }],
              },
              {
                id: 'time', label: 'Time', value: timeFilter, emptyValue: '', onChange: (v: string) => setTimeFilter((v || '') as TimeFilter),
                options: [{ value: 'timed', label: 'Has a time' }, { value: 'no-time', label: 'No time yet' }],
              },
            ],
            summary: data ? ofTotal(rows.length, all.length, 'round') : undefined,
            onRefresh: refresh, refreshing: isLoading,
          }} />
          {editingRow && (
            <Inline gap="sm" align="end" data-testid="interviews-upcoming-editor">
              <DateTimeField label={`Time for ${editingRow.round.name} with ${editingRow.candidate.name}`} value={editingRow.scheduledAt} min={nowIso} minMessage="Choose a time in the future."
                hint={`Shown in ${zone}`} data-testid="interviews-upcoming-time-field"
                onChange={(iso) => ask({ kind: 'time', row: editingRow, iso })} />
              <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
            </Inline>
          )}
          {error ? (
            <UnavailableNotice error={error} what="the rounds" source="Rounds are read from the interviews assigned in this tenant" onRetry={refresh} />
          ) : (
            <DataTable narrow rowHeight="content"
              data-testid="interviews-upcoming-table"
              aria-label="Upcoming rounds"
              data={rows}
              columns={COLUMNS}
              keyField={(r) => r.id}
              rowActions={(r) => (
                <RowActions row={r} joinedId={joinedId} override={statuses.get(r.id)} busy={busy === r.id} onJoin={() => void navigate(roomHref(r.id))}
                  onSetTime={() => { setRowError(null); setEditing(r.id); }} onClearTime={() => ask({ kind: 'time', row: r, iso: null })}
                  onMake={(s) => (s?.state === 'live' ? ask({ kind: 'replace', row: r }) : void make(r))} onRevoke={() => ask({ kind: 'revoke', row: r })}
                  closeItems={roundCloseItems(r, { asRecruiter: recruits, isLead: r.seat === 'lead' }, (mode) => setClosing({ round: r, mode }))} />
              )}
              rowActionsHeader="Actions"
              rowActionsHeaderHidden
              loading={isLoading && !data}
              pageSize={25}
              emptyMessage={query.trim() || timeFilter ? 'No round matches this search and filter.' : show === 'finished' ? 'No round has finished yet.' : 'Nothing is coming up. Rounds you assign appear here.'}
            />
          )}
        </Stack>
        <RoundCloseDialog round={closing?.round ?? null} mode={closing?.mode ?? null} onClose={() => setClosing(null)} onDone={refresh} />
        <CollectionCommandHost adapter={adapter} prompts={prompts} />
      </Stack>
    </CollectionCommandPage>
  );
}
