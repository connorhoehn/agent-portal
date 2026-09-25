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
import { ChevronIcon, DropdownMenu, Stack } from '@connorhoehnslalom/ui-components/shared';
import {
  RichChatComposer,
  type ComposerMode,
  type RichChatDraft,
} from '@connorhoehnslalom/ui-components/social/rich-composer';
import {
  askHref,
  composerCommands,
  composerSetup,
  workflowMenu,
  type ComposerSetup,
  type ComposerSubject,
} from '../project-detail/composerPrompts';

export interface InitiativeComposerProps {
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
  subject, setup, onChat, chatUnavailableReason, 'data-testid': testId,
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
  // not apply here says why on its second line; picking it anyway puts the
  // command in the draft, where the command bar repeats the reason and Send
  // refuses it — nothing is asked on the reader's behalf that cannot be built.
  const workflows = useMemo(() => workflowMenu(subject), [subject]);

  const references = useMemo(
    () => (withContext ? [{ ...setup.chip }] : []),
    [withContext, setup.chip],
  );

  const chatOff = chatUnavailableReason ?? 'This view has no discussion thread — ask the agent instead';

  return (
    <Stack gap="none" className="px-5 pb-4 pt-2" data-testid={testId ?? 'initiative-composer'}>
      <RichChatComposer
        key={seed}
        mode={mode}
        onModeChange={setMode}
        modeControl="menu"
        layout="wide"
        toolbar="basic"
        backdropTone="none"
        allowAttachments
        referencesPlacement="start"
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
            trigger={<>Workflow <ChevronIcon dir="down" size={14} /></>}
            triggerLabel="Workflow"
            triggerVariant="link"
            sections={[{
              items: workflows.map((w) => ({
                label: w.label,
                description: w.disabledReason ?? w.description,
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
    </Stack>
  );
}
