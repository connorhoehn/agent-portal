import {
  Button,
  ChoiceList,
  ChoiceRow,
  InlineAlert,
  InlinePlaceholder,
  LoadingState,
  SearchInput,
  Stack,
} from '@connorhoehnslalom/ui-components/shared';
import type { PromptLibraryEntry } from '../../../components/canary/types.js';
import { friendlyLibraryError } from './libraryError';

/** The prompt rail: search, the library list, and a manual refresh. */
export function PromptSidebar({
  prompts,
  loading,
  error,
  search,
  onSearch,
  selectedId,
  onSelect,
  onRefresh,
  onNew,
  canManage,
}: {
  prompts: PromptLibraryEntry[];
  loading: boolean;
  error: string | null;
  search: string;
  onSearch: (v: string) => void;
  selectedId: string | null;
  onSelect: (prompt: PromptLibraryEntry) => void;
  onRefresh: () => void;
  onNew: () => void;
  canManage: boolean;
}) {
  return (
    <Stack gap="none" className="w-60 flex-none overflow-hidden border-r border-border bg-surface">
      <Stack gap="sm" className="flex-none border-b border-border px-3 pb-2.5 pt-3.5">
        {canManage && (
          <Button variant="primary" fullWidth onClick={onNew}>+ New prompt</Button>
        )}
        <SearchInput value={search} onChange={onSearch} placeholder="Search prompts…" />
      </Stack>

      <Stack gap="none" className="flex-1 overflow-y-auto">
        {loading && <LoadingState label="Loading prompts…" />}
        {error && <InlineAlert tone="error">{friendlyLibraryError(error)}</InlineAlert>}
        {!loading && !error && prompts.length === 0 && (
          <InlinePlaceholder>No prompts found.</InlinePlaceholder>
        )}
        {prompts.length > 0 && (
          // Library rows: title + description, the selected prompt reads as
          // the checked one of several. ChoiceRow truncates both lines to one
          // and carries no title, so in this 240px rail every name and every
          // description was cut with no way to read the rest (the description
          // appears nowhere else on the page). The rows wrap instead — names
          // break at their hyphens. A wrap/title option on ChoiceRow is queued
          // in docs/ui-components-queue.md; this override goes when it ships.
          <ChoiceList
            data-testid="prompt-rail-list"
            className="[&_[role=radio]_span]:whitespace-normal [&_[role=radio]_span]:[overflow-wrap:anywhere]"
          >
            {prompts.map(prompt => (
              <ChoiceRow
                key={prompt.id}
                title={prompt.name}
                description={prompt.description || undefined}
                selected={selectedId === prompt.id}
                onSelect={() => onSelect(prompt)}
                data-testid={`prompt-row-${prompt.id}`}
              />
            ))}
          </ChoiceList>
        )}
      </Stack>

      <Stack gap="none" className="flex-none p-3">
        <Button variant="secondary" fullWidth onClick={onRefresh}>Refresh library</Button>
      </Stack>
    </Stack>
  );
}
