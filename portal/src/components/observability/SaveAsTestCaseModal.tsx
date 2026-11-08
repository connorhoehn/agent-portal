// SaveAsTestCaseModal — shared modal for capturing an invocation as a
// regression test case in the harness.
//
// Sprint 4 (M13) wiring: replaces the stub modal that lived inside
// InvocationDetailPage and the missing "+ Save as test case" affordance on
// DriftPage's outlier panel. Both call-sites pass the source invocation;
// this component builds the form, pre-fills it, and POSTs to
// /api/observability/harness/cases on submit.
//
// Pre-fill rules (per Sprint 4 spec):
//   testId               auto-slugged from agent_id + timestamp
//   agentId              locked (display-only) from invocation
//   templateId           from invocation if present, blank otherwise
//   prompt               from invocation, editable
//   referenceOutput      empty by default — researcher fills in
//   expectedTags         empty list, pill input
//   passThreshold        0.7
//   notes                "Captured from drift outlier <id> on <date>"
//
// On success the parent gets onSuccess(testId) called so it can show its own
// toast and a link to /observability/harness — keeps the modal context-free.

import { useMemo, useRef, useState, useEffect } from 'react';
import {
  Button, Chip, CloseIcon, FormField, IconButton, Inline, InlineAlert, Input, MetaLine, Modal,
  SectionLabel, Stack, Textarea,
} from '@connorhoehn/ui-components/shared';

export interface SaveAsTestCaseSource {
  invocationId: string;
  agentId: string;
  templateId?: string | null;
  prompt: string;
  response?: string;
}

interface SaveAsTestCaseModalProps {
  invocation: SaveAsTestCaseSource;
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: (testId: string) => void;
}

// Slug helper — agent + ISO short timestamp. Mirrors the harness.py auto-id
// shape so test_ids stay readable.
function autoTestId(agentId: string): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\..+$/, '')
    .replace('T', '-');
  return `${agentId || 'agent'}-captured-${stamp}`;
}

