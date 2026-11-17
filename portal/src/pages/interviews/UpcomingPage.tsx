// /interviews/upcoming — the recruiter's schedule (docs/interviews-tenant-plan.md "Pages", row I1.5): every
// round by time, rounds without a time last. The recruiter sets, changes or clears a round's time from its row
// with the library's DateTimeField; the change is saved only after a confirm in the composer's prompt deck
// (never a dialog), and the lead and panel are told. Times are kept in UTC and shown in the viewer's own zone,
// named. A round with a time can have the candidate's invite link: made here, shown once with a copy control,
// its status read from the invite routes, revoked through a prompt. The recruiter also sees a Consent column (row I2.5):
// not answered, all on, or what the round runs without, so they can arrange what replaces it; never why.

import { DateTimeField } from '@connorhoehn/ui-components';
import type { ComposerPrompt } from '@connorhoehn/ui-components/social/rich-composer';
import { Button, Chip, CollectionToolbar, CopyIdButton, DataTable, Inline, Stack, T, type DataTableColumn } from '@connorhoehn/ui-components/shared';
import { useMemo, useState } from 'react';
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

/** One round's link: its status, made or revoked in place. The link itself is only in the page's memory, from the answer that made it. */
function InviteCell({ row, status, link, busy, onMake, onRevoke }: {
  row: InterviewRow; status: InviteStatus | null; link: string | undefined; busy: boolean; onMake(): void; onRevoke(): void;
}) {
  const live = status?.state === 'live';
  return (
    <Stack gap="none">
      <Inline gap="xs" align="center" wrap={false}>
        <Button size="sm" variant="ghost" disabled={busy} data-testid="interviews-upcoming-invite" onClick={onMake}>{live ? 'New link…' : 'Invite link'}</Button>
        {live && <Button size="sm" variant="ghost" disabled={busy} data-testid="interviews-upcoming-revoke" onClick={onRevoke}>Revoke…</Button>}
        {link && <CopyIdButton value={link} label={`Copy the invite link for ${row.candidate.name}`} data-testid="interviews-upcoming-copy" />}
      </Inline>
      {link && <T size="xs" tone="secondary" data-testid="interviews-upcoming-link-once">Link made. Copy it now: it is not shown again.</T>}
      {status && status.state !== 'none' && <T size="xs" tone="secondary" data-testid="interviews-upcoming-invite-status">{inviteLine(status, sentence)}</T>}
    </Stack>
  );
}

/** Reads a row's invite status once the row has a time. */
function InviteStatusLoader({ row, override, link, busy, onMake, onRevoke }: {
  row: InterviewRow; override: InviteStatus | undefined; link: string | undefined; busy: boolean; onMake(status: InviteStatus | null): void; onRevoke(): void;
}) {
  const { data } = useFetch<{ invite: InviteStatus }>(`${INTERVIEWS_API}/interviews/${encodeURIComponent(row.id)}/invite`);
  const status = override ?? data?.invite ?? null;
  return <InviteCell row={row} status={status} link={link} busy={busy} onMake={() => onMake(status)} onRevoke={onRevoke} />;
}

