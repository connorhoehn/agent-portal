// The centrepiece: the 17-dimension rail paired with a tabbed detail pane for
// whichever dimension is selected, on the library `ExplorerLayout` — the rail
// flush at the frame's left edge (300px, `md`, with wrapped rubric names),
// its rows the library `GroupedList` grouped by where each dimension stands
// (claims to verify, verified, not yet assessed, not applicable), which owns
// the rows' focus, ArrowUp/Down/Home/End movement and Enter/Space activation.
// No search box: 17 rows do not need one (the user, 2026-10-07). "Open
// claims" is the rail's own control, in its header row. The docked composer
// is the pane's footer, so Chat | Agent stays put while the detail scrolls.
// Reproduces the source's DimensionMasterDetail.tsx.
//
// The detail-pane header has no matching library composite (see
// DimensionDetailHeader.tsx and docs/ui-components-queue.md) — everything
// else here is composed from Stack/Inline/Card/DetailSection/Chip, per
// docs/assessment-goal.md "De-hand-roll every page".

import { useEffect, useMemo, useState } from 'react';
import { Link as RouterLink, useNavigate } from 'react-router';
import { ExplorerLayout } from '@connorhoehnslalom/ui-components';
import {
  Button,
  Card,
  InlineAlert,
  T,
  Chip,
  DetailSection,
  Inline,
  InlinePlaceholder,
  MetaLine,
  SectionLabel,
  Stack,
  Tabs,
  useRailFold,
  type TabItem,
} from '@connorhoehnslalom/ui-components/shared';
import { isOpenFollowUp } from '../assessmentFormat';
import { STANDARDS_FOLDER_ID, enterpriseDocPath, standardFor } from '../dimensionStandards';
import { useFetch } from '../../../hooks/useFetch';
import type { KnowledgeTreeResponse } from '../knowledge/types';
import {
  certificationBasisLine,
  certificationBasisMeaning,
  dimensionCertificationStatement,
  fmtDate,
  hasOpenClaim,
  type Dimension,
} from '../types';
import { DimensionRailControls, DimensionRailList } from './DimensionRail';
import { DimensionDetailHeader } from './DimensionDetailHeader';
import { LevelBadge } from './LevelBadge';
import { EvidenceDraftsPanel } from './EvidenceDraftsPanel';
import { usePageHuddleComposer } from '../../../components/shell/HuddleComposerDock';
import type { ConversationRuntime } from '../../../components/chat/ConversationThread';
import { ConversationComposer } from '../../../lib/conversationComposer';
import { useCallBlock, useCallHost } from '../../../lib/conversationCall';
import { createDeck } from '../decks/decksApi';
import { AGENT_COMMANDS, AGENT_HELP, composerAccess, dimensionPageReference, routeAgentText, teamDiscussionChannel } from './dimensionComposerModel';
import { useCapabilities } from '../../../lib/capabilities';
import { useSession } from '../../../lib/auth';
import { filterRailDimensions } from './scorecardHeaderModel';

const confidenceLabel = (confidence: string) => confidence.replace(/_/g, ' ');

// ─── Detail pane content ────────────────────────────────────────────────────

function CertificationStatement({ dimension }: { dimension: Dimension }) {
  const cert = dimension.certification;
  if (!cert) {
    return dimension.is_na ? (
      <Chip tone="neutral">Not applicable</Chip>
    ) : dimension.current_level !== null ? (
      <Chip>
        Currently L{dimension.current_level}
        {dimension.level_name ? ` · ${dimension.level_name}` : ''}
      </Chip>
    ) : (
      <Chip tone="neutral">Not yet assessed</Chip>
    );
  }
  const statement = dimensionCertificationStatement(cert);
  const basisLine = certificationBasisLine(cert.basis);
  const basisMeaning = certificationBasisMeaning(cert.basis);
  const claimOpen = hasOpenClaim(cert);
  const toVerifyHigher = cert.to_verify_higher
    ? `To confirm a higher level, we would need ${cert.to_verify_higher.replace(/^To verify higher:\s*/i, '').replace(/\.+$/, '')}.`
    : claimOpen
      ? 'To confirm the level the team claims, we would need evidence for it.'
      : null;

  return (
    <Stack gap="xs">
      <Inline gap="sm" align="center" wrap>
        <LevelBadge level={cert.verified_level} size="sm" />
        {statement && <strong className="text-sm font-semibold text-text-primary">{statement}</strong>}
      </Inline>
      {(basisLine || toVerifyHigher) && (
        <Stack gap="none" className="text-xs leading-relaxed text-text-secondary">
          {basisLine} {basisMeaning} {toVerifyHigher}
        </Stack>
      )}
    </Stack>
  );
}

