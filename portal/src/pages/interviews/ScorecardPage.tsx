// /interviews/rounds/:id/scorecard — one interviewer's scorecard for one round (docs/interviews-tenant-plan.md row
// I5.3; contract D8). Each competency with what to look for, a rating against the kit's anchors and a note; then the
// recommendation and the summary. Submit is asked once, in the prompt deck, because a submitted scorecard cannot be
// edited; "Correct it" asks why, then opens the same form as a new version. The others' scorecards on the candidate
// show only once the viewer's own is in (the server decides: middleware lib/interviews/scope.ts othersRevealed). The
// recruiter and the hiring manager read the submissions here and submit nothing.
//
// What is typed before Submit is kept in this browser only, per interview, and cleared on submit
// (lib/interviewsScorecard.ts loadDraft / saveDraft / clearDraft).
//
// RECAP STEP (row I5.2, round 5): Milo's recap is opened between the ratings and the recommendation, in the form
// below at the line marked RECAP STEP; nothing is drawn for it this round.

import { RatingInput } from '@connorhoehn/ui-components';
import {
  Button, Chip, DetailPage, DetailSection, EmptyState, FormField, Inline, MetaLine, RadioGroup, Stack, T, Textarea,
} from '@connorhoehn/ui-components/shared';
import { ComposerPromptDeck, type ComposerPrompt } from '@connorhoehn/ui-components/social/rich-composer';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useFlushTrailItems } from '../../components/shell/FlushPage';
import { RecordNotFound, UnavailableNotice } from '../../components/UnavailableNotice';
import { useFetch } from '../../hooks/useFetch';
import { useCrumbLabel } from '../../lib/crumbLabels';
import { INTERVIEWS_API, RECOMMENDATION_LABELS, ROUND_TYPE_LABELS, recommendationTone, roundStatus, type Recommendation } from '../../lib/interviews';
import type { KitCompetency } from '../../lib/interviewsKit';
import {
  RECOMMENDATION_CHOICES, bodyOf, clearDraft, draftFrom, emptyDraft, loadDraft, missingFrom, othersLine, saveDraft, scaleOf, submitScorecard,
  type Draft, type Rating, type ScorecardPageView, type ScorecardVersion,
} from '../../lib/interviewsScorecard';

type Trail = ReturnType<typeof useFlushTrailItems>;

export default function ScorecardPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const base = useFlushTrailItems();
  const { data, error, failure, refresh } = useFetch<{ scorecard: ScorecardPageView }>(id ? `${INTERVIEWS_API}/interviews/${encodeURIComponent(id)}/scorecard` : null);
  const view = data?.scorecard ?? null;
  useCrumbLabel(id, view ? `${view.interview.candidate.name}, ${view.interview.round.name}` : null);
  if (failure?.status === 404) {
    return <RecordNotFound heading="Scorecard" title="Scorecard not found" body="There is no interview here that you can open." backLabel="Home" onBack={() => navigate('/interviews')} />;
  }
  if (error && !view) return <UnavailableNotice error={error} what="this scorecard" source="Scorecards are read from the interviews tenant" onRetry={refresh} />;
  if (!view) return <DetailPage title="Scorecard" breadcrumbs={base}><T size="sm" tone="tertiary">Loading the scorecard…</T></DetailPage>;
  return <ScorecardWorkspace key={`${view.interview.id}:${view.mine?.version ?? 0}`} view={view} trail={base} onChanged={refresh} />;
}

