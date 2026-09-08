// Team → Evidence & Intake tab: a text/link intake form plus the read-only
// lineage ledger for a team. Reproduces the working slice of the source's
// EvidenceIntake.tsx (touchpoint / text intake) — the transcript & document
// drop paths stay file-path callouts, exactly as upstream, since neither app
// has a real upload pipeline behind them yet.

import { useState } from 'react';
import {
  Button,
  Card,
  Chip,
  DataTable,
  FileUploadDrop,
  FormField,
  Inline,
  Input,
  SectionLabel,
  Stack,
  Textarea,
  type DataTableColumn,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../../hooks/useFetch';
import { toastError, toastSuccess } from '../../../lib/toastStore';
import { useCapabilities } from '../../../lib/capabilities';
import { fmtDate, type ProvenanceLedgerResponse, type SourceType } from '../types';
import { inputWiring } from '../assessmentFormat';

interface EvidenceIntakeProps {
  teamId: string;
}

type LedgerItem = ProvenanceLedgerResponse['items'][number];

const SOURCE_LABEL: Record<SourceType, string> = {
  transcript: 'Transcript',
  codebase: 'Repo URL',
  document: 'Document',
  screenshot: 'Screenshot',
  teams_chat: 'Teams chat',
  web: 'Web link',
  survey: 'Survey',
  touchpoint: 'Touchpoint',
};

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Log a 1:1 / discussion note — the one intake path the source app fully
 *  wires up. POSTs to `/api/assessment/teams/:id/intake/text`. */
function TouchpointForm({ teamId, onSaved }: { teamId: string; onSaved: () => void }) {
  const { can } = useCapabilities();
  const [recordedBy, setRecordedBy] = useState('');
  const [meetingDate, setMeetingDate] = useState(todayIso());
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  if (!can('ScoreAssessment')) return null;

  const canSubmit = recordedBy.trim() !== '' && text.trim() !== '' && !busy;

  const submit = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/assessment/teams/${encodeURIComponent(teamId)}/intake/text`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source_type: 'touchpoint',
          text,
          title: title || undefined,
          captured_at: meetingDate || undefined,
          captured_by: recordedBy,
        }),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      toastSuccess(null, 'Touchpoint note saved.');
      setRecordedBy('');
      setTitle('');
      setText('');
      setMeetingDate(todayIso());
      onSaved();
    } catch (err) {
      toastError(null, 'Failed to save touchpoint note', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card padding="md">
      <SectionLabel>Log a 1:1 / discussion note</SectionLabel>
      <Stack gap="none" className="mt-1 text-xs text-text-secondary">
        Capture a quick note from a 1:1 assessment review or team discussion — paste a transcript or write a summary.
      </Stack>
      <Stack gap="sm" className="mt-3">
        <FormField label="Recorded by" required>
          {(wiring) => (
            <Input {...inputWiring(wiring)} type="text" value={recordedBy} onChange={(e) => setRecordedBy(e.target.value)} />
          )}
        </FormField>
        <FormField label="Meeting date">
          {(wiring) => (
            <Input {...inputWiring(wiring)} type="date" value={meetingDate} onChange={(e) => setMeetingDate(e.target.value)} />
          )}
        </FormField>
        <FormField label="Title" hint="Optional">
          {(wiring) => (
            <Input {...inputWiring(wiring)} type="text" value={title} onChange={(e) => setTitle(e.target.value)} />
          )}
        </FormField>
        <FormField label="Note">
          {(wiring) => (
            <Textarea {...inputWiring(wiring)} minRows={5} autoResize placeholder="Paste transcript or write a discussion summary…"
              value={text} onChange={(e) => setText(e.target.value)} />
          )}
        </FormField>
        <Stack gap="none" className="text-xs text-text-tertiary">
          Personal conversation — participant names will be scrubbed to role labels during processing; your name is
          kept as the recorder. Saved to the team's project folder (repo) with provenance.
        </Stack>
        <Inline>
          <Button variant="primary" size="sm" disabled={!canSubmit} onClick={submit}>
            {busy ? 'Saving…' : 'Save note'}
          </Button>
        </Inline>
      </Stack>
    </Card>
  );
}

/** File / document drop — real intake through the shared FileUploadDrop
 *  primitive, POSTing to the same text-intake route (base64-free, so a
 *  reasonably small document rides as text) rather than the workspace
 *  filesystem paths the source app callouts out to. */
function DocumentDropForm({ teamId, onSaved }: { teamId: string; onSaved: () => void }) {
  const { can } = useCapabilities();
  const [busy, setBusy] = useState(false);

  if (!can('ScoreAssessment')) return null;

  const onFiles = async (files: File[]) => {
    const file = files[0];
    if (!file) return;
    setBusy(true);
    try {
      const text = await file.text();
      const res = await fetch(`/api/assessment/teams/${encodeURIComponent(teamId)}/intake/text`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source_type: 'document', text, title: file.name, captured_by: 'upload' }),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      toastSuccess(null, `${file.name} ingested.`);
      onSaved();
    } catch (err) {
      toastError(null, 'Failed to ingest document', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card padding="md">
      <SectionLabel>Document drop</SectionLabel>
      <Stack gap="none" className="mt-1 mb-3 text-xs text-text-secondary">
        Drop a plain-text or markdown artifact (design doc, runbook, postmortem) to link as evidence.
      </Stack>
      <FileUploadDrop
        accept=".md,.txt,.json"
        multiple={false}
        disabled={busy}
        onFiles={onFiles}
        onError={(msg) => toastError(null, 'Upload failed', msg)}
        label={busy ? 'Ingesting…' : 'Drop a document, or click to choose one'}
      />
    </Card>
  );
}

const LEDGER_COLUMNS: DataTableColumn<LedgerItem>[] = [
  {
    key: 'source_type',
    header: 'Source',
    render: (item) => <Chip size="xs" uppercase>{SOURCE_LABEL[item.source_type] ?? item.source_type}</Chip>,
  },
  {
    key: 'name',
    header: 'Item',
    render: (item) => <strong className="font-semibold text-text-primary">{item.name}</strong>,
  },
  {
    key: 'captured_at',
    header: 'When',
    render: (item) => fmtDate(item.captured_at),
  },
  {
    key: 'captured_by',
    header: 'Via',
    render: (item) => item.captured_by || '—',
  },
  {
    key: 'coverage',
    header: 'Coverage',
    render: (item) => (
      <>
        {item.evidence_count} evidence item{item.evidence_count === 1 ? '' : 's'}
        {item.dimensions_touched.length > 0 ? ` · ${item.dimensions_touched.length} dimension${item.dimensions_touched.length === 1 ? '' : 's'}` : ''}
      </>
    ),
  },
  {
    key: 'source_uri',
    header: 'Path',
    render: (item) => <Chip size="xs" mono tone="neutral" title={item.source_uri}>{item.source_uri}</Chip>,
  },
];

export function EvidenceIntake({ teamId }: EvidenceIntakeProps) {
  const { data, isLoading, error, refresh } = useFetch<ProvenanceLedgerResponse>(
    `/api/assessment/teams/${encodeURIComponent(teamId)}/provenance`,
  );
  const items = data?.items ?? [];

  return (
    <Stack gap="lg">
      <Card padding="md">
        <SectionLabel>Add evidence</SectionLabel>
        <Stack gap="none" className="mt-1 mb-4 text-sm text-text-secondary">Where new evidence for this team comes from.</Stack>
        <Inline gap="md" wrap align="start">
          <Stack gap="none" className="min-w-[280px] flex-1">
            <TouchpointForm teamId={teamId} onSaved={refresh} />
          </Stack>
          <Stack gap="none" className="min-w-[280px] flex-1">
            <DocumentDropForm teamId={teamId} onSaved={refresh} />
          </Stack>
        </Inline>
      </Card>

      <Card padding="md">
        <SectionLabel>Lineage ledger</SectionLabel>
        <Stack gap="none" className="mt-1 mb-4 text-sm text-text-secondary">
          Every input ingested for this team, with provenance back to its source.
        </Stack>
        <DataTable<LedgerItem>
          data={items}
          columns={LEDGER_COLUMNS}
          keyField={(item) => item.provenance_id}
          loading={isLoading}
          emptyMessage={error ? 'Could not load the ledger.' : 'No evidence ingested yet. Add evidence above to start this team’s lineage ledger.'}
          frameless
        />
      </Card>
    </Stack>
  );
}
