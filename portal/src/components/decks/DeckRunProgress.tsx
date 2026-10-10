// A run's live status, drawn with library status composites. Used on the deck
// pages (assessment, pipelines) while a generation or agent revision is in flight.

import { Banner, Inline, Spinner, StatusPill, Text } from '@connorhoehnslalom/ui-components/shared';
import type { DeckRunState } from './deckApi';
import { runFailureMessage, runProgressLabel } from './decksModel';

interface DeckRunProgressProps {
  title: string;
  run: DeckRunState | null;
  runId: string;
}

export function DeckRunProgress({ title, run, runId }: DeckRunProgressProps) {
  if (run?.status === 'failed') {
    return (
      <Banner variant="error" layout="stacked" title={`${title} failed`} data-testid="deck-run-failed">
        {runFailureMessage(run)}
      </Banner>
    );
  }
  return (
    <Banner variant="info" layout="stacked" title={title} data-testid="deck-run-progress">
      <Inline gap="sm" align="center">
        <Spinner size="sm" />
        <StatusPill state="info" label="running" size="sm" />
        <Text className="text-sm" data-testid="deck-run-phase">{runProgressLabel(run)}</Text>
        <Text className="font-mono text-xs text-[var(--color-text-muted)]">{runId}</Text>
      </Inline>
    </Banner>
  );
}