function ScorecardWorkspace({ view, trail, onChanged }: { view: ScorecardPageView; trail: Trail; onChanged: () => void }) {
  const { interview, competencies, mine, limits } = view;
  const basedOn = mine?.version ?? 0;
  const seated = interview.seat !== null;
  // A first version opens the form at once; a submitted one opens read-only until "Correct it".
  const [correcting, setCorrecting] = useState(false);
  const editing = view.canSubmit && (mine === null || correcting);
  const [draft, setDraft] = useState<Draft>(() => loadDraft(interview.id, basedOn) ?? (mine ? draftFrom(mine) : emptyDraft()));
  const [asking, setAsking] = useState<'submit' | 'reason' | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => { if (editing) saveDraft(interview.id, basedOn, draft); }, [editing, interview.id, basedOn, draft]);
  // A draft saved while correcting reopens the correction.
  useEffect(() => { if (mine && view.canSubmit && loadDraft(interview.id, basedOn)?.reason) setCorrecting(true); }, [mine, view.canSubmit, interview.id, basedOn]);

  const missing = missingFrom(draft, competencies, limits, basedOn > 0);
  const status = roundStatus(interview.state);

  const prompts = useMemo<ComposerPrompt[]>(() => {
    const scope = `interviews-scorecard:${interview.id}`;
    if (asking === 'reason') {
      return [{
        id: `${scope}:reason:${basedOn}`, scope, eyebrow: 'Correct your scorecard', title: `${interview.candidate.name}, ${interview.round.name}`, kind: 'text',
        question: 'Why are you correcting it? Your reason is kept with the new version, and the version you submitted stays readable.',
        placeholder: 'Your reason, in a sentence',
        onAnswer: async (a) => {
          const reason = a.kind === 'text' ? a.text.trim() : '';
          if (!reason) return { error: 'Say why in a sentence.' };
          if (reason.length > limits.reasonChars) return { error: `Keep the reason under ${limits.reasonChars} characters.` };
          setDraft((d) => ({ ...(d.reason ? d : draftFrom(mine!)), reason }));
          setCorrecting(true);
          setAsking(null);
          return { receipt: 'Correcting' };
        },
      }];
    }
    if (asking === 'submit') {
      return [{
        id: `${scope}:submit:${basedOn}`, scope, eyebrow: basedOn > 0 ? 'Submit the correction' : 'Submit your scorecard', title: `${interview.candidate.name}, ${interview.round.name}`,
        kind: 'choice', fields: [{ label: 'Recommendation', value: draft.recommendation ? RECOMMENDATION_LABELS[draft.recommendation] : '—' }],
        question: basedOn > 0
          ? 'Submit this as a new version? It cannot be edited afterwards; your earlier version stays readable.'
          : 'Submit your scorecard? It cannot be edited afterwards. A later correction is a new version with a reason.',
        options: [{ id: 'submit', label: 'Submit', emphasis: 'primary' }, { id: 'keep', label: 'Keep editing' }],
        onAnswer: async (a) => {
          if (!('optionId' in a) || a.optionId !== 'submit') { setAsking(null); return { receipt: 'Still editing' }; }
          const out = await submitScorecard(interview.id, bodyOf(draft, competencies, basedOn));
          if (!out.ok) {
            setProblem(out.error);
            setAsking(null);
            if (out.stale) onChanged();
            return { error: out.error };
          }
          clearDraft(interview.id, basedOn);
          setAsking(null);
          onChanged();
          return { receipt: 'Submitted' };
        },
      }];
    }
    return [];
  }, [asking, basedOn, competencies, draft, interview, limits.reasonChars, mine, onChanged]);

  const setRating = (cid: string, v: number | null) => setDraft((d) => ({ ...d, ratings: { ...d.ratings, [cid]: (v as Rating | null) } }));
  const setNote = (cid: string, v: string) => setDraft((d) => ({ ...d, notes: { ...d.notes, [cid]: v } }));

  const form = (
    <Stack gap="md" data-testid="interviews-scorecard-form">
      {draft.reason && basedOn > 0 && <T size="sm" tone="secondary" data-testid="interviews-scorecard-reason">{`Correcting version ${basedOn}. Your reason: ${draft.reason}`}</T>}
      {competencies.map((c) => (
        <DetailSection key={c.id} variant="heading" title={c.name} hint={c.lookFor}>
          <Stack gap="sm">
            <RatingInput label={`Your rating for ${c.name}`} required value={draft.ratings[c.id] ?? null} onChange={(v) => setRating(c.id, v)} options={scaleOf(c)}
              data-testid="interviews-scorecard-rating" />
            <FormField label={`Note on ${c.name}`} hint="Optional: what you saw or heard that supports the rating.">
              {({ labelId: _labelId, ...wiring }) => (
                <Textarea {...wiring} minRows={2} autoResize value={draft.notes[c.id] ?? ''} maxLength={limits.noteChars}
                  onChange={(e) => setNote(c.id, e.target.value)} data-testid="interviews-scorecard-note" />
              )}
            </FormField>
          </Stack>
        </DetailSection>
      ))}
      {/* RECAP STEP (row I5.2, round 5): Milo's recap opens here, between the ratings and the recommendation. */}
      <DetailSection variant="heading" title="Your recommendation" hint="Your own judgement of this round.">
        <Stack gap="sm">
          <RadioGroup<Recommendation | ''> name={`recommendation-${interview.id}`} orientation="horizontal" value={draft.recommendation ?? ''}
            onChange={(v) => setDraft((d) => ({ ...d, recommendation: v || null }))} options={[...RECOMMENDATION_CHOICES]} data-testid="interviews-scorecard-recommendation" />
          <FormField label="Summary" required hint="A few sentences another interviewer could read on their own.">
            {({ labelId: _labelId, ...wiring }) => (
              <Textarea {...wiring} minRows={3} autoResize value={draft.summary} maxLength={limits.summaryChars}
                onChange={(e) => setDraft((d) => ({ ...d, summary: e.target.value }))} data-testid="interviews-scorecard-summary" />
            )}
          </FormField>
        </Stack>
      </DetailSection>
      <Stack gap="sm">
        {missing.length > 0 && <T size="sm" tone="secondary" data-testid="interviews-scorecard-missing">{missing.join(' ')}</T>}
        {problem && <T size="sm" tone="danger" role="alert" data-testid="interviews-scorecard-problem">{problem}</T>}
        <T size="xs" tone="tertiary">What you type here is kept in this browser only until you submit.</T>
        <ComposerPromptDeck prompts={prompts} scope={`interviews-scorecard:${interview.id}`} data-testid="interviews-scorecard-ask" />
        <Inline gap="sm">
          <Button size="sm" variant="primary" disabled={missing.length > 0 || asking !== null} data-testid="interviews-scorecard-submit"
            onClick={() => { setProblem(null); setAsking('submit'); }}>{basedOn > 0 ? 'Submit the correction' : 'Submit'}</Button>
          {correcting && (
            <Button size="sm" variant="ghost" data-testid="interviews-scorecard-cancel-correction"
              onClick={() => { clearDraft(interview.id, basedOn); setDraft(draftFrom(mine!)); setCorrecting(false); setAsking(null); }}>Stop correcting</Button>
          )}
        </Inline>
      </Stack>
    </Stack>
  );

  const mineTab = editing ? form : mine ? (
    <Stack gap="md">
      <ComposerPromptDeck prompts={prompts} scope={`interviews-scorecard:${interview.id}`} data-testid="interviews-scorecard-ask" />
      <ScorecardReadout card={mine} competencies={competencies} testId="interviews-scorecard-mine" />
    </Stack>
  ) : (
    <EmptyState title="No scorecard yet" description={view.refusal ?? 'You have not submitted a scorecard for this round.'} />
  );

  const othersNote = othersLine(view);
  const othersTab = (
    <Stack gap="md" data-testid="interviews-scorecard-others">
      {othersNote && <T size="sm" tone="secondary" data-testid="interviews-scorecard-others-line">{othersNote}</T>}
      {view.others.map((s) => (
        <Stack key={s.id} gap="sm">
          <ScorecardReadout card={s} competencies={competencies} round={s.round} testId="interviews-scorecard-other" />
          {s.earlier.length > 0 && <Versions versions={s.earlier} competencies={competencies} />}
        </Stack>
      ))}
    </Stack>
  );

  const tabs = seated
    ? [
      { id: 'mine', label: 'Your scorecard', testId: 'interviews-scorecard-tab-mine', content: mineTab },
      ...(mine && mine.earlier.length ? [{ id: 'versions', label: 'Earlier versions', badge: mine.earlier.length, testId: 'interviews-scorecard-tab-versions', content: <Versions versions={mine.earlier} competencies={competencies} /> }] : []),
      { id: 'others', label: 'Other scorecards', badge: view.others.length || undefined, testId: 'interviews-scorecard-tab-others', content: othersTab },
    ]
    : [{ id: 'others', label: 'Scorecards', badge: view.others.length || undefined, testId: 'interviews-scorecard-tab-others', content: othersTab }];

  return (
    <DetailPage data-testid="interviews-scorecard" title={`${interview.candidate.name}, ${interview.round.name}`} breadcrumbs={trail}
      badge={<Chip tone={status.tone} size="xs" data-testid="interviews-scorecard-state">{status.label}</Chip>}
      meta={<MetaLine size="sm" items={[
        interview.opening.title, `${ROUND_TYPE_LABELS[interview.round.type]}, ${interview.round.minutes} minutes`,
        mine ? `Your scorecard is in (version ${mine.version})` : seated ? (view.refusal ?? 'Your scorecard is due') : 'You read the submissions here',
      ]} />}
      actions={mine && view.canSubmit && !correcting
        ? <Button size="sm" variant="secondary" disabled={asking !== null} data-testid="interviews-scorecard-correct" onClick={() => setAsking('reason')}>Correct it</Button>
        : undefined}
      tabs={tabs} />
  );
}

