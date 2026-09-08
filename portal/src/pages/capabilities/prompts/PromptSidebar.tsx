import {
  Button,
  InlineAlert,
  InlinePlaceholder,
  LoadingState,
  SearchInput,
  Stack,
} from '@connorhoehnslalom/ui-components/shared';
import type { PromptLibraryEntry } from '../../../components/canary/types.js';
import { friendlyLibraryError } from './libraryError';
import { T } from '../Text';

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
        {prompts.map(prompt => (
          <PromptRow
            key={prompt.id}
            prompt={prompt}
            active={selectedId === prompt.id}
            onSelect={() => onSelect(prompt)}
          />
        ))}
      </Stack>

      <Stack gap="none" className="flex-none p-3">
        <Button variant="secondary" fullWidth onClick={onRefresh}>Refresh library</Button>
      </Stack>
    </Stack>
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
    <Button
      variant="ghost"
      fullWidth
      onClick={onSelect}
      aria-pressed={active}
      className={`!h-auto !justify-start !rounded-none !border-0 !border-b !border-b-border !px-3.5 !py-2.5 !text-left ${
        active
          ? '!border-l-[3px] !border-l-primary !bg-[var(--color-primary-soft)] !pl-[11px]'
          : '!bg-transparent hover:!bg-surface-hover'
      }`}
    >
      <Stack gap="none" align="start" className="w-full">
        <T className="block w-full truncate font-mono text-[12px] font-semibold leading-snug text-text-primary">
          {prompt.name}
        </T>
        {prompt.description && (
          <T className="mt-0.5 block w-full truncate text-[11px] leading-snug text-text-tertiary">
            {prompt.description}
          </T>
        )}
      </Stack>
    </Button>
  );
}
