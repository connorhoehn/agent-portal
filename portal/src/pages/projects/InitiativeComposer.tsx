// The light composer docked under the Initiatives pane (F11, O10, W16, M5).
//
// "Agent ⌄ · ● <context> ×", a bordered input, B I code link attach, then
// "Workflow ⌄" and "/ commands", then Send. What it does (D6):
//
//   Agent — ASKS. Sending builds a prompt from what was typed plus the chip's
//           context and navigates to the Ask page (`/iq/invoke?prompt=`),
//           which runs the read-only org agent. Open to every role; nothing
//           here changes data. Removing the chip (×) sends the question
//           without the context.
//   Chat  — posts to a thread, only where the host supplies `onChat` (a work
//           item's Discussion, behind its write gate). Elsewhere it is
//           disabled with a reason, never silently dropped.
//
// The words — chip, prefill, placeholder, the three workflows behind
// "Workflow ⌄" and the matching "/ commands" — come from
// `project-detail/composerPrompts.ts`, built from row data. The prefill is
// keyed by subject (`setup.draftKey`), so moving to another item never carries
// one item's text into the next.

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { ChevronIcon, DropdownMenu } from '@connorhoehnslalom/ui-components/shared';
import { ComposerDockPlacementContext, FloatingComposerDock } from '@connorhoehnslalom/ui-components/doc-editor';
import {
  RichChatComposer,
  type ComposerMode,
  type RichChatDraft,
} from '@connorhoehnslalom/ui-components/social/rich-composer';
import {
  askHref,
  composerCommands,
  composerSetup,
  workflowMenuRows,
  type ComposerSetup,
  type ComposerSubject,
} from '../project-detail/composerPrompts';

export interface InitiativeComposerProps {
  /** Use the shared document-view toolbar in full-width initiative details. */
  presentation?: 'compact' | 'document';
  /** What the composer is about: the initiatives list, one initiative, or one work item. */
  subject: ComposerSubject;
  /**
   * Overrides for the words `composerSetup(subject)` derives — a route that
   * knows better (a different placeholder, no prefill) passes only what differs.
   * `draftKey` must change whenever the subject does.
   */
  setup?: Partial<ComposerSetup>;
  /**
   * Chat mode's send: post the text to this subject's thread. Resolve `false`
   * to keep the draft. Absent, Chat is disabled with `chatUnavailableReason`.
   */
  onChat?: (message: { text: string; html: string }) => boolean | Promise<boolean>;
  /** Why Chat is off. Default: the subject has no discussion thread. */
  chatUnavailableReason?: string;
  'data-testid'?: string;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function draftOf(text: string): RichChatDraft {
  return { html: text ? `<p>${escapeHtml(text)}</p>` : '', files: [] };
}

export function InitiativeComposer(props: InitiativeComposerProps) {
  const derived = composerSetup(props.subject);
  const setup: ComposerSetup = { ...derived, ...props.setup };
  // Remount per subject: the prefill, the chip and any half-typed text all
  // belong to the subject they were written against.
  return <DockedComposer key={setup.draftKey} {...props} setup={setup} />;
}

function DockedComposer({
  subject, setup, onChat, chatUnavailableReason, presentation = 'compact', 'data-testid': testId,
}: Omit<InitiativeComposerProps, 'setup'> & { setup: ComposerSetup }) {
  const navigate = useNavigate();
  const [mode, setMode] = useState<ComposerMode>('agent');
  const [withContext, setWithContext] = useState(true);
  const [draft, setDraft] = useState<RichChatDraft>(() => draftOf(setup.draft));
  // A workflow pick replaces the draft; the editor takes a new draft on mount,
  // so the pick bumps this to remount it with the command in place.
  const [seed, setSeed] = useState(0);

  const commands = useMemo(() => composerCommands(subject), [subject]);
  // The menu and the slash list are the same three workflows. One that does
  // not apply here is a disabled menu row whose reason is its second line and
  // tooltip (DropdownMenuItem.disabledReason, 2.390.4) — it cannot be picked.
  // A command typed by hand still meets the same rule: `askHref` builds
  // nothing for a workflow that does not apply, so Send refuses it.
  const workflows = useMemo(() => workflowMenuRows(subject), [subject]);

  const references = useMemo(
    () => (withContext ? [{ ...setup.chip }] : []),
    [withContext, setup.chip],
  );

  const chatOff = chatUnavailableReason ?? 'This view has no discussion thread — ask the agent instead';

  return (
    <ComposerDockPlacementContext.Provider value="pinned">
    <FloatingComposerDock
      label="Initiative composer"
      data-testid={testId ?? 'initiative-composer'}
      className="bg-surface pt-3 [--dock-inset:1.5rem]"
      composer={
      <RichChatComposer
        key={seed}
        mode={mode}
        onModeChange={setMode}
        modeControl="menu"
        layout="auto"
        toolbar={presentation === 'document' ? 'editor' : 'compact'}
        density={presentation === 'document' ? 'comfortable' : 'compact'}
        modeShortcuts
        modeTriggers
        backdropTone="none"
        allowAttachments
        references={references}
        onRemoveReference={() => setWithContext(false)}
        disabledModes={onChat ? ['terminal'] : ['chat', 'terminal']}
        modeUnavailableReasons={{
          chat: chatOff,
          terminal: 'Initiatives have no terminal',
        }}
        modePlaceholders={{ agent: setup.placeholder }}
        commands={commands}
        toolbarExtras={(
          <DropdownMenu
            trigger={<span className="inline-flex items-center gap-2">Workflow <ChevronIcon dir="down" size={14} /></span>}
            triggerLabel="Workflow"
            triggerClassName="h-7 px-2 text-xs font-medium text-text-secondary"
            sections={[{
              items: workflows.map((w) => ({
                label: w.label,
                description: w.description,
                disabled: w.disabled,
                disabledReason: w.disabledReason,
                onSelect: () => {
                  setDraft(draftOf(`/${w.id} `));
                  setSeed((n) => n + 1);
                },
              })),
            }]}
          />
        )}
        draft={draft}
        onDraftChange={(d) => setDraft(d)}
        onSend={async (msg) => {
          if (mode === 'chat') {
            if (!onChat || !msg.text.trim()) return false;
            return onChat({ text: msg.text, html: msg.html });
          }
          const href = askHref(msg.text, subject, withContext);
          if (!href) return false;
          navigate(href);
          return true;
        }}
      />
    } />
    </ComposerDockPlacementContext.Provider>
  );
}