/** One submitted scorecard, read-only: each competency's rating against its anchors and the note, then the decision. */
function ScorecardReadout({ card, competencies, round, testId }: { card: ScorecardVersion; competencies: readonly KitCompetency[]; round?: string; testId: string }) {
  const kit = new Map(competencies.map((c) => [c.id, c]));
  const when = new Date(card.submittedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  return (
    <DetailSection variant="heading" title={round ? `${card.interviewer.name}, ${round}` : card.interviewer.name} data-testid={testId}
      hint={<MetaLine size="sm" items={[`Version ${card.version}`, `Submitted ${when}`, ...(card.correctionReason ? [`Corrected: ${card.correctionReason}`] : [])]} />}
      actions={<Chip tone={recommendationTone(card.recommendation)} size="xs">{RECOMMENDATION_LABELS[card.recommendation]}</Chip>}>
      <Stack gap="sm">
        {card.ratings.map((r) => {
          const c = kit.get(r.competencyId);
          return (
            <Stack key={r.competencyId} gap="xs">
              <RatingInput label={r.competency} readOnly value={r.rating} onChange={() => undefined}
                options={c ? scaleOf(c) : ([1, 2, 3, 4] as const).map((n) => ({ value: n, label: `${n} of 4` }))} />
              {r.note && <T size="sm" tone="secondary">{r.note}</T>}
            </Stack>
          );
        })}
        <T size="sm">{card.summary}</T>
      </Stack>
    </DetailSection>
  );
}

function Versions({ versions, competencies }: { versions: readonly ScorecardVersion[]; competencies: readonly KitCompetency[] }) {
  return (
    <Stack gap="md" data-testid="interviews-scorecard-versions">
      {[...versions].reverse().map((v) => <ScorecardReadout key={v.id} card={v} competencies={competencies} testId="interviews-scorecard-version" />)}
    </Stack>
  );
}

