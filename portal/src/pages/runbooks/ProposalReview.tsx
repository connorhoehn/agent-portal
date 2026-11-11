// A proposal as a page (/iq/runbooks/proposals/:pid): who asked and why, what it changes (the unified
// diff of the canonical markdown), the linter's findings, what it looks like, and — for a reviewer who
// owns the scope — Accept, Reject (a note is required) and Merge into another runbook. Everyone else
// reads it with an AccessNotice. A refused write says why in a sentence, never a bare status.
import { useEffect, useMemo, useRef, useState } from 'react';
import { AccessNotice, ChangeReviewCard, SourceList } from '@connorhoehn/ui-components';
import { DocumentOutline, EditorShell } from '@connorhoehn/ui-components/doc-editor';
import {
  Banner, Button, Chip, DetailSection, DiffViewer, FormField, Inline, Input, Select, Spinner, Stack, StatusPill, T,
} from '@connorhoehn/ui-components/shared';
import { UnavailableNotice, isNotFoundError } from '../../components/UnavailableNotice';
import { useFetch } from '../../hooks/useFetch';
import { useSession } from '../../lib/auth';
import { useCrumbLabel } from '../../lib/crumbLabels';
import { relativeTime } from '../../lib/relativeTime';
import { writeJson } from '../../lib/writeJson';
import { runbookDisplayTitle } from './runbookTitles';
import { RunbookDocView } from './RunbookDocView';
import { RunbookFiles } from './RunbookFiles';
import { ProposalAccept, type ScriptToRead } from './ProposalAccept';
import { RunSaid } from './RunSaid';
import { useRunbookNames } from './useRunbookNames';
import { diffWithNames, type Names } from './runbookNames';
import {
  KIND_LABEL, PROPOSAL_STATUS_TONE, filesDiffSummary, lintCounts, proposalAuthor, proposalStatusLabel, proposalTitle, refusalMessage, runPageHref, runbookHref,
  sameScope, scopeInWords, scopeLabel, viewerDiff,
} from './runbooksModel';
import type { FilesDiff, LintFinding, Proposal, RunbookFile, RunbookRow, RunbookScope, ScopeKind } from './types';

/**
 * A diff with its account ids read as names (`diffWithNames`: the directory, else the name the diff
 * itself pairs with the id). Presentational only: the stored text is unchanged, and "Show raw ids"
 * brings back the literal diff for whoever needs to quote it (UX leftovers, 10 November).
 */
function NamedDiff({ diff, names, defaultCollapsed = false, testId }: { diff: string; names: Names; defaultCollapsed?: boolean; testId: string }) {
  const [raw, setRaw] = useState(false);
  const named = useMemo(() => diffWithNames(diff, (id) => names.user(id)), [diff, names]);
  return (
    <Stack gap="xs">
      {named.replaced > 0 && (
        <Inline justify="end">
          <Button variant="link" size="sm" aria-pressed={raw} onClick={() => setRaw((v) => !v)} data-testid={`${testId}-raw-toggle`}>
            {raw ? 'Show names' : 'Show raw ids'}
          </Button>
        </Inline>
      )}
      <DiffViewer diff={raw ? diff : named.text} defaultCollapsed={defaultCollapsed} data-testid={testId} />
    </Stack>
  );
}

interface ProposalResponse {
  proposal: Proposal;
  /** The raw runbook row (no title: the library list carries it). */
  runbook: Omit<RunbookRow, 'title' | 'summary' | 'sha256' | 'health' | 'open_proposals'> | null;
  base_markdown: string | null;
  proposed_markdown: string | null;
  diff: { text: string; added: number; removed: number } | null;
  proposed_files?: RunbookFile[];
  files_diff?: FilesDiff | null;
  /** The scripts the reviewer must confirm reading: path and the hash of the bytes shown. */
  scripts_to_read?: ScriptToRead[];
  can_review: boolean;
}

/** A retire proposal's reason in words: the stored sentence quotes run references, which belong on the run pages, not here. */
function retireRationale(p: Proposal, title: string): string {
  const ev = p.retire_evidence;
  if (p.kind !== 'retire' || !ev) return p.rationale;
  const n = ev.run_refs.length;
  if (ev.rule === 'unfollowed') return `The last ${n} successful runs that were given ${title} each said they did not follow it. The model may no longer need it.`;
  if (ev.rule === 'disuse-unfollowed') return `${title} was given to ${n} runs recently and none followed it.`;
  return `No run has been given ${title} in the last ninety days.`;
}

