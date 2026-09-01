import {
  Button,
  InlineAlert,
  InlinePlaceholder,
  LoadingState,
  SearchInput,
  Stack,
} from '@connorhoehnslalom/ui-components/shared';
import type { PromptLibraryEntry } from '../../../components/canary/types.js';

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
    <div className="flex w-60 flex-none flex-col overflow-hidden border-r border-border bg-surface">
      <Stack gap="sm" className="flex-none border-b border-border px-3 pb-2.5 pt-3.5">
        {canManage && (
          <Button variant="primary" fullWidth onClick={onNew}>+ New prompt</Button>
        )}
        <SearchInput value={search} onChange={onSearch} placeholder="Search prompts…" />
      </Stack>

      <div className="flex-1 overflow-y-auto">
        {loading && <LoadingState label="Loading prompts…" />}
        {error && <InlineAlert tone="error">{error}</InlineAlert>}
        {!loading && !error && prompts.length === 0 && (
          <InlinePlaceholder>No prompts found.</InlinePlaceholder>
        )}
        {prompts.map(prompt => (
          <PromptRow
            key={prompt.id}
            prompt={prompt}
            active={selectedId === prompt.id}
            onSelect={() => onSelect(prompt)}
          />
        ))}
      </div>

      <div className="flex-none p-3">
        <Button variant="secondary" fullWidth onClick={onRefresh}>Refresh library</Button>
      </div>
    </div>
  );
}

/**
 * One row in the rail.
 *
 * Not `SelectableCard`: this is a flush list row with a hairline separator and
 * a 3px active rail, not a card in a grid, and SelectableCard's card chrome
 * would put a border around every entry.
 */
function PromptRow({
  prompt,
  active,
  onSelect,
}: {
  prompt: PromptLibraryEntry;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={`block w-full cursor-pointer border-0 border-b border-b-border px-3.5 py-2.5 text-left ${
        active
          ? 'border-l-[3px] border-l-primary bg-[var(--color-primary-soft)] pl-[11px]'
          : 'bg-transparent hover:bg-surface-hover'
      }`}
    >
      <span className="block truncate font-mono text-[12px] font-semibold leading-snug text-text-primary">
        {prompt.name}
      </span>
      {prompt.description && (
        <span className="mt-0.5 block truncate text-[11px] leading-snug text-text-tertiary">
          {prompt.description}
        </span>
      )}
    </button>
  );
}