function UpcomingWorkspace() {
  const { session } = useSession();
  const { data, error, isLoading, refresh } = useFetch<ItemsResponse<InterviewRow>>(`${INTERVIEWS_API}/interviews`, 30_000);
  const withConsent = showsConsentColumn(session?.role);
  const consents = useFetch<ItemsResponse<ConsentEffect>>(withConsent ? CONSENT_EFFECTS_PATH : null, 30_000);
  const consentOf = useMemo(() => new Map((consents.data?.items ?? []).map((c) => [c.interviewId, c])), [consents.data]);
  const [query, setQuery] = useState('');
  const [timeFilter, setTimeFilter] = useState<TimeFilter>('');
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
          : 'Clear the time? The round goes back to having none, and nobody is told.',
        fields,
        onAnswer: async (a) => {
          if (a.kind !== 'confirm' || !a.confirmed) { setPending(null); setEditing(null); return { receipt: 'Kept. The time did not change.' }; }
          const out = await setRoundTime(row.id, row.revision, next);
          if (!out.ok) { if (out.stale) refresh(); return { error: out.error }; }
          setPending(null); setEditing(null);
          setSaved((m) => new Map(m).set(row.id, next ? `Saved: ${whenWithZone(next)}.` : 'The time was cleared.'));
          refresh();
          return { receipt: next ? 'The time is set.' : 'The time is cleared.' };
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
        <Stack gap="none">
          <T size="sm" title={`${r.opening.title}, ${r.opening.team}`} className="block max-w-[16rem] truncate">{r.opening.title}</T>
          <T size="xs" tone="secondary" title={`${ROUND_TYPE_LABELS[r.round.type]}, ${r.round.minutes} minutes`}>{r.round.name}</T>
        </Stack>
      ),
    },
    { key: 'people', header: 'Lead and panel', render: (r) => <PanelCell lead={r.lead} panel={r.panel} /> },
    {
      key: 'state', header: 'State', width: '112px',
      render: (r) => { const s = roundStatus(r.state); return <Chip tone={s.tone} size="xs" data-testid="interviews-upcoming-state">{s.label}</Chip>; },
    },
    ...(withConsent ? [{
      key: 'consent', header: 'Consent', width: '200px',
      render: (r: InterviewRow) => {
        const c = consentOf.get(r.id);
        const label = consents.data ? consentColumnLabel(c) : '—';
        return <T size="sm" tone={!c?.answered ? 'secondary' : undefined} data-testid="interviews-upcoming-consent">{label}</T>;
      },
    }] : []),
    {
      key: 'when', header: `Time (${zone})`, width: '280px', sortable: true, compare: (a, b) => upcomingOrder(a, b),
      render: (r) => {
        const done = saved.get(r.id);
        if (!isTimeable(r.state)) return <T size="sm" tone="secondary" title={r.scheduledAt ? new Date(r.scheduledAt).toLocaleString() : undefined}>{whenWithZone(r.scheduledAt)}</T>;
        if (editing === r.id) {
          return (
            <Stack gap="none">
              <DateTimeField label={`Time for ${r.round.name} with ${r.candidate.name}`} value={r.scheduledAt} min={nowIso} minMessage="Choose a time in the future."
                hint={`Shown in ${zone}`} data-testid="interviews-upcoming-time-field"
                onChange={(iso) => ask({ kind: 'time', row: r, iso })} />
              <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
            </Stack>
          );
        }
        return (
          <Stack gap="none">
            <Inline gap="xs" align="center" wrap={false}>
              <T size="sm" tone={r.scheduledAt ? undefined : 'secondary'} title={r.scheduledAt ? new Date(r.scheduledAt).toLocaleString() : undefined} data-testid="interviews-upcoming-when">{whenWithZone(r.scheduledAt)}</T>
              <Button size="sm" variant="ghost" data-testid="interviews-upcoming-set-time" onClick={() => { setRowError(null); setEditing(r.id); }}>{r.scheduledAt ? 'Change…' : 'Set time…'}</Button>
              {r.scheduledAt && <Button size="sm" variant="ghost" data-testid="interviews-upcoming-clear-time" onClick={() => ask({ kind: 'time', row: r, iso: null })}>Clear…</Button>}
            </Inline>
            {done && <T size="xs" tone="secondary" data-testid="interviews-upcoming-saved">{done}</T>}
            {rowError?.id === r.id && <T size="xs" tone="danger">{rowError.text}</T>}
          </Stack>
        );
      },
    },
    {
      key: 'invite', header: 'Invite link', width: '260px',
      render: (r) => (r.scheduledAt && isTimeable(r.state)
        ? <InviteStatusLoader row={r} override={statuses.get(r.id)} link={links.get(r.id)} busy={busy === r.id}
            onMake={(s) => (s?.state === 'live' ? ask({ kind: 'replace', row: r }) : void make(r))} onRevoke={() => ask({ kind: 'revoke', row: r })} />
        : <T size="xs" tone="tertiary">{r.scheduledAt ? '—' : 'Set a time first'}</T>),
    },
  ];

  const all = [...(data?.items ?? [])].filter((r) => r.state !== 'declined' && r.state !== 'cancelled').sort(upcomingOrder);
  const rows = all.filter((r) => (timeFilter === '' || (timeFilter === 'timed') === (r.scheduledAt !== null))
    && matches(query, r.candidate.name, r.candidate.headline, r.opening.title, r.opening.team, r.round.name, r.lead.name, ...r.panel.map((p) => p.name)));

  const adapter = interviewsCollectionAdapter('upcoming', {
    setQuery, refresh,
    setFilter: (v) => setTimeFilter((v === 'no-time' || v === 'timed' ? v : '') as TimeFilter),
  });

  return (
    <CollectionCommandPage data-testid="interviews-upcoming" title="Upcoming"
      description="Every round by time. Set a time from the row, then send the candidate their link.">
      <Stack gap="none" className="min-h-0 min-w-0 flex-1">
        <Stack gap="md" className="min-h-0 flex-1 overflow-auto px-[var(--ui-page-gutter)]">
          <CollectionToolbar {...{
            label: 'Upcoming filters',
            search: { value: query, onChange: setQuery, placeholder: 'Search rounds', 'aria-label': 'Search rounds' },
            filters: [{
              id: 'time', label: 'Time', value: timeFilter, emptyValue: '', onChange: (v: string) => setTimeFilter((v || '') as TimeFilter),
              options: [{ value: 'timed', label: 'Has a time' }, { value: 'no-time', label: 'No time yet' }],
            }],
            summary: data ? ofTotal(rows.length, all.length, 'round') : undefined,
            onRefresh: refresh, refreshing: isLoading,
          }} />
          {error ? (
            <UnavailableNotice error={error} what="the rounds" source="Rounds are read from the interviews assigned in this tenant" onRetry={refresh} />
          ) : (
            <DataTable narrow
              data-testid="interviews-upcoming-table"
              aria-label="Upcoming rounds"
              data={rows}
              columns={COLUMNS}
              keyField={(r) => r.id}
              loading={isLoading && !data}
              pageSize={25}
              emptyMessage={query.trim() || timeFilter ? 'No round matches this search and filter.' : 'No rounds are assigned yet.'}
            />
          )}
        </Stack>
        <CollectionCommandHost adapter={adapter} prompts={prompts} />
      </Stack>
    </CollectionCommandPage>
  );
}