/** "Measured against" — the enterprise standard this dimension's rubric
 *  encodes, named from the knowledge tree and linked into the explorer
 *  (docs/assessment-ux-goal.md slice 5). The tree is fetched once per
 *  pane mount; while it loads, or if the mapped document is missing from
 *  the tree, the link still goes to the folder so the reader lands
 *  somewhere true. */
function MeasuredAgainst({ dimension }: { dimension: Dimension }) {
  /**
   * "Add one" is only an offer if you can add one.
   *
   * Editing a doc under Enterprise › standards needs `ManageKnowledge`, which
   * the Cedar seeds permit to lead-assessor and program-lead — an `assessor`
   * does not hold it. This pane is mounted behind `ViewAssessment`, which all
   * three roles hold, so an assessor was being handed a live link promising an
   * action that the destination's own `canEdit`/`canPublish` then refuses.
   * The link stays, because an assessor CAN read the folder and that is worth
   * reaching; only the verb changes.
   */
  const { can, ready } = useCapabilities();
  const mayAdd = ready && can('ManageKnowledge');
  const standard = standardFor(dimension.id);
  const tree = useFetch<KnowledgeTreeResponse>('/api/assessment/knowledge/tree');
  const nodes = (tree.data?.sections ?? []).flatMap((s) => s.nodes);
  const doc = standard ? nodes.find((n) => n.id === standard.docId) ?? null : null;
  const testId = 'dimension-standard';

  if (!standard) {
    return (
      <Inline gap="xs" align="center" wrap data-testid={testId} data-standard="">
        <Chip tone="warning" size="xs">No enterprise standard on file</Chip>
        <MetaLine
          size="sm"
          items={[
            'This dimension is scored on the rubric alone.',
            <RouterLink key="folder" to={enterpriseDocPath(STANDARDS_FOLDER_ID)} className="text-primary hover:underline">
              {mayAdd ? 'Add one under Enterprise › standards →' : 'See Enterprise › standards →'}
            </RouterLink>,
          ]}
        />
      </Inline>
    );
  }
  return (
    <Inline gap="xs" align="center" wrap data-testid={testId} data-standard={standard.docId}>
      <Chip tone="accent" size="xs">Measured against</Chip>
      <MetaLine
        size="sm"
        items={[
          <RouterLink key="doc" to={enterpriseDocPath(standard.docId)} className="font-medium text-primary hover:underline">
            {doc?.title ?? standard.docId.replace(/^ec:/, '')}
          </RouterLink>,
          standard.clause,
          tree.data && !doc ? 'not in the enterprise tree — link opens the folder' : null,
        ]}
      />
    </Inline>
  );
}

type DraftCommand = { nonce: number; kind: 'summary' | 'followups' } | null;

function ProgressTab({ dimension, teamId, onChanged, command }: { dimension: Dimension; teamId: string; onChanged: () => void; command: DraftCommand }) {
  const openFollowUps = dimension.follow_up_questions.filter((q) => isOpenFollowUp(q.status));
  return (
    <Stack gap="lg">
      <DetailSection title="Criteria to level up" first>
        {!dimension.is_na && dimension.next_level_criteria.length > 0 ? (
          <Stack gap="xs" className="mt-2">
            {dimension.next_level_criteria.map((c, i) => (
              <Inline key={i} gap="xs" wrap={false} className="text-sm text-text-secondary">
                <strong className="text-accent">&bull;</strong>{c}
              </Inline>
            ))}
          </Stack>
        ) : (
          <InlinePlaceholder>
            {dimension.is_na ? 'Not applicable for this team.' : 'No level-up criteria recorded.'}
          </InlinePlaceholder>
        )}
      </DetailSection>

      <DetailSection title="Assistant drafts" hint="Nova drafts; nothing changes until you accept">
        <EvidenceDraftsPanel teamId={teamId} dimensionId={dimension.id} onChanged={onChanged} command={command} />
      </DetailSection>

      <DetailSection
        title="Follow-ups"
        hint={dimension.follow_up_questions.length > 0 ? `${openFollowUps.length} open` : undefined}
      >
        {dimension.follow_up_questions.length === 0 ? (
          <InlinePlaceholder>No follow-up questions.</InlinePlaceholder>
        ) : (
          <Stack gap="sm">
            {dimension.follow_up_questions.map((q) => (
              <Card key={q.question_id} padding="sm">
                <Inline justify="between" align="start" gap="sm">
                  {q.text}
                  <Chip tone={isOpenFollowUp(q.status) ? 'warning' : 'success'} size="xs" uppercase>{q.status}</Chip>
                </Inline>
              </Card>
            ))}
          </Stack>
        )}
      </DetailSection>
    </Stack>
  );
}

