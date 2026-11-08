// PromptLibraryStep — Step 1 of the canary setup wizard.
// Lets the user pick which Bedrock prompt they want to experiment with.

import { useState, useId } from 'react';
import {
  Button, EmptyState, FormField, Inline, InlineAlert, Input,
  MetaLine, SelectableCard, SkeletonCard, Stack, T,
} from '@connorhoehn/ui-components/shared';
import { usePromptList } from '../usePromptLibrary.js';
import type { PromptLibraryEntry } from '../types.js';
import { relativeTime } from '../../../lib/relativeTime';

export interface PromptLibraryStepProps {
  onSelect: (entry: PromptLibraryEntry) => void;
  selected: PromptLibraryEntry | null;
}

const is503 = (err: string | null): boolean =>
  err !== null && (err.includes('503') || err.toLowerCase().includes('unavailable'));

export function PromptLibraryStep({ onSelect, selected }: PromptLibraryStepProps): React.ReactElement {
  const { prompts, loading, error, refresh } = usePromptList();
  const [search, setSearch] = useState('');
  const [manualArn, setManualArn] = useState('');
  const manualArnId = useId();

  const filtered = prompts.filter((p) =>
    p.name.toLowerCase().includes(search.toLowerCase()),
  );

  const bedrock503 = is503(error);

  return (
    <Stack gap="none">
      <MetaLine
        tone="secondary"
        className="mb-4 leading-normal"
        items={['Choose a prompt from your Bedrock Prompt Library to run a canary experiment on.']}
      />

      {/* Search */}
      <Input
        type="text"
        size="sm"
        placeholder="Search prompts…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        aria-label="Search prompts"
        className="w-full"
      />

      {/* Loading state — SkeletonCard owns the pulse, so the hand-rolled
          `animation: pulse 1.5s` (and the @keyframes it assumed existed) is
          gone. */}
      {loading && (
        <Stack gap="sm" className="mt-3">
          {[0, 1, 2].map((i) => <SkeletonCard key={i} />)}
        </Stack>
      )}

      {/* Error state */}
      {!loading && error && !bedrock503 && (
        <Stack gap="none" className="mt-3">
          <InlineAlert tone="error">
            <Inline gap="sm" justify="between" wrap={false}>
              <Inline as="span" gap="none">{error}</Inline>
              <Button variant="danger" size="sm" onClick={refresh}>Retry</Button>
            </Inline>
          </InlineAlert>
        </Stack>
      )}

      {/* 503 / credentials unavailable */}
      {!loading && bedrock503 && (
        <Stack gap="none" className="mt-3">
          <InlineAlert tone="warning">
            <strong>Bedrock Prompt Library unavailable — check AWS credentials.</strong>
            <MetaLine
              size="xs"
              className="mt-1.5 mb-2.5 leading-normal"
              items={['Cannot reach the Bedrock API. You can enter a prompt ARN directly to continue.']}
            />
            <FormField label="Enter ARN directly">
              {({ labelId: _l, ...w }) => (
                <Input
                  {...w}
                  id={manualArnId}
                  type="text"
                  size="sm"
                  mono
                  placeholder="arn:aws:bedrock:us-east-1:123456789012:prompt/ABCDEFGHIJ"
                  value={manualArn}
                  onChange={(e) => setManualArn(e.target.value)}
                  className="w-full"
                />
              )}
            </FormField>
            {manualArn.trim() && (
              <Button
                variant="primary"
                size="sm"
                className="mt-2"
                onClick={() => {
                  const arn = manualArn.trim();
                  // Synthesize a minimal entry from the ARN
                  const parts = arn.split('/');
                  const id = parts[parts.length - 1] ?? arn;
                  onSelect({
                    id,
                    arn,
                    name: arn,
                    version: 'DRAFT',
                    updatedAt: new Date().toISOString(),
                  });
                }}
              >
                Use this ARN
              </Button>
            )}
          </InlineAlert>
        </Stack>
      )}

      {/* Empty state */}
      {!loading && !error && filtered.length === 0 && (
        <EmptyState className="mt-6" title="No prompts found in your Bedrock library" />
      )}

      {/* Prompt list */}
      {!loading && !error && filtered.length > 0 && (
        <Stack gap="sm" className="mt-3">
          {filtered.map((entry) => (
            // SelectableCard also sets aria-pressed, which the hand-rolled
            // role="button" div never did.
            <SelectableCard
              key={entry.id}
              selected={selected?.id === entry.id}
              onSelect={() => onSelect(entry)}
            >
              <Inline gap="sm" justify="between" align="baseline" wrap={false}>
                <T size="sm" weight="semibold" tone="primary" className="flex-1 min-w-0 truncate">
                  {entry.name}
                </T>
                <MetaLine size="xs" items={[relativeTime(entry.updatedAt)]} />
              </Inline>
              {entry.description && (
                <MetaLine size="xs" className="truncate" items={[entry.description]} />
              )}
            </SelectableCard>
          ))}
        </Stack>
      )}
    </Stack>
  );
}

