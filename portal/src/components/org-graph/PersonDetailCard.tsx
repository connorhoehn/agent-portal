// Click a person on the graph → who they are: role, skills, strongest
// connections and the documents that evidence them.

import { useMemo } from 'react';
import {
  Button,
  Card,
  CardHeader,
  Chip,
  IconButton,
  Inline,
  InlineAlert,
  LoadingState,
  MetaLine,
  ScoreBarGauge,
  Stack,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { useSession } from '../../lib/auth';
import { CONNECTION_TYPE_LABELS, firstName } from './graphInsights';
import { MeterRow } from './graphOverlay';

interface ConnectionEntry {
  type: string;
  strength: number;
  otherPerson: { id: string; name: string; title: string } | null;
}

interface PersonDetailResponse {
  id: string;
  name: string;
  title: string;
  department: string;
  skills: string[];
  influenceScore: number;
  scoredAt: string | null;
  connections: ConnectionEntry[];
}

interface EvidenceResponse {
  documents: Array<{
    id: string;
    title: string;
    source: string;
    sourceUri: string | null;
    ingestedAt: string | null;
    mentionCount: number;
  }>;
}

export interface PersonDetailCardProps {
  personId: string;
  onClose: () => void;
  /** Click a connection → add that person to the graph selection. */
  onFocusPerson: (id: string) => void;
  /** "Ask agent" → open the chat pre-seeded with this person. */
  onAsk: (id: string) => void;
}

export function PersonDetailCard({ personId, onClose, onFocusPerson, onAsk }: PersonDetailCardProps) {
  // Influence/scored-at are people-analytics numbers — the same data class the
  // ViewLeaderboard gate keeps behind /iq/scores. The graph roster endpoint
  // happens to carry them, but printing an influence figure on every person
  // card gave the whole org the HR read on each other; an SME looking for help
  // gets the person's skills, connections and evidence instead.
  const { session } = useSession();
  const showAnalytics =
    session?.role === 'org-leader' || session?.role === 'hr-admin' || session?.role === 'admin';

  const { data, isLoading, error } = useFetch<PersonDetailResponse>(
    `/api/graph/people/${encodeURIComponent(personId)}`,
  );
  const { data: evidence } = useFetch<EvidenceResponse>(
    `/api/graph/people/${encodeURIComponent(personId)}/evidence`,
  );
  const evidenceDocs = evidence?.documents ?? [];

  const topConnections = useMemo(() => {
    if (!data) return [] as ConnectionEntry[];
    return [...data.connections]
      .filter((c) => c.otherPerson)
      .sort((a, b) => b.strength - a.strength)
      .slice(0, 8);
  }, [data]);

  const maxStrength = Math.max(...topConnections.map((c) => c.strength), 0.001);

  return (
    <Card
      padding="md"
      className="absolute right-3 top-3 z-[60] max-h-[calc(100%-24px)] w-[300px] overflow-y-auto shadow-lg"
    >
      <Stack gap="md">
        <Inline gap="sm" justify="between" align="start" wrap={false}>
          <Stack gap="none" className="min-w-0 flex-1">
            {isLoading && <LoadingState label="Loading…" spinnerSize="sm" />}
            {error && <InlineAlert tone="error">Failed to load person</InlineAlert>}
            {data && (
              <CardHeader
                title={data.name}
                subtitle={data.department ? `${data.title} · ${data.department}` : data.title}
              />
            )}
          </Stack>
          <IconButton aria-label="Close details" size="sm" variant="ghost" onClick={onClose}>
            ✕
          </IconButton>
        </Inline>

        {data && (
          <>
            {/* One line rather than a three-tile stat grid: in a 300px panel
                the grid was wider than the numbers in it, and MetaLine drops
                the analytics entries (and their separators) for viewers who
                are not allowed to see them. */}
            <MetaLine
              size="sm"
              items={[
                showAnalytics && `influence ${data.influenceScore.toFixed(2)}`,
                `${data.connections.length} connections`,
                showAnalytics && data.scoredAt ? `scored ${data.scoredAt.slice(0, 10)}` : null,
              ]}
            />

            {data.skills.length > 0 && (
              <Stack gap="xs">
                <CardHeader title="Skills" />
                <Inline gap="xs" wrap>
                  {data.skills.map((s) => <Chip key={s} tone="info" size="xs">{s}</Chip>)}
                </Inline>
              </Stack>
            )}

            {topConnections.length > 0 && (
              <Stack gap="xs">
                <CardHeader title="Strongest connections" />
                <Stack gap="none">
                  {topConnections.map((c, i) => (
                    <MeterRow
                      key={`${c.otherPerson!.id}-${c.type}-${i}`}
                      onClick={() => onFocusPerson(c.otherPerson!.id)}
                      title={`Add ${c.otherPerson!.name} to selection`}
                      label={c.otherPerson!.name}
                      note={CONNECTION_TYPE_LABELS[c.type] ?? c.type}
                      meter={(
                        <ScoreBarGauge
                          value={c.strength / maxStrength}
                          tone="info"
                          size="sm"
                          showLabel={false}
                          ariaLabel={`Connection strength ${c.strength.toFixed(2)}`}
                        />
                      )}
                    />
                  ))}
                </Stack>
              </Stack>
            )}

            {evidenceDocs.length > 0 && (
              <Stack gap="xs">
                <CardHeader title="Evidence" subtitle={`${evidenceDocs.length} documents`} />
                <Stack gap="xs">
                  {evidenceDocs.slice(0, 6).map((doc) => (
                    <Inline key={doc.id} gap="xs" align="center" wrap={false}>
                      <Chip size="xs" uppercase>{doc.source || 'doc'}</Chip>
                      <span title={doc.title} className="min-w-0 flex-1 truncate text-[11px]">
                        {doc.title}
                      </span>
                      {doc.mentionCount > 1 && (
                        <span className="shrink-0 text-[10px] tabular-nums text-text-tertiary">
                          ×{doc.mentionCount}
                        </span>
                      )}
                    </Inline>
                  ))}
                </Stack>
              </Stack>
            )}

            <Button variant="primary" size="sm" fullWidth onClick={() => onAsk(data.id)}>
              Ask agent about {firstName(data.name)} →
            </Button>
          </>
        )}
      </Stack>
    </Card>
  );
}
