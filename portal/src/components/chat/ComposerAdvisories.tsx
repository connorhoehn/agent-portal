import { useRef, useState } from 'react';
import { IconButton, InlinePopover, Stack, T, Tooltip, WarningIcon } from '@connorhoehnslalom/ui-components/shared';

export interface ComposerAdvisory {
  id: string;
  title: string;
  description: string;
}

/** Non-blocking notices stay in the composer; delivery errors stay visible. */
export function ComposerAdvisories({ notices }: { notices: readonly ComposerAdvisory[] }) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [pinned, setPinned] = useState(false);
  const restoringFocus = useRef(false);
  if (!notices.length) return null;
  const content = <Stack gap="sm" className="min-w-0">
    <T size="xs" weight="semibold">Composer notices</T>
    <Stack as="ul" gap="md" className="m-0 list-none p-0">
      {notices.map(notice => <li key={notice.id}>
        <T as="div" size="xs" weight="semibold">{notice.title}</T>
        <T as="div" size="xs" tone="secondary" wrap>{notice.description}</T>
      </li>)}
    </Stack>
  </Stack>;
  return <>
    <Tooltip content={content} disabled={pinned} placement="top" className="w-72 p-3" data-testid="composer-notices-preview">
      <IconButton ref={trigger} size="sm" variant="ghost" icon={<WarningIcon size={16} />}
        className="text-warning" aria-label={`Composer notices (${notices.length})`} aria-haspopup="dialog"
        aria-expanded={pinned}
        onFocus={event => { if (restoringFocus.current) event.stopPropagation(); }}
        onBlur={() => { restoringFocus.current = false; }} onClick={() => setPinned(value => !value)} data-testid="composer-notices-trigger" />
    </Tooltip>
    <InlinePopover trigger={trigger} open={pinned} onClose={() => { restoringFocus.current = true; setPinned(false); }} placement="bottom-end"
      aria-label="Composer notices" className="w-80 max-w-[calc(100vw-1rem)] p-3" data-testid="composer-notices-panel">
      {content}
    </InlinePopover>
  </>;
}
