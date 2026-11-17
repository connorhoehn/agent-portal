// /interviews/candidates/:id/assign — the recruiter assigns a round to a candidate's application
// (?application=<id>) or changes who sits on one (?round=<interview id>) (docs/interviews-tenant-plan.md
// row I1.4; decision 20: one lead and up to two panel members). The server checks everything
// (middleware lib/interviews/assign.ts) and answers each problem on its field. A new round has no time:
// that is row I1.5. Each person newly seated is rung and accepts or declines from My interviews.

import { Button, FormField, Inline, LoadingState, PageFrame, Select, Stack, T } from '@connorhoehn/ui-components/shared';
import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { RecordNotFound, UnavailableNotice } from '../../components/UnavailableNotice';
import { useFlushTrailItems } from '../../components/shell/FlushPage';
import { useFetch } from '../../hooks/useFetch';
import { useCrumbLabel } from '../../lib/crumbLabels';
import { INTERVIEWS_API, ROUND_TYPE_LABELS, candidateHref, whenLabel, type CandidateProfile, type ItemsResponse, type PersonRef } from '../../lib/interviews';
import type { OpeningRecord } from '../../lib/interviewsKit';
import {
  PANEL_SEATS, assignRound, canReassign, declineLines, panelChoices, reassignRound, seatingOf, seatsOfRow, type FieldProblem,
} from '../../lib/interviewsAssign';

const NOBODY = '';

