// The docked Agent composer under a Knowledge record or a Review claim (spec
// §1): its context chip is the record, and it only EXPLAINS. Sending prepares
// a question for the Ask page (`/iq/invoke?prompt=`), which runs the read-only
// org agent — it never submits a review, publishes, or starts a compaction.
// Mutating workflows stay on their own buttons and capability gates.
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { RichChatComposer, type ComposerMode } from '@connorhoehnslalom/ui-components/social/rich-composer';
import { Stack } from '@connorhoehnslalom/ui-components/shared';
import { explainPrompt } from './knowledgeModel';

export function ExplainComposer({
  subject, referenceLabel, placeholder,
}: {
  subject: { kind: string; id: string; title: string };
  /** The context chip — "This guide", "This review". */
  referenceLabel: string;
  placeholder: string;
}) {
  const navigate = useNavigate();
  const [mode, setMode] = useState<ComposerMode>('agent');
  const [withContext, setWithContext] = useState(true);

  return (
    <Stack gap="none" className="px-4 pb-3" data-testid="distillation-composer">
      <RichChatComposer
        key={subject.id}
        mode={mode}
        onModeChange={setMode}
        modeControl="menu"
        disabledModes={['chat', 'terminal']}
        modeUnavailableReasons={{
          chat: 'Distillation has no discussion thread — ask the agent instead',
          terminal: 'A record has no terminal',
        }}
        layout="wide"
        toolbar="compact"
        submitLabel={{ agent: 'Ask' }}
        modePlaceholders={{ agent: placeholder }}
        references={withContext ? [{ id: subject.id, label: referenceLabel }] : []}
        onRemoveReference={() => setWithContext(false)}
        onSend={(msg) => {
          const typed = msg.text.replace(/^\/agent\s+/, '');
          const prompt = withContext ? explainPrompt(typed, subject) : typed.trim();
          if (!prompt) return false;
          navigate(`/iq/invoke?${new URLSearchParams({ prompt }).toString()}`);
          return true;
        }}
      />
    </Stack>
  );
}
