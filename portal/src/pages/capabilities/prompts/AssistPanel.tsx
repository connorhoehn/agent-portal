import { useState } from 'react';
import { Button, CodeBlock, CollapsibleSection, FormField, InlineAlert, SectionLabel, Select, Stack, T } from '@connorhoehn/ui-components/shared';
import { optimizePrompt, type OptimizeMetric } from '../../../components/canary/usePromptLibrary.js';

const METRIC_OPTIONS = [
  { value: 'clarity',      label: 'Clarity — clearer instructions' },
  { value: 'brevity',      label: 'Brevity — fewer tokens' },
  { value: 'safety',       label: 'Safety — reduce harmful output risk' },
  { value: 'groundedness', label: 'Groundedness — stick to facts' },
];

/**
 * The right rail of the test harness: hand the current template to Nova Pro and
 * get a rewrite back.
 *
 * Deliberately read-only about the result — it copies to the clipboard rather
 * than writing into the editor, because an optimiser that silently replaced the
 * template would be destroying a version someone is mid-test on.
 */
export function AssistPanel({ promptId, templateText }: { promptId: string; templateText: string }) {
  const [metric, setMetric] = useState<OptimizeMetric>('clarity');
  const [optimizing, setOptimizing] = useState(false);
  const [optimizedText, setOptimizedText] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function optimize(): Promise<void> {
    setOptimizing(true);
    setOptimizedText('');
    setError(null);
    try {
      setOptimizedText(await optimizePrompt(promptId, templateText, metric));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setOptimizing(false);
    }
  }

  return (
    <CollapsibleSection title="AI Assist" storageKey="prompt-studio-assist">
      <Stack gap="md" className="p-4">
        <T size="xs" className="leading-relaxed text-text-tertiary" wrap>
          Let Nova Pro rewrite the current template for a specific goal. Review the result and copy
          it to your editor.
        </T>

        <FormField label="Optimize for">
          {({ labelId: _labelId, ...field }) => (
            <Select
              {...field}
              options={METRIC_OPTIONS}
              value={metric}
              onChange={e => setMetric(e.target.value as OptimizeMetric)}
            />
          )}
        </FormField>

        <Button
          variant="primary"
          onClick={() => { void optimize(); }}
          disabled={optimizing || !templateText}
        >
          {optimizing ? 'Optimizing…' : 'Optimize template'}
        </Button>

        {error && <InlineAlert tone="error">{error}</InlineAlert>}

        {optimizedText && (
          <Stack gap="sm">
            <SectionLabel>Suggested rewrite</SectionLabel>
            {/* CodeBlock owns its own copy button, which replaced a hand-rolled
                copy control plus a `copied` state flag. */}
            <CodeBlock code={optimizedText} theme="light" copyButton ariaLabel="Suggested rewrite" />
          </Stack>
        )}
      </Stack>
    </CollapsibleSection>
  );
}