export function SaveAsTestCaseModal({
  invocation,
  isOpen,
  onClose,
  onSuccess,
}: SaveAsTestCaseModalProps) {
  const [testId, setTestId] = useState<string>(() => autoTestId(invocation.agentId));
  const [prompt, setPrompt] = useState<string>(invocation.prompt ?? '');
  const [templateId, setTemplateId] = useState<string>(invocation.templateId ?? '');
  const [referenceOutput, setReferenceOutput] = useState<string>('');
  const [passThreshold, setPassThreshold] = useState<number>(0.7);
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const captureDate = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const notes = useMemo(
    () => `Captured from drift outlier ${invocation.invocationId} on ${captureDate}`,
    [invocation.invocationId, captureDate],
  );

  // Re-seed fields each time the modal opens for a fresh source. This keeps
  // a single mounted modal instance reusable across rows.
  const lastSourceRef = useRef<string>('');
  useEffect(() => {
    if (!isOpen) return;
    const key = `${invocation.invocationId}::${invocation.agentId}::${invocation.prompt}`;
    if (lastSourceRef.current === key) return;
    lastSourceRef.current = key;
    setTestId(autoTestId(invocation.agentId));
    setPrompt(invocation.prompt ?? '');
    setTemplateId(invocation.templateId ?? '');
    setReferenceOutput('');
    setPassThreshold(0.7);
    setTags([]);
    setTagInput('');
    setError(null);
  }, [isOpen, invocation.invocationId, invocation.agentId, invocation.prompt, invocation.templateId]);

  function addTag() {
    const t = tagInput.trim();
    if (!t) return;
    if (!tags.includes(t)) setTags([...tags, t]);
    setTagInput('');
  }

  function removeTag(t: string) {
    setTags(tags.filter((x) => x !== t));
  }

  async function submit() {
    setError(null);
    if (!testId.trim()) {
      setError('Test id is required.');
      return;
    }
    if (!prompt.trim()) {
      setError('Prompt is required.');
      return;
    }
    if (!invocation.agentId) {
      setError('Source invocation has no agent id.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/observability/harness/cases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          testId: testId.trim(),
          agentId: invocation.agentId,
          templateId: templateId.trim() || null,
          prompt,
          referenceOutput: referenceOutput.trim() ? referenceOutput : null,
          expectedTags: tags,
          passThreshold,
          notes,
          active: true,
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        setError(`Save failed (${res.status}). ${text.slice(0, 200)}`);
        return;
      }
      const json = (await res.json()) as { testId?: string };
      const savedId = json.testId ?? testId.trim();
      onSuccess?.(savedId);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      title="Save as test case"
      maxWidth={560}
      footer={
        <Inline gap="sm" justify="end" wrap={false} className="border-t border-border px-4 py-2.5">
          <Button variant="secondary" size="sm" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={submit} disabled={submitting}>
            {submitting ? 'Saving…' : 'Save test case'}
          </Button>
        </Inline>
      }
    >
      <Stack gap="sm" className="text-xs p-4 overflow-y-auto">
        <MetaLine
          size="xs"
          className="italic"
          items={['Captures this invocation as a regression test case in the harness suite. '
            + 'Subsequent harness runs will replay it and judge the response.']}
        />

        {/* FormField binds each label to its control — the markup this replaces
            used bare <label> elements with no htmlFor, so clicking one did
            nothing and a screen reader got no association. `labelId` is dropped
            from every bag: it is not a DOM prop. */}
        <FormField label="Test ID">
          {({ labelId: _l, ...w }) => (
            <Input {...w} type="text" size="sm" value={testId}
              onChange={(e) => setTestId(e.target.value)}
              disabled={submitting} spellCheck={false} className="w-full" />
          )}
        </FormField>

        <Inline gap="sm" align="start" wrap={false}>
          <FormField label="Agent (locked)" className="flex-1 min-w-0">
            {({ labelId: _l, ...w }) => (
              <Input {...w} type="text" size="sm" value={invocation.agentId}
                readOnly disabled className="w-full opacity-60" />
            )}
          </FormField>
          <FormField label="Template ID" className="flex-1 min-w-0">
            {({ labelId: _l, ...w }) => (
              <Input {...w} type="text" size="sm" value={templateId}
                onChange={(e) => setTemplateId(e.target.value)}
                disabled={submitting} placeholder="(optional)" spellCheck={false} className="w-full" />
            )}
          </FormField>
        </Inline>

        <FormField label="Prompt">
          {({ labelId: _l, ...w }) => (
            <Textarea {...w} value={prompt} rows={6} disabled={submitting}
              onChange={(e) => setPrompt(e.target.value)} className="w-full font-mono" />
          )}
        </FormField>

        <FormField label="Reference output" hint="optional">
          {({ labelId: _l, ...w }) => (
            <Textarea {...w} value={referenceOutput} rows={5} disabled={submitting}
              onChange={(e) => setReferenceOutput(e.target.value)}
              placeholder="What does a known-good answer look like?"
              className="text-xs w-full font-mono" />
          )}
        </FormField>

        <SectionLabel>Expected tags</SectionLabel>
        {/* No tag-input primitive exists and Chip has no remove affordance, so
            this row is composed from Chip + a ghost Button. Filed upstream. */}
        <Inline gap="xs" wrap className="border border-border rounded px-1.5 py-1 bg-bg min-h-[30px]">
          {tags.map((t) => (
            <Chip key={t} tone="neutral" size="xs">
              {t}
              <IconButton
                variant="ghost"
                size="sm"
                icon={<CloseIcon size={12} />}
                onClick={() => removeTag(t)}
                aria-label={`remove ${t}`}
                disabled={submitting}
              />
            </Chip>
          ))}
          <Input
            type="text"
            size="sm"
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault();
                addTag();
              }
            }}
            onBlur={addTag}
            disabled={submitting}
            placeholder="type tag + enter"
            spellCheck={false}
            aria-label="Add an expected tag"
            className="flex-1 min-w-[100px] border-none bg-transparent"
          />
        </Inline>

        <Inline gap="sm" align="start" wrap={false}>
          <FormField label="Pass threshold" className="flex-1 min-w-0">
            {({ labelId: _l, ...w }) => (
              <Input
                {...w}
                type="number"
                size="sm"
                min={0}
                max={1}
                step={0.05}
                value={passThreshold}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (Number.isFinite(v)) {
                    setPassThreshold(Math.max(0, Math.min(1, v)));
                  }
                }}
                disabled={submitting}
                className="w-full"
              />
            )}
          </FormField>
          <FormField label="Notes" hint="auto" className="flex-1 min-w-0">
            {({ labelId: _l, ...w }) => (
              <Input {...w} type="text" value={notes} readOnly disabled size="sm"
                className="w-full opacity-60" />
            )}
          </FormField>
        </Inline>

        {error && <InlineAlert tone="error">{error}</InlineAlert>}
      </Stack>
    </Modal>
  );
}

export default SaveAsTestCaseModal;
