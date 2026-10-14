// Reusable input host: each collection declares its commands, scope and actions.
// It never invents a chat channel, invokes an unrelated agent or executes a
// proposed mutation before the user confirms that specific operation.
import { useRef, useState } from 'react';
import { ColumnDock } from '@connorhoehnslalom/ui-components';
import { ConfirmDialog, IconButton, InlinePopover, InfoIcon, Stack, T, Tooltip } from '@connorhoehnslalom/ui-components/shared';
import type { ComposerPrompt } from '@connorhoehnslalom/ui-components/social/rich-composer';
import { ConversationComposer } from '../../lib/conversationComposer';

export interface CollectionCommandResult {
  message: string;
  confirmation?: { title: string; body: string; label: string; confirm(): Promise<string> };
}
export interface CollectionCommandAdapter {
  id: string;
  label: string;
  examples: readonly string[];
  scopeNote: string;
  placeholder: string;
  execute(text: string): CollectionCommandResult | Promise<CollectionCommandResult>;
}

/** A page with no declared adapter must omit the host and document why in its
 * route audit contract. Merely rendering an input is not supported coverage.
 *
 * The host docks itself (`ColumnDock`, ui-components 2.448.0): wherever the
 * section that owns the table mounts it, the composer renders at the bottom of
 * the content column (`DockedColumn` — BuildSectionLayout, SectionContent),
 * spanning it, with every other block of the page above it. It still drives
 * that section's table: the portal keeps it in the section's React tree. In a
 * host with no dock it renders in place (docs/layout-cascade.md). */
export function CollectionCommandHost({ adapter, disabled = false, prompts }: {
  adapter: CollectionCommandAdapter;
  disabled?: boolean;
  /** Items on the page that wait on a person (agent questions, work to review), as the composer's
   *  prompt deck — answered here, paged with the keyboard, instead of a block above the composer. */
  prompts?: readonly ComposerPrompt[];
}) {
  const [notice, setNotice] = useState<{ text: string; tone: 'info' | 'danger' } | null>(null);
  const [pending, setPending] = useState<CollectionCommandResult['confirmation']>();
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const helpRef = useRef<HTMLButtonElement>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const submit = async (text: string) => {
    if (disabled || locked.current || pending) return false;
    locked.current = true; setBusy(true);
    try {
      const result = await adapter.execute(text);
      setNotice({ text: result.message, tone: 'info' });
      setPending(result.confirmation);
      return true;
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : 'The command could not be completed.', tone: 'danger' });
      return false;
    } finally { locked.current = false; setBusy(false); }
  };
  return <ColumnDock><Stack gap="none" className="shrink-0 min-w-0" data-testid="collection-command-host" data-collection-command={adapter.id}>
    <ConversationComposer channel={null} context={{ kind: 'document', id: adapter.id, title: adapter.label }}
      capabilities={{ maySend: false, agent: { allowed: true } }} defaultMode="agent" mode="agent"
      offModes={{ chat: 'This input controls the table; it does not post to a conversation', terminal: 'This table has no terminal' }}
      label={`${adapter.label} commands`} inputLabel={`${adapter.label} command`} presentation="compact"
      data-testid="collection-command-composer" composerTestId="collection-command-input"
      modePlaceholders={{ agent: adapter.placeholder }}
      submitLabel={{ agent: 'Apply' }} answersFocus disabled={disabled || busy || !!pending}
      allowEmoji={false} persistDraft={false} onAgent={submit}
      {...(prompts?.length ? { prompts } : {})}
      modeRowEnd={<><Tooltip content="Supported table commands"><IconButton ref={helpRef} size="sm" aria-label={`Available ${adapter.label.toLowerCase()} commands`}
        icon={<InfoIcon size={14} />} aria-haspopup="dialog" aria-expanded={helpOpen} onClick={() => setHelpOpen(!helpOpen)} /></Tooltip>
        <InlinePopover open={helpOpen} onClose={() => setHelpOpen(false)} trigger={helpRef} kind="command-help"
          aria-label={`Available ${adapter.label.toLowerCase()} commands`} className="max-w-md p-4">
          <Stack gap="sm"><T size="sm" weight="semibold">Table commands</T>
            <T size="xs" tone="secondary">Filter, search or refresh this table. Use the phrases below for available actions.</T>
            <Stack as="ul" gap="xs">{adapter.examples.map(example => <li key={example}><T size="sm">{example}</T></li>)}</Stack>
            <T size="xs" tone="secondary">{adapter.scopeNote}</T>
          </Stack>
        </InlinePopover></>}
      status={notice ? { ...notice, onDismiss: () => setNotice(null), 'data-testid': 'collection-command-result' } : null} />
    <ConfirmDialog open={!!pending} title={pending?.title ?? 'Confirm operation'} body={pending?.body ?? ''}
      confirmLabel={pending?.label ?? 'Confirm'} cancelLabel="Keep it" tone="destructive"
      onCancel={() => { setPending(undefined); setNotice({ text: 'Operation dismissed. Nothing was changed.', tone: 'info' }); }}
      onConfirm={() => {
        if (!pending || locked.current) return;
        const action = pending; setPending(undefined); locked.current = true; setBusy(true);
        void action.confirm().then(text => setNotice({ text, tone: 'info' }), error => setNotice({
          text: error instanceof Error ? error.message : 'The operation failed.', tone: 'danger',
        })).finally(() => { locked.current = false; setBusy(false); });
      }} />
  </Stack></ColumnDock>;
}
