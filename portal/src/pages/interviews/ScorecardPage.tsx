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
// Milo's recap (row I5.2, decision 14) sits between the ratings and the recommendation: "Continue to the recap" asks once,
// in the prompt deck, that the ratings will be recorded as they stand, then shows each competency's own rating beside
// Milo's evidence (each statement with the transcript line it quotes); "Back to my ratings" may change them, which the
// scorecard then records as changed after the recap (the server's fact). The recruiter and the hiring manager read the
// recap read-only under the scorecards. Milo's evidence carries no rating, tone or colour.

import { RatingInput } from '@connorhoehn/ui-components';
import {
  Button, ChatComposer, Chip, DetailPage, DetailSection, Disclosure, EmptyState, FormField, Inline, KeyValue, MetaLine, RadioGroup, Stack, T, Textarea, WorkflowStepper,
} from '@connorhoehn/ui-components/shared';
import { ComposerPromptDeck, type ComposerPrompt } from '@connorhoehn/ui-components/social/rich-composer';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { FlushDetailFrame, useFlushTrailItems } from '../../components/shell/FlushPage';
import { RecordNotFound, UnavailableNotice } from '../../components/UnavailableNotice';
import { useFetch } from '../../hooks/useFetch';
import { useCrumbLabel } from '../../lib/crumbLabels';
import { INTERVIEWS_API, RECOMMENDATION_LABELS, ROUND_TYPE_LABELS, recommendationTone, roundStatus, type Recommendation } from '../../lib/interviews';
import { MILO_QUESTION_MAX, keepExchange, type MiloExchange } from '../../lib/interviewsRoom';
import type { KitCompetency } from '../../lib/interviewsKit';
import {
  RECOMMENDATION_CHOICES, allRated, askFromRecap, bodyOf, clearDraft, draftFrom, emptyDraft, evidenceFor, loadDraft, missingFrom, nextStep, openBodyOf, openRecap,
  SCORECARD_STEP_LABELS, SCORECARD_STEPS, othersLine, previousStep, recommendationVerdict, recapStateLine, recapUrl, saveDraft, scaleOf, submitScorecard,
  type Draft, type Rating, type RecapBody, type ScorecardPageView, type ScorecardStep, type ScorecardVersion,
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
  if (!view) return <FlushDetailFrame><DetailPage title="Scorecard" breadcrumbs={base}><T size="sm" tone="tertiary">Loading the scorecard…</T></DetailPage></FlushDetailFrame>;
  return <FlushDetailFrame><ScorecardWorkspace key={`${view.interview.id}:${view.mine?.version ?? 0}`} view={view} trail={base} onChanged={refresh} /></FlushDetailFrame>;
}

