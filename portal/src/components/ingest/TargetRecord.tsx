// One crawl target, opened as a page (`/admin/ingest/crawl/:targetId`) beside
// the targets list rail (docs/layout-cascade.md, "Records open as pages;
// selections stay put"): what it crawls, its settings edited in place with
// Save / Discard, Run now and Delete as the record's actions (Delete keeps its
// confirmation), and its recent runs, each of which opens the run's own page.
import { useState } from 'react';
import { useNavigate } from 'react-router';
import {
  Button,
  Chip,
  ConfirmDialog,
  DataTable,
  DetailHeader,
  DetailSection,
  Inline,
  KeyValue,
  Stack,
  type DataTableColumn,
} from '@connorhoehn/ui-components/shared';
import { absoluteTime, durationLabel } from '../../lib/relativeTime';
import { sendJson, writeJson } from '../../lib/writeJson';
import { toastError, toastSuccess } from '../../lib/toastStore';
import { crawlRunHref } from '../../pages/ingest/ingestCommands';
import { CRAWL_STATUS_TONE, durationOf, formatCost } from './types';
import type { CrawlSession, CrawlTarget } from './types';
import { TargetForm, type TargetDraft } from './TargetForm';

const RUN_COLUMNS: DataTableColumn<CrawlSession>[] = [
  { key: 'startedAt', header: 'Started', render: (s) => absoluteTime(s.startedAt) },
  { key: 'status', header: 'Status', width: '112px', render: (s) => <Chip tone={CRAWL_STATUS_TONE[s.status]} size="xs">{s.status}</Chip> },
  { key: 'duration', header: 'Duration', render: (s) => durationLabel(durationOf(s)) },
  { key: 'pages', header: 'Pages', numeric: true, render: (s) => `${s.pages.length} / ${s.maxPages}` },
  { key: 'cost', header: 'Cost', numeric: true, render: (s) => formatCost(s.estimatedCostUsd) },
];

/** The fields the form edits — a change to any of them (a save, another tab) re-seeds the form. */
function settingsKey(t: CrawlTarget): string {
  return JSON.stringify([t.label, t.startUrl, t.mode, t.maxPages, t.sameOriginOnly, t.includePattern, t.cronExpr, t.enabled]);
}

export function TargetRecord({
  target,
  runs,
  canManage,
  onChanged,
  onDeleted,
}: {
  target: CrawlTarget;
  /** This target's runs, newest first. */
  runs: CrawlSession[];
  /** ManageIngest — without it the record is read-only (no form, no actions). */
  canManage: boolean;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const navigate = useNavigate();
  const [starting, setStarting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Discard re-seeds the form from the stored target.
  const [discards, setDiscards] = useState(0);

  async function save(draft: TargetDraft) {
    await sendJson(`/api/ingest/crawl-targets/${encodeURIComponent(target.id)}`, 'PATCH', draft);
    toastSuccess(null, 'Target saved', `"${draft.label}" is updated.`);
    onChanged();
  }

  async function runNow() {
    setStarting(true);
    const res = await writeJson<{ session: CrawlSession }>(`/api/ingest/crawl-targets/${encodeURIComponent(target.id)}/run`, 'POST');
    setStarting(false);
    onChanged();
    if (!res.ok || !res.data?.session) {
      toastError(null, 'Could not start the crawl', res.error ?? undefined);
      return;
    }
    toastSuccess(null, 'Crawl started', `"${target.label}" is running.`);
    void navigate(crawlRunHref(res.data.session.id));
  }

  async function remove() {
    const res = await writeJson(`/api/ingest/crawl-targets/${encodeURIComponent(target.id)}`, 'DELETE');
    if (!res.ok) {
      toastError(null, 'Could not delete the target', res.error ?? undefined);
      return;
    }
    toastSuccess(null, 'Target deleted', `"${target.label}" is gone; its run history is kept.`);
    onDeleted();
  }

  return (
    <Stack gap="md" data-testid="ingest-target-record">
      <DetailHeader
        title={target.label}
        badge={<Chip tone={target.enabled ? 'success' : 'neutral'} size="xs">{target.enabled ? 'enabled' : 'paused'}</Chip>}
        description={`${target.mode} · ${target.startUrl}`}
        {...(canManage ? {
          aside: (
            <Inline gap="sm" align="center" justify="end" wrap={false}>
              <Button size="sm" variant="primary" disabled={starting} onClick={() => void runNow()} data-testid="ingest-target-run">
                {starting ? 'Starting…' : 'Run now'}
              </Button>
              <Button size="sm" variant="danger" onClick={() => setConfirmDelete(true)} data-testid="ingest-target-delete">Delete</Button>
            </Inline>
          ),
          asideWidth: 200,
        } : {})}
      />

      {/* Runs first (table-first density): the target's facts and a manager's settings form follow them. */}
      <DetailSection title="Recent runs" hint={`${runs.length}`}>
        <DataTable
          frameless
          data={runs}
          columns={RUN_COLUMNS}
          keyField={(s) => s.id}
          onRowClick={(s) => void navigate(crawlRunHref(s.id))}
          emptyMessage={canManage ? 'No run of this target yet — start one with Run now.' : 'No run of this target yet.'}
          data-testid="ingest-target-runs"
        />
      </DetailSection>

      <KeyValue
        layout="row"
        items={[
          { label: 'Start URL', value: target.startUrl, mono: true },
          { label: 'Mode', value: target.mode },
          { label: 'Max pages', value: String(target.maxPages) },
          { label: 'Same origin only', value: target.sameOriginOnly ? 'yes' : 'no' },
          { label: 'Include pattern', value: target.includePattern ?? 'none', mono: Boolean(target.includePattern), muted: !target.includePattern },
          { label: 'Schedule', value: target.cronExpr ?? 'on-demand', mono: Boolean(target.cronExpr), muted: !target.cronExpr },
          { label: 'Next run', value: target.nextRunAt ? absoluteTime(target.nextRunAt) : '—', muted: !target.nextRunAt },
          { label: 'Last run', value: target.lastRunAt ? `${absoluteTime(target.lastRunAt)}${target.lastStatus ? ` · ${target.lastStatus}` : ''}` : 'never', muted: !target.lastRunAt },
          { label: 'Created', value: absoluteTime(target.createdAt) },
        ]}
      />

      {canManage && (
        <DetailSection title="Settings" description="Edit the target in place. Discard puts back what is saved." data-testid="ingest-target-settings">
          <TargetForm
            key={`${settingsKey(target)}:${discards}`}
            existing={target}
            onSave={save}
            onCancel={() => setDiscards((n) => n + 1)}
            cancelLabel="Discard"
            submitLabel="Save"
          />
        </DetailSection>
      )}

      <ConfirmDialog
        open={confirmDelete}
        onConfirm={() => { setConfirmDelete(false); void remove(); }}
        onCancel={() => setConfirmDelete(false)}
        tone="destructive"
        title={`Delete "${target.label}"?`}
        body="Run history is preserved. This cannot be undone."
      />
    </Stack>
  );
}
