// The centrepiece: a persistent 17-dimension rail paired with a tabbed detail
// pane for whichever dimension is selected. Built on the library's
// `MasterDetail` primitive (rail + pane, collapsible rail, persisted mode) —
// see docs/assessment-tenant.md "Primitives the library lacks" for its
// contract. Reproduces the source's DimensionMasterDetail.tsx.
//
// Rail rows and the detail-pane header have no matching library composite
// (see DimensionRow.tsx / DimensionDetailHeader.tsx, and
// docs/ui-components-queue.md) — everything else here is composed from
// Stack/Inline/Card/DetailSection/Chip, per docs/assessment-goal.md
// "De-hand-roll every page".

import { useEffect, useState } from 'react';
import { Link as RouterLink } from 'react-router';
import {
  Card,
  Chip,
  DetailSection,
  Inline,
  InlinePlaceholder,
  Input,
  Button,
  Toolbar,
  MasterDetail,
  MetaLine,
  SectionLabel,
  Stack,
  Tabs,
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
import { DimensionCompactRailRow, DimensionRailRow } from './DimensionRow';
import { DimensionDetailHeader } from './DimensionDetailHeader';
import { LevelBadge } from './LevelBadge';
import { useCapabilities } from '../../../lib/capabilities';

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

function ProgressTab({ dimension }: { dimension: Dimension }) {
  const openFollowUps = dimension.follow_up_questions.filter((q) => isOpenFollowUp(q.status));
  return (
    <Stack gap="lg">
      <DetailSection title="Criteria to level up" first>
        {!dimension.is_na && dimension.next_level_criteria.length > 0 ? (
          <Stack gap="xs" className="mt-2">
            {dimension.next_level_criteria.map((c, i) => (
              <Inline key={i} gap="xs" className="text-sm text-text-secondary">
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
                      <Inline key={i} gap="xs" className="text-xs text-text-secondary">
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

function DetailPane({ dimension, index }: { dimension: Dimension; index: number }) {
  const [tab, setTab] = useState<DetailTabKey>('progress');
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
        <Tabs idPrefix="dim-detail" items={tabs} value={tab} onValueChange={(id) => setTab(id as DetailTabKey)} size="sm" />
      </Stack>

      <Stack gap="none" className="p-5">
        {tab === 'progress' && <ProgressTab dimension={dimension} />}
        {tab === 'assessed' && <HowAssessedTab dimension={dimension} />}
        {tab === 'evidence' && <EvidenceTab dimension={dimension} />}
        {tab === 'definition' && <DefinitionTab dimension={dimension} />}
        {tab === 'history' && <HistoryTab dimension={dimension} />}
      </Stack>
    </Stack>
  );
}

// ─── Master-detail shell ────────────────────────────────────────────────────

// MasterDetail (ui-components) renders its rail as a plain `<nav aria-label>`
// with no `list`/`listbox` role, and each row as `<div role="button"
// tabIndex={0} aria-current={selected}>` — see
// docs/assessment-journeys/stretch/accessibility.md: selection is announced
// (aria-current) but the rail gives assistive tech no "3 of 17" positional
// context, since nothing marks the rows as a group. `renderRow`/
// `renderCompactRow` only supply a row's CHILDREN — the wrapping div (role,
// tabIndex, aria-current, the click/keydown handlers) is the library's own
// and isn't reachable through any prop (see docs/ui-components-queue.md).
// This repo cannot edit the library (CLAUDE.md), so — same technique as
// useKeyboardTree.ts uses for TreeView — this patches the rendered DOM
// directly via the stable `data-testid`s MasterDetail already emits
// (`${testId}-rail`, `${testId}-row-<key>`): `role="listbox"` + a fixed
// `aria-label` on the rail, `role="option"` + `aria-selected`/
// `aria-setsize`/`aria-posinset` on each row. A MutationObserver re-applies
// it because React rewrites `aria-label`/`role`/`aria-current` back to the
// library's own values on every re-render (e.g. every selection change) —
// disconnecting before each sync and reconnecting after avoids the observer
// reacting to its own writes. `aria-current` and each row's own `tabIndex={0}`
// are left exactly as MasterDetail renders them, so Enter/Space activation
// and tab order are unchanged from today — only the role model moves from
// bare `button` rows to `option` rows inside a `listbox`, which is the one
// APG pattern that matches what's actually here (individually focusable,
// non-modal single selection).
const DIMENSION_RAIL_TEST_ID = 'assessment-dimension-master-detail';

function useDimensionListboxSemantics(testId: string, dimensionCount: number): void {
  useEffect(() => {
    if (dimensionCount === 0) return;
    const root = document.querySelector<HTMLElement>(`[data-testid="${testId}-rail"]`);
    if (!root) return;
    const rowPrefix = `${testId}-row-`;
    const observerOptions: MutationObserverInit = {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ['role', 'aria-current', 'aria-label'],
    };

    const sync = () => {
      root.setAttribute('role', 'listbox');
      root.setAttribute('aria-label', 'Dimensions');
      const rows = Array.from(root.querySelectorAll<HTMLElement>(`[data-testid^="${rowPrefix}"]`));
      rows.forEach((row, i) => {
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', row.getAttribute('aria-current') === 'true' ? 'true' : 'false');
        row.setAttribute('aria-setsize', String(rows.length));
        row.setAttribute('aria-posinset', String(i + 1));
      });
    };

    const observer = new MutationObserver(() => {
      observer.disconnect();
      sync();
      observer.observe(root, observerOptions);
    });
    sync();
    observer.observe(root, observerOptions);
    return () => observer.disconnect();
  }, [testId, dimensionCount]);
}

interface DimensionMasterDetailProps {
  dimensions: Dimension[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function DimensionMasterDetail({ dimensions, selectedId, onSelect }: DimensionMasterDetailProps) {
  const [query, setQuery] = useState('');
  const [onlyClaims, setOnlyClaims] = useState(false);
  const filtered = dimensions.filter((dimension) =>
    `${dimension.id} ${dimension.title}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()) &&
    (!onlyClaims || (dimension.certification != null && hasOpenClaim(dimension.certification))));
  const fallbackId = filtered.length > 0 ? filtered[0].id : null;
  const effectiveId = filtered.some((dimension) => dimension.id === selectedId) ? selectedId : fallbackId;
  useDimensionListboxSemantics(DIMENSION_RAIL_TEST_ID, filtered.length);

  return (
    <Stack gap="none">
      <Toolbar aria-label="Dimension filters" wrap end={<Button size="sm" variant={onlyClaims ? 'primary' : 'secondary'} aria-pressed={onlyClaims} onClick={() => setOnlyClaims((value) => !value)}>Open claims</Button>}>
        <Input aria-label="Find a dimension" placeholder="Find a dimension…" value={query} onChange={(event) => setQuery(event.target.value)} />
      </Toolbar>
      <MasterDetail<Dimension>
        items={filtered}
        keyOf={(d: Dimension) => d.id}
        selectedKey={effectiveId}
        onSelect={onSelect}
        railTitle={`${filtered.length} of ${dimensions.length} dimensions`}
        railWidth={340}
        compactWidth={72}
        storageKey="assessment-dimension-rail-mode"
        data-testid={DIMENSION_RAIL_TEST_ID}
        renderRow={(d: Dimension) => <DimensionRailRow dimension={d} index={dimensions.findIndex((item) => item.id === d.id)} />}
        renderCompactRow={(d: Dimension) => <DimensionCompactRailRow dimension={d} index={dimensions.findIndex((item) => item.id === d.id)} />}
        renderDetail={(d: Dimension) => <DetailPane dimension={d} index={dimensions.findIndex((item) => item.id === d.id)} />}
        emptyDetail={<InlinePlaceholder size="sm" align="center" className="p-5">No dimensions match these filters.</InlinePlaceholder>}
      />
    </Stack>
  );
}
