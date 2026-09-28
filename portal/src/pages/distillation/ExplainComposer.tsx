// The docked Agent composer under a Knowledge record or a Review claim (spec
// §1): its context chip is the record, and it only EXPLAINS. Sending prepares
// a question for the Ask page (`/iq/invoke?prompt=`), which runs the read-only
// org agent — it never submits a review, publishes, or starts a compaction.
// Mutating workflows stay on their own buttons and capability gates.
//
// Light (backdropTone "none") in a FloatingComposerDock, the way
// realtime-examples docks its Pipelines composer: the dock pins inside
// EditorShell's footer at the column's full width, which also keeps the
// composer out of a content-sized container. The context chip is a menu
// ("This guide ▾": what the prompt attaches, "No context" included) rather
// than a removable ×, so the reader can put the context back. The host owns
// the choice and builds the prompt, and gets the composer's handle so a
// button elsewhere on the record can prefill it ("Draft a plan for my
// project").
import { forwardRef, useMemo, useState, type ForwardedRef, type Ref } from 'react';
import { useNavigate } from 'react-router';
import { FloatingComposerDock } from '@connorhoehnslalom/ui-components/doc-editor';
import {
  RichChatComposer, type ComposerMode, type RichChatComposerHandle,
} from '@connorhoehnslalom/ui-components/social/rich-composer';
import { explainPrompt } from './knowledgeModel';

export interface ExplainContextOption<C extends string> {
  value: C;
  label: string;
}

export interface ExplainComposerProps<C extends string> {
  subject: { id: string };
  /** The context menu's choices; the chip shows the chosen one's label. */
  contextOptions: ReadonlyArray<ExplainContextOption<C>>;
  context: C;
  onContextChange: (next: C) => void;
  placeholder: string;
  /** The prompt the Ask page receives for what the reader typed; empty → nothing sent. */
  buildPrompt: (typed: string, context: C) => string;
}

function ExplainComposerInner<C extends string>(
  { subject, contextOptions, context, onContextChange, placeholder, buildPrompt }: ExplainComposerProps<C>,
  ref: ForwardedRef<RichChatComposerHandle>,
) {
  const navigate = useNavigate();
  const [mode, setMode] = useState<ComposerMode>('agent');
  const chosen = contextOptions.find((o) => o.value === context) ?? contextOptions[0];
  const references = useMemo(() => [{
    id: subject.id,
    label: chosen.label,
    menuLabel: `Context: ${chosen.label}`,
    menu: [{
      label: 'Context',
      items: contextOptions.map((o) => ({
        label: o.label,
        checked: o.value === context,
        onSelect: () => onContextChange(o.value),
      })),
    }],
  }], [subject.id, chosen.label, contextOptions, context, onContextChange]);

  return (
    <FloatingComposerDock
      label="Ask about this record"
      data-testid="distillation-composer"
      className="bg-surface pt-3"
      composer={(
        <RichChatComposer
          key={subject.id}
          ref={ref}
          mode={mode}
          onModeChange={setMode}
          modeControl="menu"
          backdropTone="none"
          disabledModes={['chat', 'terminal']}
          modeUnavailableReasons={{
            chat: 'Distillation has no discussion thread — ask the agent instead',
            terminal: 'A record has no terminal',
          }}
          layout="auto"
          toolbar="compact"
          density="compact"
          modeShortcuts
          modeTriggers
          submitLabel={{ agent: 'Ask' }}
          modePlaceholders={{ agent: placeholder }}
          allowAttachments={false}
          references={references}
          onSend={(msg) => {
            const typed = msg.text.replace(/^\/agent\s+/, '');
            if (!typed.trim()) return false;
            const prompt = buildPrompt(typed, context);
            if (!prompt) return false;
            navigate(`/iq/invoke?${new URLSearchParams({ prompt }).toString()}`);
            return true;
          }}
        />
      )}
    />
  );
}

export const ExplainComposer = forwardRef(ExplainComposerInner) as <C extends string>(
  props: ExplainComposerProps<C> & { ref?: Ref<RichChatComposerHandle> },
) => ReturnType<typeof ExplainComposerInner>;

type RecordContext = 'record' | 'none';

/** The plain case — a pattern, a run note, a Review claim: the menu attaches
 *  the record ("This pattern") or nothing ("No context"). */
export function RecordExplainComposer({
  subject, referenceLabel, placeholder,
}: {
  subject: { kind: string; id: string; title: string };
  /** The context chip — "This pattern", "This review". */
  referenceLabel: string;
  placeholder: string;
}) {
  const [context, setContext] = useState<RecordContext>('record');
  const options = useMemo<ReadonlyArray<ExplainContextOption<RecordContext>>>(
    () => [{ value: 'record', label: referenceLabel }, { value: 'none', label: 'No context' }],
    [referenceLabel],
  );
  return (
    <ExplainComposer
      subject={subject}
      contextOptions={options}
      context={context}
      onContextChange={setContext}
      placeholder={placeholder}
      buildPrompt={(typed, c) => (c === 'record' ? explainPrompt(typed, subject) : typed.trim())}
    />
  );
}
