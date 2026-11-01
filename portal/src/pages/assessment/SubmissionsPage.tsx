// Submissions — the daily intake surface. One row per submission (its current
// revision carries the status; earlier revisions are kept for history behind it), plus
// the add-wizard: Drop -> Preview & match -> Fetch links -> Run prompt.
//
// Structure mirrors the source app's SubmissionsList.tsx / SubmissionsWizard.tsx
// (`agentic-assessment-accelerator/ui/src/components/submissions/`), re-expressed on
// this library's DataTable/ListRailLayout/Wizard rather than a hand-rolled table and stepper.
// See docs/assessment-tenant.md "SubmissionsPage.tsx" for the exact contract.
//
// A row opens its submission as a page, `/assessment/submissions/:submissionId`
// (the catalog-record pattern of `/iq/library/:assetId` and `/iq/designs/:id`):
// the list becomes the flush list rail beside the shell's rails and the record —
// its facts and its revision history — fills the content column
// (docs/layout-cascade.md rules 5 and 8). Nothing about a submission opens in a
// drawer or modal; only the delete/clear confirmations do.

import { useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import {
  Button,
  Checkbox,
  Chip,
  CollectionToolbar,
  ConfirmDialog,
  DataTable,
  DetailHeader,
  DetailSection,
  EmptyState,
  ErrorState,
  IconButton,
  InlinePlaceholder,
  KeyValue,
  LoadingState,
  PageHeader,
  Stack,
  StatStrip,
  StatusPill,
  T,
  TrashIcon,
  Wizard,
} from '@connorhoehnslalom/ui-components/shared';
import { RecordNotFound, UnavailableNotice } from '../../components/UnavailableNotice';
import { CollectionRecordFrame } from '../../components/collections/CollectionRecordFrame';
import { useCrumbLabel } from '../../lib/crumbLabels';
import { RecordLink } from '../decisions/RecordLink';
import { CollectionCommandHost } from '../../components/collections/CollectionCommandHost';
import { CollectionCommandPage } from '../../components/collections/CollectionCommandPage';
import { submissionsCommandAdapter } from './assessmentCollectionCommands';
import { useAnswerScope } from '../../components/collections/useAnswerScope';
import { useCapabilities } from '../../lib/capabilities';
import { useFetch } from '../../hooks/useFetch';
import { useRowSearch } from '../../hooks/useRowSearch';
import { toastError, toastSuccess } from '../../lib/toastStore';
import { sendJson } from '../../lib/writeJson';
import { useTeams } from './dashboard/useTeams';
import { envelopesToListItems, formatRelativeTime, groupSubmissions, revisionLabel } from './secondaryFormat';
import type { CommitResponse, ParseResponse, SubmissionRevisionGroup, SubmissionsListResponse } from './secondaryTypes';
import DropStep from './submissions/DropStep';
import PreviewStep from './submissions/PreviewStep';
import FetchLinksStep from './submissions/FetchLinksStep';
import RunPromptStep from './submissions/RunPromptStep';

type WizardStepKey = 'drop' | 'preview' | 'fetch' | 'run';

function AddWizard({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<WizardStepKey>('drop');
  const [parse, setParse] = useState<ParseResponse | null>(null);
  const [commit, setCommit] = useState<CommitResponse | null>(null);
  // Mirrors FetchLinksStep's own "every link fetched or skipped" check (both
  // read `linksStepComplete`) so the wizard shell's bottom Next button can
  // never advance past an unresolved link set that the step's own Continue
  // button would still block. Defaults true so a commit with no links at all
  // never starts the step artificially disabled.
  const [fetchStepComplete, setFetchStepComplete] = useState(true);

  const steps = [
    {
      key: 'drop',
      label: 'Drop file',
      canAdvance: parse !== null,
      content: <DropStep onParsed={(p) => { setParse(p); setStep('preview'); }} />,
    },
    {
      key: 'preview',
      label: 'Preview & match',
      canAdvance: commit !== null,
      content: parse ? (
        <PreviewStep
          parse={parse}
          onCommitted={(c) => { setCommit(c); setStep('fetch'); }}
          onBack={() => setStep('drop')}
        />
      ) : (
        <InlinePlaceholder>Drop a file first.</InlinePlaceholder>
      ),
    },
    {
      key: 'fetch',
      label: 'Fetch links',
      canAdvance: fetchStepComplete,
      content: commit ? (
        <FetchLinksStep
          commit={commit}
          onContinue={() => setStep('run')}
          onBack={() => setStep('preview')}
          onCompletionChange={setFetchStepComplete}
        />
      ) : (
        <InlinePlaceholder>Commit submissions first.</InlinePlaceholder>
      ),
    },
    {
      key: 'run',
      label: 'Run prompt',
      content: commit ? (
        <RunPromptStep commit={commit} onStartOver={() => { setParse(null); setCommit(null); setStep('drop'); }} />
      ) : (
        <InlinePlaceholder>Commit submissions first.</InlinePlaceholder>
      ),
    },
  ];

  return (
    <Wizard
      steps={steps}
      activeKey={step}
      onStep={(k: string) => setStep(k as WizardStepKey)}
      onFinish={onDone}
      finishLabel="Back to submissions"
    />
  );
}

/** The submission a URL names: its group's key (the original envelope), or any
 *  revision's envelope id — a link to a revision opens the submission it belongs to. */
function findGroup(groups: readonly SubmissionRevisionGroup[], id: string | undefined): SubmissionRevisionGroup | undefined {
  if (!id) return undefined;
  return groups.find((g) => g.key === id)
    ?? groups.find((g) => g.current.envelope_id === id || g.superseded.some((rev) => rev.envelope_id === id));
}

const submissionHref = (key: string) => `/assessment/submissions/${encodeURIComponent(key)}`;

/** One submission, in the content column beside the list rail: its facts and its revision history. */
function SubmissionRecord({ group, canManage, onDelete }: {
  group: SubmissionRevisionGroup;
  canManage: boolean;
  onDelete: () => void;
}) {
  const fetched = group.current.links_total - group.current.links_pending;
  const revisions = [group.current, ...group.superseded].map((rev, i) => ({ ...rev, current: i === 0 }));
  return (
    <Stack gap="lg" data-testid="assessment-submission-record">
      <DetailHeader
        title={group.teamName}
        badge={<StatusPill state={group.processed ? 'success' : 'warning'} label={group.processed ? 'Processed' : 'Unprocessed'} size="sm" />}
        description={`${group.formId ? `Form #${group.formId}` : 'Manual submission'}`}
        {...(canManage ? {
          aside: (
            <Button variant="danger" size="sm" onClick={onDelete}>
              Delete submission
            </Button>
          ),
          asideWidth: 180,
        } : {})}
      />
      <DetailSection title="Submission" variant="heading" first>
        <KeyValue
          items={[
            { label: 'Team', value: group.teamName },
            { label: 'Submitted as', value: group.submittedTeamName ?? group.teamName, muted: !group.submittedTeamName },
            { label: 'Submitter', value: group.current.submitter_name || 'Not recorded', muted: !group.current.submitter_name },
            // The export's own "Completion time" string, verbatim (see the list's Received column).
            { label: 'Received', value: group.current.submitted_at?.trim() || 'Not recorded', muted: !group.current.submitted_at?.trim() },
            { label: 'Links fetched', value: `${fetched} of ${group.current.links_total}` },
            { label: 'Envelope', value: group.current.envelope_id, mono: true },
          ]}
        />
      </DetailSection>
      <DetailSection
        title="Revision history"
        hint={group.revisionCount === 1 ? 'The original submission — no revisions' : `${group.revisionCount} revisions`}
        variant="heading"
      >
        <DataTable<{ envelope_id: string; ingested_at: string; current: boolean }>
          data={revisions}
          keyField={(rev) => rev.envelope_id}
          staticRows="Revisions are read-only snapshots of this submission; the latest one is the record above."
          pageSize={10}
          data-testid="assessment-submission-revisions"
          columns={[
            { key: 'revision', header: 'Revision', render: (rev) => <T size="sm" weight="medium">{revisionLabel(rev.envelope_id)}</T> },
            { key: 'envelope', header: 'Envelope', render: (rev) => <T size="xs" tone="tertiary">{rev.envelope_id}</T> },
            {
              key: 'status',
              header: 'Status',
              width: '128px',
              render: (rev) => (rev.current ? <StatusPill state="info" label="Current" size="sm" /> : <Chip tone="neutral" size="xs">Superseded</Chip>),
            },
            { key: 'when', header: 'When', numeric: true, render: (rev) => formatRelativeTime(rev.ingested_at) },
          ]}
        />
      </DetailSection>
    </Stack>
  );
}

const SUBMISSION_ANSWERS = ['assessment:staged-submissions'] as const;

export default function SubmissionsPage() {
  const { can, ready } = useCapabilities();
  const canManage = ready && can('ManageSubmissions');
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { submissionId } = useParams<{ submissionId?: string }>();
  const adding = params.get('view') === 'add';

  // `null` while the add wizard is open — the list underneath is stale
  // anyway, and refetching it mid-wizard would just be discarded on return.
  const { data, isLoading: loading, error, degraded, refresh: load } = useFetch<SubmissionsListResponse>(
    adding ? null : '/api/assessment/submissions',
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmingDelete, setConfirmingDelete] = useState<SubmissionRevisionGroup | null>(null);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [busy, setBusy] = useState(false);

  // Roster names for `resolveTeamName` — a hand-matched row's team_id must
  // render the matched team's real name, not the submitter's own typed text.
  const { teams } = useTeams();
  const teamsById = useMemo(() => new Map(teams.map((t) => [t.id, t.name])), [teams]);

  const groups = useMemo(
    () => groupSubmissions(envelopesToListItems(data?.envelopes ?? []), undefined, teamsById),
    [data, teamsById],
  );
  const open = findGroup(groups, submissionId);
  // The trail's record crumb reads the team, not the envelope id.
  useCrumbLabel(submissionId, open ? open.teamName : null);
  // The strip's numbers are derived from the grouped rows — the listing sends
  // no summary block, and reading one that wasn't there hid the strip entirely.
  const summary = useMemo(() => ({
    distinct_submissions: groups.length,
    teams: new Set(groups.map((g) => g.teamId)).size,
    distinct_unprocessed: groups.filter((g) => !g.processed).length,
    links_pending_total: groups.reduce((n, g) => n + (g.current.links_pending ?? 0), 0),
  }), [groups]);

  // Search shares the strip's row (docs/layout-cascade.md "Tables"), so the
  // page filters the rows rather than DataTable's own lone search field. The
  // list rail's find box filters the same rows.
  const search = useRowSearch(groups, (g) => [
    g.teamId, g.teamName, g.submittedTeamName ?? '', g.formId ? `Form #${g.formId}` : 'Manual submission',
    g.current.envelope_id, g.current.submitter_name ?? '', g.processed ? 'Processed' : 'Unprocessed',
  ].join(' '));

  // "Which submissions are staged" answers as a fact; the table then lists the submissions it cites.
  const scope = useAnswerScope(SUBMISSION_ANSWERS);
  const shown = scope.keys ? search.rows.filter((g) => scope.keys!.has(`submission:${g.current.envelope_id}`)) : search.rows;

  function goToAdd() {
    setParams((p) => { p.set('view', 'add'); return p; });
  }
  function backToList() {
    setParams((p) => { p.delete('view'); return p; });
  }
  const openSubmission = (key: string) => navigate(submissionHref(key));

  async function deleteGroup(group: SubmissionRevisionGroup) {
    setBusy(true);
    try {
      await sendJson(
        `/api/assessment/submissions/${encodeURIComponent(group.teamId)}/${encodeURIComponent(group.current.envelope_id)}`,
        'DELETE',
      );
      toastSuccess(null, 'Submission deleted');
      // A deleted record has no page; its list is where the reader goes next.
      if (submissionId && findGroup([group], submissionId)) navigate('/assessment/submissions');
      load();
    } catch (err) {
      toastError(null, 'Could not delete', (err as Error).message);
    } finally {
      setBusy(false);
      setConfirmingDelete(null);
    }
  }

  async function clearSelected() {
    const targets = groups
      .filter((g) => selected.has(g.key))
      .map((g) => ({ team_id: g.teamId, envelope_id: g.current.envelope_id }));
    if (targets.length === 0) return;
    setBusy(true);
    try {
      await sendJson('/api/assessment/submissions/clear', 'POST', { items: targets, reset_assessments: true });
      toastSuccess(null, `Cleared ${targets.length} submission${targets.length === 1 ? '' : 's'}`);
      setSelected(new Set());
      load();
    } catch (err) {
      toastError(null, 'Could not clear', (err as Error).message);
    } finally {
      setBusy(false);
      setConfirmingClear(false);
    }
  }

  if (adding) {
    return (
      <Stack gap="lg" data-testid="assessment-submission-wizard">
        <PageHeader
          title="Add submissions"
          description="Upload a Microsoft Forms export, match each row to a team, then collect the linked evidence and process it."
          back={{ label: '← All submissions', to: '/assessment/submissions' }}
        />
        <AddWizard onDone={backToList} />
      </Stack>
    );
  }

  const adapter = submissionsCommandAdapter({ setQuery: search.setQuery, refresh: load, showAnswer: scope.showAnswer });

  const confirmations = (
    <>
      <ConfirmDialog
        open={confirmingDelete !== null}
        onCancel={() => setConfirmingDelete(null)}
        onConfirm={() => confirmingDelete && void deleteGroup(confirmingDelete)}
        title="Delete this submission?"
        body={confirmingDelete ? `Removes ${confirmingDelete.current.envelope_id} and its intake record.` : undefined}
        confirmLabel="Delete"
        tone="destructive"
        confirmDisabled={busy}
      />
      <ConfirmDialog
        open={confirmingClear}
        onCancel={() => setConfirmingClear(false)}
        onConfirm={() => void clearSelected()}
        title="Clear selected submissions?"
        body={`Removes ${selected.size} submission${selected.size === 1 ? '' : 's'} and resets those teams' results & follow-ups.`}
        confirmLabel="Clear"
        tone="destructive"
        confirmDisabled={busy}
      />
    </>
  );

  if (submissionId) {
    // The record level: the list is the flush list rail beside the shell's
    // rails, the content column opens with the trail and the view's title,
    // then the record (docs/layout-cascade.md rules 2–5).
    return (
      <>
        <CollectionRecordFrame
          title="Submissions"
          listTitle="Submissions"
          listLabel="submissions"
          {...(data ? { count: groups.length } : {})}
          search={{ value: search.query, onChange: search.setQuery, placeholder: 'Find a submission' }}
          groups={[
            { id: 'unprocessed', title: 'Unprocessed', count: shown.filter((g) => !g.processed).length },
            { id: 'processed', title: 'Processed', count: shown.filter((g) => g.processed).length },
          ]}
          rows={shown.map((g) => ({
            id: g.key,
            groupId: g.processed ? 'processed' : 'unprocessed',
            title: g.teamName,
            subline: `${g.formId ? `Form #${g.formId}` : 'Manual submission'} · ${revisionLabel(g.current.envelope_id)}`,
          }))}
          currentId={open?.key ?? null}
          onOpen={openSubmission}
          loading={loading && !data}
          error={error}
          onRetry={load}
          footer={<CollectionCommandHost inPlace adapter={adapter} />}
          data-testid="assessment-submission-explorer"
        >
          {open ? (
            <SubmissionRecord group={open} canManage={canManage} onDelete={() => setConfirmingDelete(open)} />
          ) : error ? (
            <ErrorState title="Couldn't load this submission" description={error} actionLabel="Retry" onAction={load} />
          ) : degraded ? (
            <UnavailableNotice error={degraded} what="the submission ledger" source="Submissions are read from the assessment database" onRetry={load} />
          ) : loading || !data ? (
            <LoadingState label="Loading submission…" />
          ) : (
            <RecordNotFound heading="Submission" title="Submission not found"
              body={`No submission has the id "${submissionId}".`}
              backLabel="All submissions" onBack={() => navigate('/assessment/submissions')} />
          )}
        </CollectionRecordFrame>
        {confirmations}
      </>
    );
  }

  return (
    <CollectionCommandPage
      data-testid="assessment-submissions"
      title="Submissions"
      description="One row per submission — the latest revision carries the status; open a row for its record and revision history."
      headerActions={canManage ? <Button size="sm" onClick={goToAdd}>Add submissions →</Button> : undefined}
    >
      <Stack gap="none" className="min-h-0 min-w-0 flex-1">
      <Stack gap="md" className="min-h-0 flex-1 overflow-auto px-[var(--ui-page-gutter)] pb-4">
      {groups.length > 0 && (
        <StatStrip
          aria-label="Submission summary"
          variant="line"
          items={[
            { label: summary.distinct_submissions === 1 ? 'submission' : 'submissions', value: summary.distinct_submissions },
            { label: summary.teams === 1 ? 'team' : 'teams', value: summary.teams },
            { label: 'unprocessed', value: summary.distinct_unprocessed, ...(summary.distinct_unprocessed > 0 ? { tone: 'accent' as const } : {}) },
            { label: summary.links_pending_total === 1 ? 'link pending' : 'links pending', value: summary.links_pending_total },
          ]}
        />
      )}
      {/* The selection replaces this row's controls in place (library
          CollectionToolbar `selection`), so checking a row never pushes the
          table down. */}
      <CollectionToolbar
        label="Submission filters"
        search={{ value: search.query, onChange: search.setQuery, placeholder: 'Search submissions', 'aria-label': 'Search submissions' }}
        summary={data ? `${shown.length} of ${groups.length} submissions` : undefined}
        onRefresh={load}
        refreshing={loading}
        {...(canManage ? {
          selection: {
            count: selected.size,
            onClear: () => setSelected(new Set()),
            actions: (
              <Button variant="danger" size="sm" onClick={() => setConfirmingClear(true)} disabled={busy}>
                Clear selected
              </Button>
            ),
          },
        } : {})}
      />

      {/* See the shared list-page loading pattern comment in QueuePage.tsx:
          `loading` (isLoading) goes true again on every post-mutation
          refresh (delete/clear), so gate on `loading && !data` — a first
          load only — and hand that to DataTable's own `loading` prop rather
          than swapping out the whole region. */}
      {error ? (
        <ErrorState title="Couldn't load submissions" description={error} actionLabel="Retry" onAction={load} />
      ) : degraded ? (
        <UnavailableNotice
          error={degraded}
          what="the submission ledger"
          source="Submissions are read from the assessment database"
          onRetry={load}
        />
      ) : !(loading && !data) && groups.length === 0 ? (
        <EmptyState
          title="No submissions ingested yet"
          body="Add a Microsoft Forms export to get started."
          actionLabel={canManage ? 'Add submissions →' : undefined}
          onAction={canManage ? goToAdd : undefined}
        />
      ) : (
        <DataTable<SubmissionRevisionGroup>
          data={shown}
          keyField={(g) => g.key}
          striped
          loading={loading && !data}
          emptyMessage={`No submission matches “${search.query.trim()}”.`}
          // Every submission ever ingested, revisions collapsed to one row
          // each — 20 is a full-page ledger's screenful, same as Runs.
          pageSize={20}
          // A row opens its submission as a page (record + revision history).
          onRowClick={(g) => openSubmission(g.key)}
          // One line per row (docs/layout-cascade.md "Tables"): the team id and
          // its name are two columns, the revision count is a pill, and the
          // row's controls are IconButtons — never a bordered button inside a cell.
          rowActions={canManage ? (g) => (
            <IconButton
              size="sm"
              icon={<TrashIcon />}
              aria-label={`Delete ${g.current.envelope_id}`}
              title="Delete submission"
              onClick={() => setConfirmingDelete(g)}
            />
          ) : undefined}
          columns={[
            // A bulk action ("Clear selected") exists only for managers, so
            // only they get the selection column. DataTable leaves a click or
            // key on a control inside the row to that control (2.442.0), so
            // ticking a box never also opens the row.
            ...(canManage
              ? [{
                  key: 'select',
                  header: '',
                  width: '40px',
                  render: (g: SubmissionRevisionGroup) => (
                    <Checkbox
                      checked={selected.has(g.key)}
                      onChange={() => setSelected((prev) => {
                        const next = new Set(prev);
                        if (next.has(g.key)) next.delete(g.key); else next.add(g.key);
                        return next;
                      })}
                      aria-label={`Select ${g.key}`}
                    />
                  ),
                }]
              : []),
            { key: 'team', header: 'Team', render: (g) => <T size="sm" weight="medium" title={g.submittedTeamName ? `submitted as “${g.submittedTeamName}”` : undefined}>{g.teamName}</T> },
            { key: 'submission', header: 'Submission', render: (g) => (g.formId ? `Form #${g.formId}` : 'Manual submission') },
            {
              key: 'revision',
              header: 'Revision',
              render: (g) => (
                <Chip
                  size="xs"
                  mono
                  tone={g.revisionCount > 1 ? 'info' : 'neutral'}
                  title={g.revisionCount > 1
                    ? `${g.revisionCount} revisions — latest ${revisionLabel(g.current.envelope_id)}; the history is on the submission's page`
                    : 'The original submission — no revisions'}
                >
                  {g.revisionCount > 1 ? `${revisionLabel(g.current.envelope_id)} · ${g.revisionCount}` : revisionLabel(g.current.envelope_id)}
                </Chip>
              ),
            },
            { key: 'submitter', header: 'Submitter', render: (g) => (g.current.submitter_name ? <RecordLink to={submissionHref(g.key)}>{g.current.submitter_name}</RecordLink> : '—') },
            {
              key: 'received',
              header: 'Received',
              numeric: true,
              // Rendered VERBATIM, not parsed. `submitted_at` is the export's
              // own "Completion time" string carried through untouched — the
              // source project declares it `submitted_at: str = ""  # from the
              // export's Completion time` and prints it as-is. Running it
              // through the Postgres timestamp parser produced NaN on every
              // row, so this column showed "—" for every submission while the
              // value sat in the payload.
              //
              // Not parsed here either, deliberately: "8/28/2026 10:15" is
              // ambiguous between M/D and D/M, and guessing a locale to render
              // a nicer "3w ago" would invent precision the field does not
              // have. Empty stays an em dash — that IS unknown.
              render: (g) => g.current.submitted_at?.trim() || '—',
            },
            {
              key: 'links',
              header: 'Links',
              numeric: true,
              render: (g) => {
                const fetched = g.current.links_total - g.current.links_pending;
                if (!g.processed && g.current.links_pending > 0) {
                  return (
                    <Chip tone="warning" size="xs" mono title={`${fetched}/${g.current.links_total} links fetched`}>
                      Fetch {g.current.links_pending}
                    </Chip>
                  );
                }
                return `${fetched}/${g.current.links_total}`;
              },
            },
            {
              key: 'status',
              header: 'Status',
              width: '128px',
              render: (g) => (
                <StatusPill state={g.processed ? 'success' : 'warning'} label={g.processed ? 'Processed' : 'Unprocessed'} size="sm" />
              ),
            },
          ]}
        />
      )}

      {confirmations}
      </Stack>
      <CollectionCommandHost adapter={adapter} />
      </Stack>
    </CollectionCommandPage>
  );
}