/** "How it was assessed" — the confidence model in words, plus what evidence
 *  actually informed the level. A full reasoning-log viewer (the source's
 *  ScoringRationale panel) needs its own run-history endpoint; this tab
 *  reads what the dimension payload already carries, which is honest about
 *  what a mock/early backend can show without inventing detail. */
function HowAssessedTab({ dimension }: { dimension: Dimension }) {
  const cert = dimension.certification;
  const scoredCount = dimension.evidence.filter((e) => e.scored).length;
  const awaitingCount = dimension.evidence.filter((e) => !e.scored).length;
  const basisMeaning = certificationBasisMeaning(cert?.basis);
  return (
    <Stack gap="md">
      <DetailSection title="Confidence" first>
        Rated <strong className="font-semibold text-text-primary">{confidenceLabel(dimension.confidence)}</strong>
        {cert?.basis ? ` · basis: ${cert.basis}` : ''}.{basisMeaning ? ` ${basisMeaning}` : ''}
      </DetailSection>
      <DetailSection title="What informed this">
        {scoredCount} evidence item{scoredCount === 1 ? '' : 's'} used in the assessment
        {awaitingCount > 0 ? `, ${awaitingCount} more ingested and awaiting assessment` : ''}.
      </DetailSection>
      {dimension.criteria_progress.length > 0 && (
        <DetailSection title="Criteria checked">
          <Stack gap="xs">
            {dimension.criteria_progress.map((c, i) => (
              <Inline key={i} gap="xs" align="start">
                <Chip tone={c.met ? 'success' : 'neutral'} size="xs">{c.met ? 'Met' : 'Open'}</Chip>
                {c.text}
              </Inline>
            ))}
          </Stack>
        </DetailSection>
      )}
    </Stack>
  );
}

function EvidenceTab({ dimension }: { dimension: Dimension }) {
  if (dimension.evidence.length === 0) {
    return <InlinePlaceholder>No evidence captured yet.</InlinePlaceholder>;
  }
  const scored = dimension.evidence.filter((e) => e.scored);
  const awaiting = dimension.evidence.filter((e) => !e.scored);
  return (
    <Stack gap="lg">
      {scored.length > 0 && (
        <DetailSection title="Used in the assessment" hint={String(scored.length)} first>
          <Stack gap="sm">
            {scored.map((ev) => (
              <Card key={ev.evidence_id} padding="sm">
                <Inline justify="between" align="center" gap="sm">
                  <Chip size="xs" uppercase>{ev.source_type}</Chip>
                  <MetaLine items={[ev.supports_level === null ? 'assessed' : `supports L${ev.supports_level}`]} />
                </Inline>
                <Stack gap="none" className="text-sm text-text-primary">{ev.excerpt}</Stack>
              </Card>
            ))}
          </Stack>
        </DetailSection>
      )}
      {awaiting.length > 0 && (
        <DetailSection title="Ingested, awaiting assessment" hint={String(awaiting.length)}>
          <Stack gap="xs">
            <InlinePlaceholder>
              Captured at intake and linked to this dimension. It has not been assessed against the rubric yet.
            </InlinePlaceholder>
            <Stack gap="sm">
              {awaiting.map((ev) => (
                <Card key={ev.evidence_id} padding="sm" className="border-dashed border-warning">
                  <Chip size="xs" uppercase>{ev.source_type}</Chip>
                  <Stack gap="none" className="mt-1 text-sm text-text-primary">{ev.excerpt}</Stack>
                </Card>
              ))}
            </Stack>
          </Stack>
        </DetailSection>
      )}
    </Stack>
  );
}

