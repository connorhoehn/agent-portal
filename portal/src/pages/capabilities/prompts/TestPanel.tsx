import { useState, useCallback, useEffect } from 'react';
import { Button, Card, DetailHeader, Inline, InlineAlert, SectionLabel, SkeletonCard, Stack, T } from '@connorhoehn/ui-components/shared';
import { AssistPanel } from './AssistPanel';
import { GuardrailBanner, GuardrailSelect } from './GuardrailControls';
import { VariableInput } from './VariableInput';
import { extractVariableNames, flattenGuardrailTrace, versionLabel } from './promptFormat';
import { usePersonOptions, useSkillOptions } from './useVariableOptions';
import { invokePrompt, usePromptVersionDetail } from '../../../components/canary/usePromptLibrary.js';
import type { GuardrailIntervention, Selection } from './types';

/** Live test harness: fill the variables, optionally attach a guardrail, stream
 *  the model's answer back. */
export function TestPanel({
  selection,
  onClose,
}: {
  selection: Selection;
  onClose: () => void;
}) {
  // Same shape as EditPanel: this panel REPLACED the "Test" button, Escape
  // must close it rather than fall through to the shell, and the focus
  // hand-back to that button happens in ViewPanel once it is back on screen.
  const close = useCallback(() => { onClose(); }, [onClose]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      close();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [close]);

  const { detail, loading } = usePromptVersionDetail(selection.promptId, selection.version);
  const templateText = detail?.variant?.templateText ?? '';
  const varNames = extractVariableNames(templateText);

  const personOptions = usePersonOptions();
  const skillOptions = useSkillOptions();

  const [varValues, setVarValues] = useState<Record<string, string>>({});
  const [guardrailId, setGuardrailId] = useState('');
  const [running, setRunning] = useState(false);
  const [output, setOutput] = useState('');
  const [guardrailEvents, setGuardrailEvents] = useState<GuardrailIntervention[]>([]);
  const [runError, setRunError] = useState<string | null>(null);

  async function run(): Promise<void> {
    setRunning(true);
    setOutput('');
    setGuardrailEvents([]);
    setRunError(null);
    try {
      await invokePrompt(selection.promptId, {
        version: selection.version !== 'DRAFT' ? selection.version : undefined,
        variables: varValues,
        guardrailId: guardrailId.trim() || undefined,
        onChunk: (text: string) => setOutput(prev => prev + text),
        onGuardrail: (trace: unknown) =>
          setGuardrailEvents(prev => [...prev, ...flattenGuardrailTrace(trace)]),
      });
    } catch (e) {
      setRunError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  return (
    <Stack gap="none" className="h-full min-h-0 flex-1">
      <Stack gap="none" className="flex-none border-b border-border px-6 pb-4 pt-5">
        <DetailHeader
          as="h2"
          title={<T className="font-mono">{selection.promptName}</T>}
          description={`Testing ${versionLabel(selection.version)}`}
          aside={<Button variant="secondary" onClick={close}>Close</Button>}
          asideWidth={110}
        />
      </Stack>

      <Inline gap="none" wrap={false} align="stretch" className="min-h-0 flex-1 overflow-hidden">
        <Stack gap="lg" className="min-w-0 flex-1 overflow-y-auto p-6">
          {loading ? (
            <SkeletonCard height={80} />
          ) : (
            <>
              {varNames.length > 0 && (
                <Stack gap="sm">
                  <SectionLabel>Variables</SectionLabel>
                  {varNames.map((name, i) => (
                    <Stack gap="xs" as="label" key={name}>
                      <T size="xs" weight="semibold" className="font-mono text-[var(--color-optimize)]">
                        {`{{${name}}}`}
                      </T>
                      <VariableInput
                        name={name}
                        value={varValues[name] ?? ''}
                        onChange={v => setVarValues(prev => ({ ...prev, [name]: v }))}
                        personOptions={personOptions}
                        skillOptions={skillOptions}
                        autoFocus={i === 0}
                      />
                    </Stack>
                  ))}
                </Stack>
              )}

              <Stack gap="sm">
                <SectionLabel>Guardrail (optional)</SectionLabel>
                <GuardrailSelect value={guardrailId} onChange={setGuardrailId} />
              </Stack>
            </>
          )}

          <Button variant="primary" onClick={() => { void run(); }} disabled={running || loading}>
            {running ? 'Running…' : 'Run prompt ▶'}
          </Button>

          <GuardrailBanner interventions={guardrailEvents} />

          <Stack gap="sm">
            <SectionLabel>Output</SectionLabel>
            <OutputBox output={output} running={running} error={runError} />
          </Stack>
        </Stack>

        <Stack gap="none" className="w-[280px] flex-none overflow-y-auto border-l border-border bg-surface-panel">
          <AssistPanel promptId={selection.promptId} templateText={templateText} />
        </Stack>
      </Inline>
    </Stack>
  );
}

/** The streaming answer. The three quiet states are distinct on purpose: an
 *  empty box, "waiting for the first token", and a finished-but-empty response
 *  are three different things to debug. */
function OutputBox({ output, running, error }: { output: string; running: boolean; error: string | null }) {
  return (
    <Card padding="sm" className="min-h-[140px] overflow-y-auto whitespace-pre-wrap break-words bg-surface-panel font-mono text-sm leading-[1.7] text-text-primary">
      {error && <T className="text-danger">{error}</T>}
      {!error && !output && !running && (
        <T className="italic text-text-tertiary">Response will appear here…</T>
      )}
      {!error && running && !output && <T className="text-text-tertiary">Waiting for first token…</T>}
      <T>{output}</T>
      {running && output && <T className="inline-block text-primary">▌</T>}
    </Card>
  );
}
