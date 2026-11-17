// A candidate's consent records on their profile (docs/interviews-tenant-plan.md decision 5, rows I6.1 and I6.2): per round,
// the notice given, when it was answered and, for the recruiter and the admin, the three answers; for the opening's hiring
// manager only that a notice was given. The recruiter can export what Milo showed for each finished round. The server decides
// what each role reads; the table follows what comes back.
import { Button, DataTable, DetailSection, LoadingState, Stack, T, type DataTableColumn } from '@connorhoehn/ui-components/shared';
import { useState } from 'react';
import { useFetch } from '../../hooks/useFetch';
import { plural } from '../../lib/plural';
import { relativeTime } from '../../lib/relativeTime';
import { EMPTY_LINE, consentsPath, downloadExport, noticeLabel, yesNo, type ConsentRecordItem, type ConsentRecords } from '../../lib/interviewsRecords';
import { Dash } from './interviewsCells';

const answerCell = (pick: (r: ConsentRecordItem) => { answer: boolean; at: string } | undefined) => (r: ConsentRecordItem) => {
  const a = pick(r);
  return a ? <T size="sm" title={new Date(a.at).toLocaleString()}>{yesNo(a.answer)}</T> : <Dash />;
};

export default function ProfileConsents({ candidateId }: { candidateId: string }) {
  const { data } = useFetch<ConsentRecords>(candidateId ? consentsPath(candidateId) : null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const items = data?.items ?? null;
  const answers = data?.reads === 'answers';
  const exports = !!items?.some((i) => i.exportable !== undefined);

  const exportRound = async (interviewId: string) => {
    setBusy(interviewId); setError(null);
    const out = await downloadExport(interviewId);
    setBusy(null);
    if (!out.ok) setError(out.error);
  };

  const columns: DataTableColumn<ConsentRecordItem>[] = [
    { key: 'round', header: 'Round', render: (r) => <T size="sm" data-testid="interviews-consent-round">{r.roundName}</T> },
    { key: 'notice', header: 'Notice', render: (r) => (r.answered ? <T size="sm" title={r.noticeVersion ?? undefined}>{noticeLabel(r.noticeVersion)}</T> : <Dash />) },
    { key: 'at', header: 'Answered', numeric: true, width: '120px', render: (r) => (r.answeredAt ? <T size="sm" title={new Date(r.answeredAt).toLocaleString()}>{relativeTime(r.answeredAt)}</T> : <Dash />) },
    ...(answers ? [
      { key: 'recording', header: 'Recording', width: '96px', render: answerCell((r) => r.answers?.recording) },
      { key: 'transcript', header: 'Transcript', width: '96px', render: answerCell((r) => r.answers?.transcription) },
      { key: 'milo', header: 'Milo', width: '72px', render: answerCell((r) => r.answers?.milo) },
    ] : []),
    ...(exports ? [{
      key: 'export', header: '', width: '200px',
      render: (r: ConsentRecordItem) => (r.exportable
        ? <Button size="sm" variant="ghost" disabled={busy === r.interviewId} data-testid="interviews-milo-export" onClick={() => void exportRound(r.interviewId)}>Export what Milo showed</Button>
        : null),
    }] : []),
  ];

  return (
    <Stack gap="md" className="px-[var(--ui-page-gutter)]" data-testid="interviews-profile-consents-section">
      <DetailSection variant="heading" title="Consents" hint={items ? plural(items.length, 'round') : undefined}>
        {items === null
          ? <LoadingState label="Loading consents…" />
          : (
            <>
              <DataTable narrow data-testid="interviews-profile-consents" aria-label="Consents" data={items} columns={columns}
                keyField={(r) => r.interviewId} staticRows="Each round's consent notice, read in place" emptyMessage={EMPTY_LINE} />
              {error && <T size="sm" tone="danger" data-testid="interviews-milo-export-error">{error}</T>}
            </>
          )}
      </DetailSection>
    </Stack>
  );
}