export default function AssignRoundPage() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const base = useFlushTrailItems();
  const roundId = params.get('round');
  const profile = useFetch<{ candidate: CandidateProfile }>(id ? `${INTERVIEWS_API}/candidates/${encodeURIComponent(id)}` : null);
  const people = useFetch<ItemsResponse<PersonRef>>(`${INTERVIEWS_API}/interviewers`);
  const record = profile.data?.candidate;
  useCrumbLabel(id, record?.candidate.name);

  const round = roundId ? record?.applications.flatMap((a) => a.interviews).find((r) => r.id === roundId) ?? null : null;
  const app = record?.applications.find((a) => a.applicationId === (round?.applicationId ?? params.get('application'))) ?? record?.applications[0];
  const opening = useFetch<{ opening: OpeningRecord }>(app && !roundId ? `${INTERVIEWS_API}/openings/${encodeURIComponent(app.opening.id)}` : null);

  const [kitRound, setKitRound] = useState('');
  const [leadId, setLeadId] = useState(NOBODY);
  const [panel, setPanel] = useState<string[]>(Array(PANEL_SEATS).fill(NOBODY));
  const [problems, setProblems] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // A reassignment starts from the round's seats as they are.
  useEffect(() => {
    if (!round) return;
    const seats = seatsOfRow(round);
    setLeadId(round.state === 'declined' ? NOBODY : seats.leadId);
    setPanel(seats.panel);
  }, [round?.id, round?.revision]); // eslint-disable-line react-hooks/exhaustive-deps

  const back = () => navigate(candidateHref(id));
  const title = roundId ? 'Reassign a round' : 'Assign a round';
  const trail = base ? [...base.slice(0, -1), { label: record?.candidate.name ?? 'Candidate', href: candidateHref(id) }, { label: title }] : undefined;

  if (profile.error && !record) {
    return /404|not found/i.test(profile.error)
      ? <RecordNotFound heading="Candidate" title="Candidate not found" body="There is no candidate here that you can open." backLabel="Candidates" onBack={() => navigate('/interviews/candidates')} />
      : <UnavailableNotice error={profile.error} what="this candidate" source="Candidates are read from the interviews tenant's applications" onRetry={profile.refresh} />;
  }
  if (!record || !app) return <LoadingState label="Loading…" />;
  if (roundId && !round) {
    return <RecordNotFound heading="Round" title="Round not found" body="There is no round here that you can change." backLabel={record.candidate.name} onBack={back} />;
  }

  const interviewers = people.data?.items ?? [];
  const taken = new Set(app.interviews.filter((r) => r.state !== 'declined' && r.state !== 'cancelled').map((r) => r.round.id));
  const kitRounds = opening.data?.opening.rounds ?? [];
  const locked = round !== null && !canReassign(round.state);

  const submit = async () => {
    setSaving(true); setError(null); setProblems(new Map());
    const seats = seatingOf(leadId, panel);
    const out = round
      ? await reassignRound(round.id, round.revision, seats)
      : await assignRound({ applicationId: app.applicationId, roundId: kitRound, ...seats });
    setSaving(false);
    if (out.ok) { back(); return; }
    setError(out.error);
    setProblems(new Map(out.fields.map((f: FieldProblem) => [f.path === 'panelIds' ? 'panelIds.0' : f.path, f.message])));
    if (out.stale) void profile.refresh();
  };

  const personOptions = (list: readonly PersonRef[], empty: string) => [{ value: NOBODY, label: empty }, ...list.map((p) => ({ value: p.id, label: p.name }))];

  return (
    <Stack gap="none" className="h-full min-h-0 min-w-0" data-shell-flush>
      <PageFrame title={title} breadcrumbs={trail} column="centered" columnWidth="4xl" data-testid="interviews-assign-page"
        description={round
          ? `${round.round.name} for ${record.candidate.name}, ${app.opening.title}. A new lead is asked to accept again; seats that stay keep their answer.`
          : `A round of ${app.opening.title} for ${record.candidate.name}. Each person you seat is asked to accept it. You set the time later.`}
        actions={(
          <Inline gap="xs" wrap={false}>
            <Button size="sm" variant="ghost" onClick={back} data-testid="interviews-assign-cancel">Cancel</Button>
            <Button size="sm" variant="primary" disabled={saving || locked || !leadId || (!round && !kitRound)} onClick={() => { void submit(); }}
              data-testid="interviews-assign-submit">{round ? 'Reassign' : 'Assign'}</Button>
          </Inline>
        )}>
        <Stack gap="md" data-testid="interviews-assign-form">
          {error && <T size="sm" tone="danger" data-testid="interviews-assign-error">{error}</T>}
          {locked && <T size="sm" tone="secondary">This round has already started, so who sits on it can no longer change.</T>}
          {round && round.declines.length > 0 && (
            <Stack gap="xs" data-testid="interviews-assign-declines">
              {declineLines(round).map((line) => <T key={line} size="sm" tone="secondary">{line}</T>)}
            </Stack>
          )}
          <Inline gap="sm" align="start">
            {round ? (
              <FormField label="Round" className="min-w-[16rem] flex-1">
                {() => <T size="sm">{`${round.round.name}, ${ROUND_TYPE_LABELS[round.round.type].toLowerCase()}, ${round.round.minutes} minutes · ${whenLabel(round.scheduledAt)}`}</T>}
              </FormField>
            ) : (
              <FormField label="Round" required error={problems.get('roundId') ?? problems.get('applicationId')} className="min-w-[16rem] flex-1"
                hint="One of this opening's rounds that the candidate does not have yet.">
                {(w) => <Select {...w} size="sm" value={kitRound} data-testid="interviews-assign-round"
                  options={[{ value: '', label: 'Choose a round' }, ...kitRounds.map((r) => ({
                    value: r.id, label: `${r.name}, ${r.minutes} minutes${taken.has(r.id) ? ' (already assigned)' : ''}`, disabled: taken.has(r.id),
                  }))]}
                  onChange={(e) => setKitRound(e.target.value)} />}
              </FormField>
            )}
            <FormField label="Lead" required error={problems.get('leadId')} className="min-w-[16rem] flex-1" hint="Runs the interview and gets Milo's prompts.">
              {(w) => <Select {...w} size="sm" value={leadId} data-testid="interviews-assign-lead"
                options={personOptions(interviewers, 'Choose who leads')}
                onChange={(e) => { const v = e.target.value; setLeadId(v); setPanel((p) => p.map((x) => (x === v ? NOBODY : x))); }} />}
            </FormField>
          </Inline>
          <Inline gap="sm" align="start">
            {panel.map((seat, i) => (
              <FormField key={i} label={`Panel seat ${i + 1}`} error={problems.get(`panelIds.${i}`)} className="min-w-[16rem] flex-1"
                hint={i === 0 ? 'Optional. Panel members join the call and write their own scorecard.' : 'Optional.'}>
                {(w) => <Select {...w} size="sm" value={seat} data-testid={`interviews-assign-panel-${i}`}
                  options={personOptions(panelChoices(interviewers, leadId, panel[1 - i] ?? NOBODY), 'Nobody')}
                  onChange={(e) => setPanel((p) => p.map((x, j) => (j === i ? e.target.value : x)))} />}
              </FormField>
            ))}
          </Inline>
        </Stack>
      </PageFrame>
    </Stack>
  );
}