export function ProposalReview({ pid, published, publishedLoading = false, onOpen, onDecided }: {
  pid: string;
  /** Published runbooks, for "Merge into…". */
  published: readonly RunbookRow[];
  /** Navigation sections depend on the initial library lookup (merge targets). */
  publishedLoading?: boolean;
  onOpen: (href: string) => void;
  onDecided: () => void;
}) {
  const pageBody = useRef<HTMLElement | null>(null);
  const [activeSection, setActiveSection] = useState<string | null>(null);
  const detail = useFetch<ProposalResponse>(`/api/runbooks/proposals/${encodeURIComponent(pid)}`, 0);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [scopeKind, setScopeKind] = useState<ScopeKind>('org');
  const [scopeRef, setScopeRef] = useState('');
  const [mergeInto, setMergeInto] = useState('');
  const [busy, setBusy] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [unread, setUnread] = useState<string[]>([]);
  const scopeSeeded = useRef(false);
  const { session } = useSession();
  const names = useRunbookNames();
  const data = detail.data;
  const titles = new Map(published.map((r) => [r.id, r.title]));
  useEffect(() => {
    const root = pageBody.current;
    const scroller = root?.closest<HTMLElement>('[data-testid="proposal-review-scroller"]');
    if (!data || !root || !scroller) return;
    let timer: ReturnType<typeof setTimeout>;
    const update = () => {
      const sections = [...root.querySelectorAll<HTMLElement>(':scope > [data-testid^="proposal-section-"]:not([data-testid="proposal-section-contents"])')];
      const bottom = scroller.scrollTop > 0 && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
      const current = bottom ? sections.at(-1) : sections.filter(section => section.getBoundingClientRect().top <= scroller.getBoundingClientRect().top + 32).at(-1);
      setActiveSection(current?.dataset.testid?.replace('proposal-section-', '') ?? null);
    };
    const schedule = () => { clearTimeout(timer); timer = setTimeout(update, 120); };
    scroller.addEventListener('scroll', schedule, { passive: true });
    return () => { clearTimeout(timer); scroller.removeEventListener('scroll', schedule); };
  }, [data, publishedLoading]);
  useEffect(() => {
    const proposed = data?.proposal.proposed_scope;
    if (!data || scopeSeeded.current || !proposed) return;
    scopeSeeded.current = true;
    setScopeKind(proposed.kind); setScopeRef(proposed.ref ?? '');
  }, [data]);
  useCrumbLabel(pid, data ? runbookDisplayTitle(proposalTitle(data.proposal, titles)) : undefined);

  if (detail.error && !data) {
    return (
      <EditorShell title="Runbook proposal" titleAs="h1" titleSize="md" headerInset="page" surface="plain" label="Proposal">
      <Stack className="p-6" data-testid="proposal-missing">
        <UnavailableNotice error={isNotFoundError(detail.error) ? 'That proposal does not exist.' : detail.error} what="this proposal" source="Proposals are read from the runbook store" onRetry={detail.refresh} />
      </Stack>
      </EditorShell>
    );
  }
  if (!data || publishedLoading) return <EditorShell title="Runbook proposal" titleAs="h1" titleSize="md" headerInset="page" surface="plain" label="Proposal">
    <Inline role="status" gap="sm" className="px-6 py-4" data-testid="loading-state"><Spinner size="md" decorative /><T size="sm" tone="secondary">Loading proposal…</T></Inline>
  </EditorShell>;
  const { proposal: p, runbook, can_review: canReview } = data;
  const open = p.status === 'open';
  const title = runbookDisplayTitle(proposalTitle(p, titles));
  const author = proposalAuthor(p, names);
  const counts = lintCounts(p.lint);
  const stale = open && runbook != null && p.base_version != null && p.base_version !== runbook.current_version;
  const retired = runbook?.status === 'retired';
  const needsScope = p.kind === 'new';
  const demo = p.debrief?.simulated === true;
  const dispatchedByMe = !!session && !!p.source.dispatched_by && p.source.dispatched_by === session.sub;
  const mergeTargets = published.filter((r) => r.status === 'published' && r.id !== p.runbook_id).map((r) => ({ value: r.id, label: runbookDisplayTitle(r.title) }));

  // The card's summary pair; the real change is the diff beneath it.
  const cardPairs = p.kind === 'retire'
    ? [{ before: title, after: 'Retired' }]
    : p.kind === 'new'
      ? [{ before: 'No such runbook yet', after: p.proposed?.summary ?? title }]
      : [{ before: `Version ${p.base_version ?? ''} of ${title}`, after: `${data.diff ? `+${data.diff.added} lines, −${data.diff.removed} lines` : 'No textual change'}; the full diff is below` }];
  const done = () => { detail.refresh(); onDecided(); };
  const chosenScope: RunbookScope | null = needsScope ? (scopeKind === 'org' ? { kind: 'org', ref: null } : { kind: scopeKind, ref: scopeRef.trim() }) : (runbook ? runbook.scope : null);
  const proposedScope = p.proposed_scope ?? null;
  const widening = needsScope && proposedScope && chosenScope && !sameScope(chosenScope, proposedScope)
    ? { from: scopeLabel(proposedScope, names), to: scopeLabel(chosenScope, names) } : null;
  const accept = async (scriptsRead: ScriptToRead[], widen: boolean) => {
    setRefusal(null); setUnread([]);
    const body: Record<string, unknown> = { expected_version: runbook?.current_version };
    if (needsScope && chosenScope) body['scope'] = chosenScope.kind === 'org' ? { kind: 'org' } : { kind: chosenScope.kind, ref: chosenScope.ref };
    if (scriptsRead.length) body['scripts_read'] = scriptsRead;
    if (widen) body['widen_scope'] = true;
    const res = await writeJson<{ code?: string; scripts?: ScriptToRead[]; other_reviewers?: number }>(`/api/runbooks/proposals/${encodeURIComponent(p.id)}/accept`, 'POST', body);
    if (!res.ok) {
      if (res.data?.code === 'SCRIPTS_UNREAD') setUnread((res.data.scripts ?? []).map((x) => x.path));
      else setAccepting(false);
      setRefusal(res.data?.code === 'SELF_ACCEPT' && res.data.other_reviewers
        ? `You dispatched the run that proposed this, and ${res.data.other_reviewers === 1 ? 'one other person' : `${res.data.other_reviewers} other people`} can review it, so one of them decides it.`
        : refusalMessage(res.status, res.data?.code, res.error));
      return;
    }
    setAccepting(false);
    done();
  };
  const reject = (note: string) => {
    setRefusal(null);
    void writeJson<{ code?: string }>(`/api/runbooks/proposals/${encodeURIComponent(p.id)}/reject`, 'POST', { note }).then((res) => {
      if (!res.ok) setRefusal(refusalMessage(res.status, res.data?.code, res.error)); else done();
    });
  };
  const merge = async () => {
    setBusy(true); setRefusal(null);
    const res = await writeJson<{ proposal: Proposal; code?: string }>(`/api/runbooks/proposals/${encodeURIComponent(p.id)}/merge`, 'POST', { into: mergeInto });
    setBusy(false);
    if (!res.ok) { setRefusal(refusalMessage(res.status, res.data?.code, res.error)); return; }
    onDecided();
    onOpen(`/iq/runbooks/proposals/${encodeURIComponent(res.data!.proposal.id)}`);
  };

  const sources = [
    ...(p.source.run_ref ? [{ id: 'run', title: names.run(p.source.run_ref), kind: 'transcript' as const, meta: 'The run that proposed it', onOpen: () => onOpen(runPageHref(p.source.run_ref!)) }] : []),
    // The seeded runs are their own sessions; a separate session row only helps when it is a different one.
    ...(p.source.session_id && p.source.session_id !== p.source.run_ref ? [{ id: 'session', title: 'The session it ran in', kind: 'transcript' as const, meta: 'Its session' }] : []),
    ...p.source.lab_experience_ids.map((l, k) => ({ id: `lab:${l}`, title: `Run note ${k + 1}`, kind: 'transcript' as const, meta: 'Evidence cited' })),
  ];

  const sections = [
    { id: 'summary', title: 'Change summary' },
    ...(p.kind !== 'retire' ? [{ id: 'changes', title: 'Document changes' }] : []),
    ...(data.files_diff?.text || data.proposed_files?.length ? [{ id: 'files', title: 'File changes' }] : []),
    { id: 'checks', title: 'Review checks' },
    ...(p.source.kind === 'run' && p.source.run_ref ? [{ id: 'said', title: 'What the run said' }] : []),
    ...(p.kind === 'retire' && p.retire_evidence ? [{ id: 'runs', title: 'Runs it names' }] : []),
    ...(p.proposed ? [{ id: 'preview', title: 'Proposed runbook' }] : []),
    ...(sources.length ? [{ id: 'sources', title: 'Sources' }] : []),
    ...(open && canReview && p.kind !== 'retire' && mergeTargets.length ? [{ id: 'merge', title: 'Merge proposal' }] : []),
  ];
  const sectionTitle = (id: string) => {
    const index = sections.findIndex(section => section.id === id);
    return `${index + 1}. ${sections[index]!.title}`;
  };
  const goToSection = (id: string) => {
    const root = pageBody.current;
    const section = root?.querySelector<HTMLElement>(`[data-testid="proposal-section-${id}"]`);
    const target = section?.querySelector<HTMLElement>('h2') ?? section;
    const scroller = root?.closest<HTMLElement>('[data-testid="proposal-review-scroller"]');
    if (!target || !scroller) return;
    target.tabIndex = -1; target.focus({ preventScroll: true });
    scroller.scrollTo({ top: scroller.scrollTop + target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 16, behavior: 'smooth' });
    setActiveSection(id === 'contents' ? null : id);
  };

  return (
    <EditorShell
      headerInset="page" titleSize="md" titleAs="h1" titleOverflow="wrap"
      title={title}
      statusPill={<Inline gap="sm"><Chip tone="neutral" size="md">Runbook proposal</Chip><StatusPill tone={PROPOSAL_STATUS_TONE[p.status]} label={proposalStatusLabel(p)} size="sm" />{demo && <Chip tone="warning" size="md" data-testid="proposal-demo-data">Demo data</Chip>}</Inline>}
      subtitle={<T size="xs" tone="tertiary">{`${KIND_LABEL[p.kind]} · ${author.name} · ${relativeTime(p.created_at)}${p.base_version != null ? ` · against v${p.base_version}` : ''}`}</T>}
      surface="plain"
      label="Proposal"
      footer={<Stack className="px-6 py-2"><DocumentOutline entries={sections.map(section => ({ id: section.id, text: sectionTitle(section.id), level: 1 }))}
        activeId={activeSection} onSelect={goToSection} presentation="controls" onContents={() => goToSection('contents')}
        aria-label="Section navigation" data-testid="proposal-section-navigation" /></Stack>}
      data-testid="proposal-review"
    >
      <Stack ref={pageBody} gap="lg" className="w-full px-6 py-4">
        <DetailSection as="h2" variant="heading" title="On this page" className="border-b border-border pb-4" data-testid="proposal-section-contents">
          <DocumentOutline aria-label="On this page" entries={sections.map(section => ({ id: section.id, text: sectionTitle(section.id), level: 1 }))}
            activeId={activeSection} onSelect={goToSection} wrap data-testid="proposal-contents" />
        </DetailSection>
        {!open && (
          <Banner variant={p.status === 'accepted' ? 'success' : 'info'} layout="callout" icon title={`${proposalStatusLabel(p)}${p.decided_by ? ` by ${names.person(p.decided_by)}` : ''}${p.decided_at ? ` ${relativeTime(p.decided_at)}` : ''}`} data-testid="proposal-decided">
            {p.note ?? (p.merged_into ? 'Merged into another proposal for review.' : 'No note was left.')}
          </Banner>
        )}
        {stale && (
          <Banner variant="warning" layout="callout" icon title="This runbook changed since the proposal" data-testid="proposal-stale">
            {`The proposal was written against v${p.base_version}; ${title} is at v${runbook!.current_version}. Accepting is refused until a fresh proposal is made against the current version.`}
          </Banner>
        )}
        {retired && open && (
          <Banner variant="warning" layout="callout" icon title="The target runbook is retired" data-testid="proposal-retired">
            Nothing can be accepted onto a retired runbook. Reject this proposal, or merge it into a published runbook.
          </Banner>
        )}
        {p.similar.length > 0 && (
          <Banner variant="info" layout="callout" icon title="Looks like an existing runbook" data-testid="proposal-similar">
            <Stack gap="xs">
              {p.similar.map((s) => (
                <Inline key={s.runbook_id} gap="sm" align="center">
                  <Button variant="link" size="sm" onClick={() => onOpen(runbookHref(s.runbook_id))} title={s.runbook_id}>{titles.get(s.runbook_id) ?? names.runbook(s.runbook_id)}</Button>
                  <T size="xs" tone="tertiary">{s.reason}</T>
                </Inline>
              ))}
            </Stack>
          </Banner>
        )}
        {refusal && <Banner variant="error" layout="callout" icon title="Not done" data-testid="proposal-refusal">{refusal}</Banner>}
        {p.expired && open && (
          <Banner variant="warning" layout="callout" icon title="Expired" data-testid="proposal-expired">Nobody decided this proposal in fourteen days, so it can no longer be accepted. Ask for a fresh one.</Banner>
        )}
        {dispatchedByMe && open && (
          <Banner variant="info" layout="callout" icon title="You dispatched the run that proposed this" data-testid="proposal-dispatcher">
            Someone else decides it when another reviewer can. If nobody else can review this scope, you may, and the record says you decided it as the person who dispatched the run.
          </Banner>
        )}
        {p.decided_as === 'sole-reviewer-dispatcher' && (
          <Banner variant="info" layout="callout" icon title="Decided by the person who dispatched the run" data-testid="proposal-sole-reviewer">Nobody else could review this scope, so the sole-reviewer rule applied and the record says so.</Banner>
        )}

        <DetailSection as="h2" variant="heading" title={sectionTitle('summary')} className="border-b border-border pb-6" data-testid="proposal-section-summary">
        <Stack gap="md">
        <ChangeReviewCard
          category={KIND_LABEL[p.kind]}
          author={{ name: author.name, kind: author.kind }}
          pairs={cardPairs}
          rationale={retireRationale(p, title)}
          status={p.status === 'open' ? 'pending' : p.status === 'accepted' ? 'applied' : 'rejected'}
          {...(open && canReview ? { onReject: reject } : {})}
          {...(open && canReview && !retired && !p.expired ? { actions: <Button variant="primary" size="sm" onClick={() => setAccepting(true)} data-testid="proposal-accept">{p.kind === 'retire' ? 'Retire this runbook…' : 'Accept…'}</Button> } : {})}
          data-testid="proposal-card"
        />

        {open && !canReview && (
          <AccessNotice tone="info" title="You can read this proposal, not decide it"
            body="Accepting, rejecting and merging belong to the runbook’s owner or an SME on its initiative, and nobody decides their own proposal." data-testid="proposal-access" />
        )}

        {open && canReview && needsScope && (
          <DetailSection variant="heading" title="Where the new runbook lives" description="A new runbook needs a scope: it names who may review it.">
            <Inline gap="sm" align="end">
              <FormField label="Scope">
                {({ labelId: _l, ...w }) => (
                  <Select {...w} size="sm" className="w-auto" value={scopeKind} onChange={(e) => setScopeKind(e.target.value as ScopeKind)}
                    options={[{ value: 'org', label: 'Whole organisation' }, { value: 'initiative', label: 'An initiative' }, { value: 'repo', label: 'A repository' }, { value: 'tool', label: 'A tool' }]} />
                )}
              </FormField>
              {scopeKind === 'initiative' && names.initiatives.length > 0 && (
                <FormField label="Which initiative">
                  {({ labelId: _l, ...w }) => (
                    <Select {...w} size="sm" className="w-auto min-w-56" value={scopeRef} placeholder="Choose an initiative…" onChange={(e) => setScopeRef(e.target.value)}
                      options={names.initiatives.map((i) => ({ value: i.id, label: i.name }))} />
                  )}
                </FormField>
              )}
              {scopeKind !== 'org' && !(scopeKind === 'initiative' && names.initiatives.length > 0) && (
                <FormField label="Which one">
                  {({ labelId: _l, ...w }) => (
                    <Input {...w} value={scopeRef} onChange={(e) => setScopeRef(e.target.value)} placeholder={scopeKind === 'initiative' ? 'Initiative reference' : scopeKind === 'repo' ? 'orgiq-auth-service' : 'fargate'} />
                  )}
                </FormField>
              )}
            </Inline>
          </DetailSection>
        )}

        </Stack>
        </DetailSection>

        {p.kind !== 'retire' && (
          <DetailSection as="h2" variant="heading" first title={sectionTitle('changes')} data-testid="proposal-section-changes" hint={data.diff ? `+${data.diff.added} −${data.diff.removed}` : undefined}>
            {data.diff?.text
              ? <NamedDiff diff={viewerDiff(data.diff.text, `${title}.md`)} names={names} testId="proposal-diff" />
              : <T size="sm" tone="secondary">The proposal has no textual change.</T>}
          </DetailSection>
        )}

        {(data.files_diff?.text || Boolean(data.proposed_files?.length)) && (
          <DetailSection as="h2" variant="heading" title={sectionTitle('files')} data-testid="proposal-section-files" hint={data.files_diff ? filesDiffSummary(data.files_diff) : undefined}>
            <Stack gap="md">
              {/* The bundle's files are code and recorded data (a presence snapshot keyed by user id):
                  each file's diff opens on demand under its path and line counts, exact as written,
                  so the record reads as its summary first (walk, 9 November). */}
              {data.files_diff?.text && <NamedDiff diff={data.files_diff.text} names={names} defaultCollapsed testId="proposal-files-diff" />}
              {data.proposed_files && data.proposed_files.length > 0 && <RunbookFiles files={data.proposed_files} testId="proposal-files-list" />}
            </Stack>
          </DetailSection>
        )}

        {p.source.kind === 'run' && p.source.run_ref && (
          <DetailSection as="h2" variant="heading" title={sectionTitle('said')} data-testid="proposal-section-said">
            <RunSaid runRef={p.source.run_ref} runName={names.run(p.source.run_ref)} />
          </DetailSection>
        )}

        {p.kind === 'retire' && p.retire_evidence && (
          <DetailSection as="h2" variant="heading" title={sectionTitle('runs')} hint={`${p.retire_evidence.run_refs.length}`} data-testid="proposal-section-runs">
            <Stack gap="xs">
              {p.retire_evidence.run_refs.map((r) => (
                <Button key={r} variant="link" size="sm" onClick={() => onOpen(runPageHref(r))} data-testid="retire-run">{names.run(r)}</Button>
              ))}
              <T size="xs" tone="tertiary" wrap>{p.rationale}</T>
            </Stack>
          </DetailSection>
        )}

        <DetailSection as="h2" variant="heading" title={sectionTitle('checks')} data-testid="proposal-section-checks" hint={`${counts.errors} errors · ${counts.warnings} warnings`}>
          <Stack gap="xs" data-testid="proposal-lint">
            {p.lint.length ? p.lint.map((f: LintFinding, i) => (
              <Banner key={`${i}:${f.rule}:${f.path}`} variant={f.severity === 'error' ? 'error' : 'warning'} title={`${f.rule} · ${f.path}`}>{f.message}</Banner>
            )) : <T size="sm" tone="secondary">No findings were reported for this proposal.</T>}
          </Stack>
        </DetailSection>

        {p.proposed && (
          <DetailSection as="h2" variant="heading" title={sectionTitle('preview')} data-testid="proposal-section-preview">
            <RunbookDocView doc={{ ...p.proposed, title: runbookDisplayTitle(p.proposed.title) }} {...(data.proposed_markdown ? { markdown: data.proposed_markdown } : {})} />
          </DetailSection>
        )}

        {sources.length > 0 && (
          <DetailSection as="h2" variant="heading" title={sectionTitle('sources')} data-testid="proposal-section-sources">
            <SourceList layout="row" aria-label="Proposal sources" items={sources} />
          </DetailSection>
        )}

        {open && canReview && p.kind !== 'retire' && mergeTargets.length > 0 && (
          <DetailSection as="h2" variant="heading" title={sectionTitle('merge')} data-testid="proposal-section-merge" description="Re-aim this proposal as an edit of another runbook; it stays open there for review.">
            <Inline gap="sm" align="center">
              <Select size="sm" aria-label="Merge into" className="w-auto min-w-64" value={mergeInto} placeholder="Choose a runbook…" options={mergeTargets} onChange={(e) => setMergeInto(e.target.value)} />
              <Button variant="secondary" size="sm" disabled={!mergeInto || busy} onClick={() => { void merge(); }} data-testid="proposal-merge">Merge into…</Button>
            </Inline>
          </DetailSection>
        )}
      </Stack>
      <ProposalAccept
        open={accepting}
        title={p.kind === 'retire' ? 'Retire this runbook?' : 'Accept this proposal?'}
        scopeSentence={p.kind === 'retire' ? `${title} will no longer be given to any run.${runbook ? ` ${scopeInWords(runbook.scope, names)}` : ''}` : chosenScope ? scopeInWords(chosenScope, names) : 'This runbook will be given to runs it applies to.'}
        scripts={data.scripts_to_read ?? []}
        widening={widening}
        unread={unread}
        onCancel={() => setAccepting(false)}
        onAccept={accept}
      />
    </EditorShell>
  );
}
