// "How it was assessed" — the scoring-log sidecars an agent run writes
// (`GET /teams/:id/scoring-logs` -> `GET .../scoring-logs/:stamp`). A list of
// runs that touched this team's scores, drilling into one run's full
// reasoning: per-dimension suggested level, confidence, rationale, and the
// evidence excerpts it was drawn from.

import { useEffect, useState } from 'react';
import {
  Button,
  Card,
  CardHeader,
  Chip,
  DataTable,
  Drawer,
  EmptyState,
  Inline,
  InlineAlert,
  LoadingState,
  MetaLine,
  Stack,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../../hooks/useFetch';
import { LevelBadge } from './LevelBadge';

interface ScoringLogSummary {
  stamp: string;
  source: string;
  envelope_id: string | null;
}

interface ScoringLogEntry {
  dimension_id: string;
  is_na: boolean;
  suggested_level: number | null;
  confidence: string;
  rationale: string;
  evidence_excerpts: string[];
  follow_up_questions: string[];
}

interface ScoringLog {
  team_id: string;
  envelope_id: string | null;
  stamp: string;
  source: string;
  scores: ScoringLogEntry[];
}

interface ScoringLogsDrawerProps {
  open: boolean;
  onClose: () => void;
  teamId: string;
  /** TeamScorecard already has the team's dimension list loaded. */
  dimensionTitle: (dimensionId: string) => string;
}

export function ScoringLogsDrawer({ open, onClose, teamId, dimensionTitle }: ScoringLogsDrawerProps) {
  const [selectedStamp, setSelectedStamp] = useState<string | null>(null);
  useEffect(() => { if (!open) setSelectedStamp(null); }, [open]);

  const { data: list, isLoading: listLoading, error: listError } = useFetch<{ logs: ScoringLogSummary[] }>(
    open ? `/api/assessment/teams/${encodeURIComponent(teamId)}/scoring-logs` : null,
  );
  const { data: log, isLoading: logLoading, error: logError } = useFetch<ScoringLog>(
    open && selectedStamp ? `/api/assessment/teams/${encodeURIComponent(teamId)}/scoring-logs/${encodeURIComponent(selectedStamp)}` : null,
  );

  return (
    <Drawer open={open} onClose={onClose} title="How it was assessed" subtitle={teamId} width={560}>
      {selectedStamp ? (
        <Stack gap="md">
          <Button variant="ghost" size="sm" onClick={() => setSelectedStamp(null)}>← All runs</Button>
          {logLoading ? (
            <LoadingState label="Loading scoring log…" />
          ) : logError || !log ? (
            <EmptyState title="Couldn't load this log" body={logError ?? 'Scoring log not found.'} />
          ) : (
            <Stack gap="md">
              <MetaLine
                size="xs"
                tone="secondary"
                items={[`Source: ${log.source}`, log.envelope_id ? `Envelope ${log.envelope_id}` : 'No submission envelope']}
              />
              {log.scores.map((s) => (
                <Card key={s.dimension_id} padding="sm">
                  <CardHeader title={dimensionTitle(s.dimension_id)} />
                  <Inline gap="xs" wrap className="mt-1.5">
                    {s.is_na ? <Chip size="xs" tone="neutral">N/A</Chip> : <LevelBadge level={s.suggested_level} size="xs" />}
                    <Chip size="xs" tone="info">{s.confidence}</Chip>
                  </Inline>
                  <Stack gap="none" className="mt-2 text-xs text-text-secondary">{s.rationale}</Stack>
                  {s.evidence_excerpts.length > 0 && (
                    <Stack gap="xs" className="mt-2">
                      <CardHeader title="Evidence cited" />
                      {s.evidence_excerpts.map((excerpt, i) => (
                        <MetaLine key={i} size="xs" items={[excerpt]} />
                      ))}
                    </Stack>
                  )}
                </Card>
              ))}
            </Stack>
          )}
        </Stack>
      ) : listLoading ? (
        <LoadingState label="Loading scoring runs…" />
      ) : listError ? (
        <InlineAlert tone="error">{listError}</InlineAlert>
      ) : !list || list.logs.length === 0 ? (
        <EmptyState
          title="No scoring runs yet"
          body="Launch a scoring command from Activity — its reasoning log will show up here."
        />
      ) : (
        <DataTable<ScoringLogSummary>
          data={list.logs}
          keyField={(l) => l.stamp}
          striped
          columns={[
            {
              key: 'stamp',
              header: 'Run',
              // A real Button, not just a row onClick — see TeamList.tsx's
              // identical note on DataTable's keyboard gap.
              render: (l) => (
                <Button variant="ghost" size="sm" className="font-mono text-xs" onClick={() => setSelectedStamp(l.stamp)}>
                  {l.stamp}
                </Button>
              ),
            },
            { key: 'source', header: 'Source', render: (l) => <Chip size="xs">{l.source}</Chip> },
            { key: 'envelope_id', header: 'Envelope', render: (l) => l.envelope_id ?? '—' },
          ]}
        />
      )}
    </Drawer>
  );
}
