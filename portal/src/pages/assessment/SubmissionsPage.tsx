// Submissions — the daily intake surface. One row per submission (its current
// revision carries the status; earlier revisions are kept for history behind it), plus
// the add-wizard: Drop -> Preview & match -> Fetch links -> Run prompt.
//
// Structure mirrors the source app's SubmissionsList.tsx / SubmissionsWizard.tsx
// (`agentic-assessment-accelerator/ui/src/components/submissions/`), re-expressed on
// this library's DataTable/Drawer/Wizard rather than a hand-rolled table and stepper.
// See docs/assessment-tenant.md "SubmissionsPage.tsx" for the exact contract.

import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import {
  Button,
  Checkbox,
  Chip,
  ConfirmDialog,
  DataTable,
  Drawer,
  EmptyState,
  ErrorState,
  InlinePlaceholder,
  MetaLine,
  PageHeader,
  Stack,
  StatStrip,
  StatusPill,
  Toolbar,
  ToolbarLabel,
  Wizard,
} from '@connorhoehnslalom/ui-components/shared';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { useCapabilities } from '../../lib/capabilities';
import { useFetch } from '../../hooks/useFetch';
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

export default function SubmissionsPage() {
  const { can, ready } = useCapabilities();
  const canManage = ready && can('ManageSubmissions');
  const [params, setParams] = useSearchParams();
  const adding = params.get('view') === 'add';

  // `null` while the add wizard is open — the list underneath is stale
  // anyway, and refetching it mid-wizard would just be discarded on return.
  const { data, isLoading: loading, error, degraded, refresh: load } = useFetch<SubmissionsListResponse>(
    adding ? null : '/api/assessment/submissions',
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmingDelete, setConfirmingDelete] = useState<SubmissionRevisionGroup | null>(null);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [historyGroup, setHistoryGroup] = useState<SubmissionRevisionGroup | null>(null);
  const [busy, setBusy] = useState(false);

  // Roster names for `resolveTeamName` — a hand-matched row's team_id must
  // render the matched team's real name, not the submitter's own typed text.
  const { teams } = useTeams();
  const teamsById = useMemo(() => new Map(teams.map((t) => [t.id, t.name])), [teams]);

  const groups = useMemo(
    () => groupSubmissions(envelopesToListItems(data?.envelopes ?? []), undefined, teamsById),
    [data, teamsById],
  );
  // The strip's numbers are derived from the grouped rows — the listing sends
  // no summary block, and reading one that wasn't there hid the strip entirely.
  const summary = useMemo(() => ({
    distinct_submissions: groups.length,
    teams: new Set(groups.map((g) => g.teamId)).size,
    distinct_unprocessed: groups.filter((g) => !g.processed).length,
    links_pending_total: groups.reduce((n, g) => n + (g.current.links_pending ?? 0), 0),
  }), [groups]);

  function goToAdd() {
    setParams((p) => { p.set('view', 'add'); return p; });
  }
  function backToList() {
    setParams((p) => { p.delete('view'); return p; });
  }

  async function deleteGroup(group: SubmissionRevisionGroup) {
    setBusy(true);
    try {
      await sendJson(
        `/api/assessment/submissions/${encodeURIComponent(group.teamId)}/${encodeURIComponent(group.current.envelope_id)}`,
        'DELETE',
      );
      toastSuccess(null, 'Submission deleted');
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
      <Stack gap="lg">
        <PageHeader
          title="Add submissions"
          description="Upload a Microsoft Forms export, match each row to a team, then collect the linked evidence and process it."
          back={{ label: '← All submissions', to: '/assessment/submissions' }}
        />
        <AddWizard onDone={backToList} />
      </Stack>
    );
  }

  return (
    <Stack gap="lg">
      <PageHeader
        title="Submissions"
        description="One row per submission — the latest revision carries the status; earlier revisions are kept for history."
        actions={canManage ? <Button size="sm" onClick={goToAdd}>Add submissions →</Button> : undefined}
      />

      {groups.length > 0 && (
        <StatStrip
          items={[
            { label: 'Submissions', value: summary.distinct_submissions },
            { label: 'Teams', value: summary.teams },
            { label: 'Unprocessed', value: summary.distinct_unprocessed, tone: 'accent' },
            { label: 'Links pending', value: summary.links_pending_total },
          ]}
        />
      )}

      {canManage && selected.size > 0 && (
        <Toolbar
          aria-label="Selection actions"
          end={
            <Button variant="danger" size="sm" onClick={() => setConfirmingClear(true)} disabled={busy}>
              Clear selected
            </Button>
          }
        >
          <ToolbarLabel>{selected.size} selected</ToolbarLabel>
        </Toolbar>
      )}

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
          data={groups}
          keyField={(g) => g.key}
          striped
          searchable
          loading={loading && !data}
          columns={[
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
            {
              key: 'team',
              header: 'Team',
              // The rows are revision groups, not flat records — without an
              // accessor the search box filters `String(row.team)`, which is
              // "undefined" for every row, so nothing ever matched.
              getFilterText: (g) => `${g.teamId} ${g.teamName} ${g.submittedTeamName ?? ''}`,
              render: (g) => (
                <Stack gap="none">
                  <strong className="font-semibold">{g.teamId}</strong>
                  {/* teamName is the matched team's real name (resolveTeamName in
                      secondaryFormat.ts); submittedTeamName only appears when a
                      hand-matched row's submitted text actually differs from it. */}
                  <MetaLine
                    size="xs"
                    items={g.submittedTeamName ? [g.teamName, `submitted as "${g.submittedTeamName}"`] : [g.teamName]}
                  />
                </Stack>
              ),
            },
            {
              key: 'submission',
              header: 'Submission',
              getFilterText: (g) => `${g.formId ? `Form #${g.formId}` : 'Manual submission'} ${g.current.envelope_id}`,
              render: (g) => (
                <Stack gap="xs">
                  {g.formId ? `Form #${g.formId}` : 'Manual submission'}
                  {g.revisionCount > 1 && (
                    <Button variant="ghost" size="sm" onClick={() => setHistoryGroup(g)}>
                      {g.revisionCount} revisions — latest {revisionLabel(g.current.envelope_id)}
                    </Button>
                  )}
                </Stack>
              ),
            },
            // getFilterText dropped: the render already returns the same string
            // DataTable's rendered-text search fallback would extract.
            { key: 'submitter', header: 'Submitter', render: (g) => g.current.submitter_name || '—' },
            { key: 'received', header: 'Received', render: (g) => formatRelativeTime(g.current.submitted_at) },
            {
              key: 'status',
              header: 'Status',
              getFilterText: (g) => (g.processed ? 'Processed' : 'Unprocessed'),
              render: (g) => (
                <StatusPill state={g.processed ? 'success' : 'warning'} label={g.processed ? 'Processed' : 'Unprocessed'} size="sm" />
              ),
            },
            {
              key: 'links',
              header: 'Links',
              render: (g) => {
                const fetched = g.current.links_total - g.current.links_pending;
                if (!g.processed && g.current.links_pending > 0) {
                  return (
                    <Chip tone="warning" size="xs" mono title={`${fetched}/${g.current.links_total} links fetched`}>
                      Fetch {g.current.links_pending} link{g.current.links_pending === 1 ? '' : 's'}
                    </Chip>
                  );
                }
                return <MetaLine size="xs" items={[`${fetched}/${g.current.links_total}`]} />;
              },
            },
            ...(canManage
              ? [{
                  key: 'actions',
                  header: '',
                  render: (g: SubmissionRevisionGroup) => (
                    <Button size="sm" variant="secondary" onClick={() => setConfirmingDelete(g)}>
                      Delete
                    </Button>
                  ),
                }]
              : []),
          ]}
        />
      )}

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
      <Drawer open={historyGroup !== null} onClose={() => setHistoryGroup(null)} title="Revision history">
        {historyGroup && (
          <DataTable<{ envelope_id: string; ingested_at: string; current: boolean }>
            data={[historyGroup.current, ...historyGroup.superseded].map((rev, i) => ({ ...rev, current: i === 0 }))}
            keyField={(rev) => rev.envelope_id}
            columns={[
              {
                key: 'revision',
                header: 'Revision',
                render: (rev) => (
                  <Stack gap="none">
                    <strong className="font-semibold">{revisionLabel(rev.envelope_id)}</strong>
                    <MetaLine size="xs" items={[rev.envelope_id]} />
                  </Stack>
                ),
              },
              {
                key: 'status',
                header: 'Status',
                render: (rev) => (rev.current ? <StatusPill state="info" label="Current" size="sm" /> : <Chip tone="neutral" size="xs">Superseded</Chip>),
              },
              { key: 'when', header: 'When', render: (rev) => formatRelativeTime(rev.ingested_at) },
            ]}
          />
        )}
      </Drawer>
    </Stack>
  );
}