function ScorecardWorkspace({ view, trail, onChanged }: { view: ScorecardPageView; trail: Trail; onChanged: () => void }) {
  const { interview, competencies, mine, limits } = view;
  const basedOn = mine?.version ?? 0;
  const seated = interview.seat !== null;
  // A first version opens the form at once; a submitted one opens read-only until "Correct it".
  const [correcting, setCorrecting] = useState(false);
  const editing = view.canSubmit && (mine === null || correcting);
  const [draft, setDraft] = useState<Draft>(() => loadDraft(interview.id, basedOn) ?? (mine ? draftFrom(mine) : emptyDraft()));
  const [asking, setAsking] = useState<'submit' | 'reason' | 'recap' | null>(null);
  // What the open answered; after a reload the recap step reads it again (GET), since the open is already stored.
  const [recap, setRecap] = useState<RecapBody | null>(null);
  const goTo = (step: ScorecardStep) => setDraft((d) => ({ ...d, step }));
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
    if (asking === 'recap') {
      return [{
        id: `${scope}:recap:${basedOn}`, scope, eyebrow: 'Milo\'s recap', title: `${interview.candidate.name}, ${interview.round.name}`, kind: 'choice',
        question: basedOn > 0
          ? 'If this is the first time you open Milo\'s recap for this round, your ratings will be recorded as they stand before it is shown. A rating you change afterwards shows on the scorecard as changed after the recap.'
          : 'Your ratings will be recorded as they stand before Milo\'s recap is shown. You can still change them afterwards; the scorecard will show that they changed after the recap.',
        options: [{ id: 'open', label: 'Continue to the recap', emphasis: 'primary' }, { id: 'keep', label: 'Keep rating' }],
        onAnswer: async (a) => {
          if (!('optionId' in a) || a.optionId !== 'open') { setAsking(null); return { receipt: 'Still rating' }; }
          const out = await openRecap(interview.id, openBodyOf(draft, competencies));
          setAsking(null);
          if (!out.ok) { setProblem(out.error); return { error: out.error }; }
          setRecap(out.recap);
          setDraft((d) => ({ ...d, recapOpened: true, step: 'recap' }));
          return { receipt: 'Ratings recorded' };
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

  const rated = allRated(draft, competencies);
  const deck = <ComposerPromptDeck prompts={prompts} scope={`interviews-scorecard:${interview.id}`} data-testid="interviews-scorecard-ask" />;
  const correctingLine = draft.reason && basedOn > 0
    ? <T size="sm" tone="secondary" data-testid="interviews-scorecard-reason">{`Correcting version ${basedOn}. Your reason: ${draft.reason}`}</T> : null;
  const problemLine = problem ? <T size="sm" tone="danger" role="alert" data-testid="interviews-scorecard-problem">{problem}</T> : null;

  const rateStep = (
    <Stack gap="md" data-testid="interviews-scorecard-form">
      {correctingLine}
      <T size="sm" tone="secondary">Rate each competency from your own judgement first. Milo&apos;s recap comes next, then your recommendation.</T>
      {competencies.map((c) => (
        <DetailSection key={c.id} variant="heading" as="h2" title={c.name} hint={c.lookFor}>
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
      <Stack gap="sm">
        {!rated && <T size="sm" tone="secondary" data-testid="interviews-scorecard-missing">{missing[0]}</T>}
        {problemLine}
        <T size="xs" tone="tertiary">What you type here is kept in this browser only until you submit.</T>
        {deck}
        <Inline gap="sm">
          <Button size="sm" variant="primary" disabled={!rated || asking !== null} data-testid="interviews-scorecard-to-recap"
            onClick={() => { setProblem(null); if (draft.recapOpened) goTo('recap'); else setAsking('recap'); }}>Continue to the recap</Button>
          {correcting && (
            <Button size="sm" variant="ghost" data-testid="interviews-scorecard-cancel-correction"
              onClick={() => { clearDraft(interview.id, basedOn); setDraft(draftFrom(mine!)); setCorrecting(false); setAsking(null); }}>Stop correcting</Button>
          )}
        </Inline>
      </Stack>
    </Stack>
  );

  const recapStep = (
    <Stack gap="md" data-testid="interviews-scorecard-recap-step">
      {correctingLine}
      <RecapView interviewId={interview.id} competencies={competencies} initial={recap} ratings={draft.ratings} />
      <AskFromRecap interviewId={interview.id} />
      <Inline gap="sm">
        <Button size="sm" variant="secondary" data-testid="interviews-scorecard-back-to-ratings" onClick={() => goTo(previousStep('recap'))}>Back to my ratings</Button>
        <Button size="sm" variant="primary" data-testid="interviews-scorecard-to-decide" onClick={() => goTo(nextStep('recap'))}>Continue</Button>
      </Inline>
    </Stack>
  );

  const decideStep = (
    <Stack gap="md" data-testid="interviews-scorecard-decide-step">
      {correctingLine}
      <DetailSection variant="heading" as="h2" title="Your recommendation" hint="Your own judgement of this round.">
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
        {problemLine}
        <T size="xs" tone="tertiary">What you type here is kept in this browser only until you submit.</T>
        {deck}
        <Inline gap="sm">
          <Button size="sm" variant="primary" disabled={missing.length > 0 || asking !== null} data-testid="interviews-scorecard-submit"
            onClick={() => { setProblem(null); setAsking('submit'); }}>{basedOn > 0 ? 'Submit the correction' : 'Submit'}</Button>
          <Button size="sm" variant="ghost" data-testid="interviews-scorecard-back-to-recap" onClick={() => goTo(previousStep('decide'))}>Back to the recap</Button>
          {correcting && (
            <Button size="sm" variant="ghost" data-testid="interviews-scorecard-cancel-correction"
              onClick={() => { clearDraft(interview.id, basedOn); setDraft(draftFrom(mine!)); setCorrecting(false); setAsking(null); }}>Stop correcting</Button>
          )}
        </Inline>
      </Stack>
    </Stack>
  );

  const form = draft.step === 'recap' ? recapStep : draft.step === 'decide' ? decideStep : rateStep;

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
      {!seated && interview.endedAt !== null && <RecapView interviewId={interview.id} competencies={competencies} initial={null} ratings={null} />}
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
      badge={<Chip tone={status.tone} size="sm" data-testid="interviews-scorecard-state">{status.label}</Chip>}
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

/** One submitted scorecard, read-only: the three steps it went through, then each competency's rating (1 to 4) beside its anchor sentence and note, the summary and the decision in words. */
function ScorecardReadout({ card, competencies, round, testId }: { card: ScorecardVersion; competencies: readonly KitCompetency[]; round?: string; testId: string }) {
  const kit = new Map(competencies.map((c) => [c.id, c]));
  const when = new Date(card.submittedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  return (
    <DetailSection variant="heading" as="h2" title={round ? `${card.interviewer.name}, ${round}` : card.interviewer.name} data-testid={testId}
      hint={<MetaLine size="sm" items={[`Version ${card.version}`, `Submitted ${when}`, ...(card.correctionReason ? [`Corrected: ${card.correctionReason}`] : [])]} />}>
      <Stack gap="md">
        <Inline gap="lg" align="center" wrap>
          <WorkflowStepper aria-label="The steps of a scorecard" data-testid="interviews-scorecard-steps"
            steps={SCORECARD_STEPS.map((id, i) => ({ step: i + 1, label: SCORECARD_STEP_LABELS[id], done: true, active: false }))} />
          <Chip tone={recommendationTone(card.recommendation)} size="sm" data-testid="interviews-scorecard-verdict">{recommendationVerdict(card.recommendation)}</Chip>
        </Inline>
        {card.ratings.map((r) => {
          const c = kit.get(r.competencyId);
          return (
            <Stack key={r.competencyId} gap="xs">
              <Inline gap="md" align="end" wrap={false}>
                <RatingInput label={r.competency} readOnly value={r.rating} onChange={() => undefined}
                  options={([1, 2, 3, 4] as const).map((n) => ({ value: n, label: `${n} of 4` }))} />
                {c && <T size="sm" tone="secondary" data-testid="interviews-scorecard-anchor">{c.anchors[r.rating]}</T>}
              </Inline>
              {r.note && <T size="sm">{r.note}</T>}
            </Stack>
          );
        })}
        <T size="sm" data-testid="interviews-scorecard-summary">{card.summary}</T>
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


/**
 * Milo's recap, per competency in the kit's order: the viewer's own rating (in the scorecard's recap step) beside Milo's
 * evidence, each statement with the transcript line it quotes, or "Nothing was said about this". Read-only for the
 * recruiter and the hiring manager (no ratings). No rating, tone or colour is ever attached to Milo's evidence.
 */
function RecapView({ interviewId, competencies, initial, ratings }: {
  interviewId: string; competencies: readonly KitCompetency[]; initial: RecapBody | null; ratings: Draft['ratings'] | null;
}) {
  const { data, error, failure } = useFetch<{ recap: RecapBody }>(initial ? null : recapUrl(interviewId));
  const recap = initial ?? data?.recap ?? null;
  const readers = ratings === null;
  // A reader who may not read it (the round has not ended) gets nothing drawn.
  if (failure?.status === 404) return null;
  const body = (() => {
    if (error && !recap) return <T size="sm" tone="secondary">Milo&apos;s recap could not be loaded. Reload the page to try again.</T>;
    if (!recap) return <T size="sm" tone="tertiary">Loading Milo&apos;s recap…</T>;
    const line = recapStateLine(recap, readers);
    if (line) return <T size="sm" tone="secondary" data-testid="interviews-recap-state">{line}</T>;
    return (
      <Stack gap="md">
        {competencies.map((c) => {
          const evidence = evidenceFor(recap, c.id);
          const mine = ratings?.[c.id] ?? null;
          return (
            <DetailSection key={c.id} variant="heading" title={c.name} data-testid="interviews-recap-competency">
              <KeyValue items={[
                ...(readers ? [] : [{ label: 'Your rating', value: mine ? `${mine} of 4: ${c.anchors[mine]}` : 'Not rated', muted: !mine }]),
                {
                  label: 'Milo\'s evidence',
                  muted: evidence.length === 0,
                  value: evidence.length === 0 ? 'Nothing was said about this' : (
                    <Stack gap="xs">
                      {evidence.map((e) => (
                        <Disclosure key={`${e.source.seq}:${e.text}`} variant="plain" summary={<T size="sm">{e.text}</T>} data-testid="interviews-recap-claim">
                          <T size="sm" tone="secondary">{`Line ${e.source.seq} of the transcript: “${e.source.quote}”`}</T>
                        </Disclosure>
                      ))}
                    </Stack>
                  ),
                },
              ]} />
            </DetailSection>
          );
        })}
      </Stack>
    );
  })();
  return (
    <DetailSection variant="heading" title="Milo's recap" data-testid="interviews-recap"
      hint="What the candidate said about each competency, each with the line of the transcript it comes from. Milo does not rate or recommend.">
      {body}
    </DetailSection>
  );
}


/** Under the recap, for a seat that has opened it: ask Milo where something was said. Private to the asker; the exchanges last this visit. */
function AskFromRecap({ interviewId }: { interviewId: string }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [kept, setKept] = useState<MiloExchange[]>([]);
  const asked = useRef(0);
  const send = useCallback(async () => {
    const question = value.replace(/\s+/g, ' ').trim();
    if (!question || busy) return;
    setBusy(true);
    setError(null);
    const out = await askFromRecap(interviewId, question.slice(0, MILO_QUESTION_MAX));
    setBusy(false);
    if (!out.ok) { setError(out.error); return; }
    setValue('');
    setKept((k) => keepExchange(k, question, out.body, `recap-ask-${++asked.current}`));
  }, [value, busy, interviewId]);
  const [latest, ...earlier] = kept;
  return (
    <DetailSection variant="heading" title="Ask Milo where something was said" data-testid="interviews-recap-ask"
      hint="Only you see this. Milo finds what was said, and where; it does not judge the candidate.">
      <Stack gap="sm">
        <ChatComposer value={value} onChange={(v) => setValue(v.slice(0, MILO_QUESTION_MAX))} onSubmit={() => { void send(); }} disabled={busy}
          placeholder="Where did they talk about testing?" submitLabel="Ask" aria-label="Your question for Milo" />
        {busy && <T size="xs" tone="tertiary">Milo is looking…</T>}
        {error && <T size="xs" tone="danger" role="alert" wrap>{error}</T>}
        {latest && <RecapExchangeView exchange={latest} />}
        {earlier.length > 0 && (
          <Disclosure density="compact" summary={<T size="xs" tone="secondary">{`Earlier questions (${earlier.length})`}</T>}>
            <Stack gap="md">{earlier.map((x) => <RecapExchangeView key={x.key} exchange={x} />)}</Stack>
          </Disclosure>
        )}
      </Stack>
    </DetailSection>
  );
}

function RecapExchangeView({ exchange }: { exchange: MiloExchange }) {
  return (
    <Stack gap="xs" data-testid="interviews-recap-ask-answer">
      <T size="xs" tone="tertiary" wrap>{exchange.question}</T>
      {exchange.answer ? (
        <>
          <T size="sm" wrap>{exchange.answer.text}</T>
          {exchange.answer.sources.length > 0 && (
            <Stack as="ul" gap="xs">
              {exchange.answer.sources.map((s) => <T as="li" key={s.seq} size="xs" tone="secondary" wrap>{`Line ${s.seq}${s.speaker ? `, ${s.speaker}` : ''}${s.at ? ` at ${new Date(s.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}: “${s.quote}”`}</T>)}
            </Stack>
          )}
        </>
      ) : <T size="sm" tone="secondary" wrap>{exchange.line ?? ''}</T>}
    </Stack>
  );
}
