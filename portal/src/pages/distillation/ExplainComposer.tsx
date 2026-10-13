// The docked Agent composer under a Knowledge record or a Review claim (spec
// §1): its context chip is the record, and it only EXPLAINS. Sending prepares
// a question for Search's Answer view (`/iq/search?tab=answer&prompt=`), which
// runs the read-only org agent — it never submits a review, publishes, or starts a compaction.
// Mutating workflows stay on their own buttons and capability gates.
//
// The library ConversationComposer with no conversation (Agent only, no
// particle console), pinned inside EditorShell's footer at the column's full
// width. The context chip is a menu
// ("This guide ▾": what the prompt attaches, "No context" included) rather
// than a removable ×, so the reader can put the context back. The host owns
// the choice and builds the prompt, and gets the composer's handle so a
// button elsewhere on the record can prefill it ("Draft a plan for my
// project").
import { forwardRef, useMemo, useState, type ForwardedRef, type Ref } from 'react';
import { useNavigate } from 'react-router';
import type { RichChatComposerHandle } from '@connorhoehnslalom/ui-components/social/rich-composer';
import { Stack } from '@connorhoehnslalom/ui-components/shared';
import { ConversationComposer } from '../../lib/conversationComposer';
import { explainPrompt } from './knowledgeModel';
import { searchMigration } from '../search/searchModel';

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

  // The record pane's one inset (docs/layout-cascade.md rule 8): the shared
  // composer surface (ComposerSurface) pads by --ui-content-gutter and centres
  // its content at --ui-composer-max-width; in a record both follow
  // EditorShell's 20px edge, so header, body and composer share one left edge.
  return (
    <Stack gap="none" className="shrink-0 [--ui-content-gutter:1.25rem] [--ui-composer-max-width:none]">
    <ConversationComposer
      key={subject.id}
      channel={null}
      context={{ kind: 'document', id: subject.id, title: chosen.label }}
      // It only explains (the read-only org agent); nothing here writes.
      capabilities={{ maySend: false, agent: { allowed: true } }}
      offModes={{ chat: 'Distillation has no discussion thread — ask the agent instead', terminal: 'A record has no terminal' }}
      defaultMode="agent"
      label="Ask about this record"
      data-testid="distillation-composer"
      // EditorShell's 20px head inset: the composer lines up with the record's
      // title and body (one left edge for the whole record pane).
      className="bg-surface pt-3 [--dock-inset:1.25rem]"
      composerRef={ref}
      console={false}
      // Always the card (as before 2.439): the context menu chip stays on the mode row, never the idle row's 11px chip.
      expanded
      contextChip={false}
      submitLabel={{ agent: 'Ask' }}
      modePlaceholders={{ agent: placeholder }}
      references={references}
      persistDraft={false}
      onAgent={typed => {
        if (!typed.trim()) return false;
        const prompt = buildPrompt(typed, context);
        if (!prompt) return false;
        // Straight to the Answer view: a hop through the legacy /iq/invoke
        // redirect is one more lazy route the navigation has to wait for.
        navigate(searchMigration('/iq/invoke', `?${new URLSearchParams({ prompt })}`));
        return true;
      }}
    />
    </Stack>
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