function DefinitionTab({ dimension }: { dimension: Dimension }) {
  return (
    <Stack gap="lg">
      {dimension.definition && (
        <DetailSection title="What this dimension measures" first>
          {dimension.definition}
        </DetailSection>
      )}
      {dimension.rubric_levels.length > 0 ? (
        <Stack gap="sm">
          {dimension.rubric_levels.map((rl) => {
            const isCurrent = !dimension.is_na && rl.level === dimension.current_level;
            return (
              <Card key={rl.level} padding="md" className={isCurrent ? 'border-accent bg-surface-hover' : undefined}>
                <Inline gap="sm" align="center">
                  <LevelBadge level={rl.level} size="xs" />
                  <SectionLabel className="text-text-primary">{rl.name}</SectionLabel>
                </Inline>
                <Stack gap="none" className="mt-1.5 text-sm text-text-secondary">{rl.description}</Stack>
                {rl.level_up_criteria.length > 0 && (
                  <Stack gap="xs" className="mt-2">
                    {rl.level_up_criteria.map((c, i) => (
                      <Inline key={i} gap="xs" wrap={false} className="text-xs text-text-secondary">
                        <strong className="text-accent">&bull;</strong>{c}
                      </Inline>
                    ))}
                  </Stack>
                )}
              </Card>
            );
          })}
        </Stack>
      ) : (
        <InlinePlaceholder>No rubric levels defined for this dimension.</InlinePlaceholder>
      )}
      {dimension.na_description && (
        <DetailSection title="Not applicable">{dimension.na_description}</DetailSection>
      )}
    </Stack>
  );
}

function HistoryTab({ dimension }: { dimension: Dimension }) {
  if (dimension.history.length === 0) return <InlinePlaceholder>No history recorded.</InlinePlaceholder>;
  return (
    <Stack gap="sm" className="border-l-2 border-border pl-4">
      {dimension.history.map((h, i) => (
        <Stack key={i} gap="none" className="text-sm">
          <Inline gap="sm" align="baseline">
            {h.is_na ? 'Marked not applicable' : `${h.from_level ?? '—'} → ${h.to_level ?? '—'}`}
            <MetaLine items={[fmtDate(h.changed_at), h.changed_by]} />
          </Inline>
          {h.rationale && <Stack gap="none" className="text-xs text-text-secondary">{h.rationale}</Stack>}
          {h.source_meeting && <Stack gap="none" className="text-xs italic text-text-tertiary">via {h.source_meeting}</Stack>}
        </Stack>
      ))}
    </Stack>
  );
}

type DetailTabKey = 'progress' | 'assessed' | 'evidence' | 'definition' | 'history';

function DetailPane({ dimension, index, teamId, tab, onTabChange, command, onChanged }: { dimension: Dimension; index: number; teamId: string; tab: DetailTabKey; onTabChange: (tab: DetailTabKey) => void; command: DraftCommand; onChanged: () => void }) {
  const tabs: TabItem[] = [
    { id: 'progress', label: 'Progress & follow-ups' },
    { id: 'assessed', label: 'How it was assessed' },
    { id: 'evidence', label: 'Evidence' },
    { id: 'definition', label: 'Definition & rubric' },
    { id: 'history', label: 'History' },
  ];

  return (
    <Stack key={dimension.id} gap="none">
      <DimensionDetailHeader dimension={dimension} index={index} />

      <Stack gap="sm" className="border-b border-border px-5 pb-5">
        <CertificationStatement dimension={dimension} />
        <MeasuredAgainst dimension={dimension} />
        {dimension.definition && (
          <Stack gap="none" className="text-sm leading-relaxed text-text-secondary">{dimension.definition}</Stack>
        )}
      </Stack>

      <Stack gap="none" className="px-5 pt-3">
        <Tabs idPrefix="dim-detail" items={tabs} value={tab} onValueChange={(id) => onTabChange(id as DetailTabKey)} size="sm" />
      </Stack>

      <Stack gap="none" className="p-5">
        {tab === 'progress' && <ProgressTab dimension={dimension} teamId={teamId} onChanged={onChanged} command={command} />}
        {tab === 'assessed' && <HowAssessedTab dimension={dimension} />}
        {tab === 'evidence' && <EvidenceTab dimension={dimension} />}
        {tab === 'definition' && <DefinitionTab dimension={dimension} />}
        {tab === 'history' && <HistoryTab dimension={dimension} />}
      </Stack>
    </Stack>
  );
}

// ─── The rail and the pane ──────────────────────────────────────────────────

interface DimensionMasterDetailProps {
  dimensions: Dimension[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  teamId: string;
  teamName: string;
  /** Re-read the team after a draft changed it (follow-ups added). */
  onChanged: () => void;
  /** The Certification tab is on screen: only then is the docked composer the page's input. */
  active: boolean;
  /** The team's Discussion (the page's one runtime, shared with the right pane's thread). */
  conversation: ConversationRuntime | null;
}

/**
 * Docked under a dimension's detail (MasterDetail's `paneFooter`, as the
 * initiative page's composer is docked): the library ConversationComposer for
 * this dimension.
 *
 *   Chat   posts to the team's Discussion (`assessment:team:<id>`, the thread
 *          the right pane shows) with the dimension as its page reference
 *          (`{kind: 'assessment-dimension', id}` only — each reader resolves the
 *          title), or — while this page's huddle is live — to the huddle beside
 *          the block. On Certification it is those conversations' one input.
 *   Agent  /summarize and /followups start the assessment drafter (the cards
 *          are the drafts panel's), /deck builds the team's review deck.
 *
 * The shared call block keeps tiles in the composer; the team's right pane
 * switches between the team discussion and the current call transcript.
 */
function DimensionFooter({ teamId, teamName, dimension, onChanged, cardsShownElsewhere, onDraft, command, active, conversation }: {
  teamId: string; teamName: string; dimension: { id: string; title: string }; onChanged: () => void; cardsShownElsewhere: boolean;
  onDraft: (kind: 'summary' | 'followups') => void; command: DraftCommand; active: boolean; conversation: ConversationRuntime | null;
}) {
  const navigate = useNavigate();
  const { session } = useSession();
  const { can } = useCapabilities();
  const access = composerAccess({ mayRead: can('ViewAssessment'), canScore: can('ScoreAssessment'), canRunAgent: can('RunAssessmentAgent') });
  const channel = teamDiscussionChannel(teamId);
  const host = useCallHost();
  const huddleComposer = usePageHuddleComposer('agent');
  const [note, setNote] = useState<string | null>(null);
  const reference = useMemo(() => dimensionPageReference({ id: teamId, name: teamName }, dimension), [teamId, teamName, dimension]);
  const huddleLive = !!host?.lobby && host.lobby.lobbyName === channel && !['idle', 'ended', 'failed'].includes(host.call.phase);
  // The call bar and tiles above the input, from the caller's ring to the ended notice.
  const { block } = useCallBlock(channel, { enabled: active });
  const runAgent = async (text: string): Promise<boolean | string> => {
    const { action } = routeAgentText(text);
    if (!action || !access.canAgent) { setNote(AGENT_HELP); return false; }
    if (action === 'deck') {
      try {
        const { deckId } = await createDeck(teamId, {});
        navigate(`/assessment/decks/${encodeURIComponent(deckId)}`);
        return true;
      } catch (cause) { return cause instanceof Error ? cause.message : 'The review deck could not be started.'; }
    }
    onDraft(action);
    return true;
  };
  const composer = (
    <ConversationComposer
      key={huddleComposer.editorKey}
      channel={channel}
      chat={conversation?.chat ?? null}
      context={{ kind: 'conversation', id: reference.id, title: '', reference: { id: reference.id, label: reference.label, page: reference.page } }}
      capabilities={{ maySend: access.canChat, ...(access.readOnlyReason ? { readOnlyReason: access.readOnlyReason } : {}),
        agent: { allowed: access.canAgent && !huddleComposer.unavailableHuddle, reason: huddleComposer.unavailableHuddle ? 'Choose a current destination before changing this draft’s mode.' : 'Your role cannot run the assessment agent' } }}
      offline={conversation && !conversation.connected ? 'The realtime gateway is not connected, so the discussion is unavailable.' : null}
      // The draft belongs to the signed person even before chat is ready.
      identity={session ? { userId: session.sub, displayName: session.name ?? session.sub } : null}
      recipients={[
        { id: 'discussion', label: 'Team discussion', channel, placeholder: 'Add to this team’s Discussion…',
          send: out => { conversation?.chat.sendMessage(out.text, out.metadata); setNote('Sent to the team’s Discussion.'); return !!conversation; } },
        // Call chat is the same destination and draft on every page, even after navigation.
        ...(huddleComposer.recipient ? [huddleComposer.recipient] : []),
      ]}
      {...huddleComposer.composerProps}
      defaultMode="agent"
      modePlaceholders={{ agent: '/summarize, /followups or /deck for this dimension…' }}
      commands={AGENT_COMMANDS.map(c => ({ trigger: c.trigger, label: c.label, hint: c.description, disabled: !access.canAgent, modes: ['agent' as const],
        run: (input: { text: string }) => runAgent(input.text) }))}
      onAgent={text => runAgent(text)}
      callBlock={block}
      // A reader's composer claims too (read-only, with its reason): one input on screen either way.
      claim={{ label: 'the dimension composer', enabled: active }}
      answersFocus={active && access.canChat}
      label="Dimension composer"
      data-testid="dimension-composer"
      className="@container bg-surface pt-3 [--dock-inset:1.5rem]"
      expanded
      allowEmoji={false}
      draftKey={`assessment-dimension:${reference.id}`}
    />
  );
  return (
    <Stack gap="sm" className="max-h-[60dvh] overflow-y-auto border-t border-border bg-surface" data-testid="dimension-composer-block" data-live-huddle={huddleLive ? 'true' : 'false'}>
      {!cardsShownElsewhere && access.canAgent && (
        <Stack gap="none" className="px-5 pt-3">
          <EvidenceDraftsPanel teamId={teamId} dimensionId={dimension.id} onChanged={onChanged} showControls={false}
            command={command} onStartError={setNote} data-testid="dimension-composer-drafts" />
        </Stack>
      )}
      {access.readOnlyReason && <T size="xs" tone="secondary" className="px-5 pt-2" wrap data-testid="dimension-composer-read-only">{access.readOnlyReason}</T>}
      {note && <InlineAlert tone="info" className="mx-5" data-testid="dimension-composer-note" onDismiss={() => setNote(null)}>{note}</InlineAlert>}
      {/* TeamScorecard owns the single right pane for both conversations. */}
      {composer}
    </Stack>
  );
}

export function DimensionMasterDetail({ dimensions, selectedId, onSelect, teamId, teamName, onChanged, active, conversation }: DimensionMasterDetailProps) {
  const [onlyClaims, setOnlyClaims] = useState(false);
  const filtered = filterRailDimensions(dimensions, onlyClaims);
  const fallbackId = filtered.length > 0 ? filtered[0].id : null;
  const effectiveId = filtered.some((dimension) => dimension.id === selectedId) ? selectedId : fallbackId;
  // The rail folds to a strip (the library rail fold, remembered per device and band).
  const fold = useRailFold({ storageKey: 'assessment.dimension-rail' });
  // The tab and drafter command live here, not in the pane, because the docked
  // composer (the pane's footer) needs both; a new dimension starts on Progress.
  const [tab, setTab] = useState<DetailTabKey>('progress');
  const [command, setCommand] = useState<DraftCommand>(null);
  useEffect(() => { setTab('progress'); }, [effectiveId]);
  const effective = filtered.find((dimension) => dimension.id === effectiveId) ?? null;
  const indexOf = (id: string) => dimensions.findIndex((item) => item.id === id);
  return (
    <ExplorerLayout
      className="assessment-dimension-layout min-h-0 flex-1"
      railWidth="ms"
      railTitle="Dimensions"
      railHeading="compact"
      railCount={filtered.length}
      railCountStyle="plain"
      railLabel="dimensions"
      railCollapsed={fold.folded}
      onToggleRail={fold.toggle}
      railHeader={<DimensionRailControls dimensions={dimensions} onlyClaims={onlyClaims} onChange={setOnlyClaims} />}
      rail={filtered.length === 0 ? (
        <InlinePlaceholder size="sm" align="center" className="p-5">No dimension has an open claim.</InlinePlaceholder>
      ) : (
        <DimensionRailList dimensions={filtered} allDimensions={dimensions} selectedId={effectiveId} onSelect={onSelect} />
      )}
      panePadding="none"
      paneFooter={effective ? (
        <DimensionFooter key={effective.id} teamId={teamId} teamName={teamName} dimension={effective} onChanged={onChanged}
          cardsShownElsewhere={tab === 'progress'} command={command} active={active} conversation={conversation}
          onDraft={(kind) => setCommand((prev) => ({ nonce: (prev?.nonce ?? 0) + 1, kind }))} />
      ) : undefined}
      data-testid="assessment-dimension-master-detail"
    >
      {effective ? (
        <DetailPane key={effective.id} dimension={effective} index={indexOf(effective.id)} teamId={teamId} tab={tab} onTabChange={setTab} command={command} onChanged={onChanged} />
      ) : (
        <InlinePlaceholder size="sm" align="center" className="p-5">No dimensions match these filters.</InlinePlaceholder>
      )}
    </ExplorerLayout>
  );
}
