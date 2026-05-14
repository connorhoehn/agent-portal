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
import type { CSSProperties } from 'react';
import { Modal } from '@connorhoehnslalom/ui-components/shared';

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
        <div style={modalFooter}>
          <button
            type="button"
            onClick={onClose}
            style={btnSecondary}
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            style={{ ...btnPrimary, opacity: submitting ? 0.6 : 1 }}
            disabled={submitting}
          >
            {submitting ? 'Saving…' : 'Save test case'}
          </button>
        </div>
      }
    >
      <div style={modalBody}>
        <p style={modalHint}>
          Captures this invocation as a regression test case in the harness suite.
          Subsequent harness runs will replay it and judge the response.
        </p>

        <label style={modalFieldLabel}>TEST ID</label>
        <input
          type="text"
          value={testId}
          onChange={(e) => setTestId(e.target.value)}
          style={modalInput}
          disabled={submitting}
          spellCheck={false}
        />

        <div style={twoCol}>
          <div>
            <label style={modalFieldLabel}>AGENT (locked)</label>
            <input
              type="text"
              value={invocation.agentId}
              readOnly
              disabled
              style={{ ...modalInput, opacity: 0.6 }}
            />
          </div>
          <div>
            <label style={modalFieldLabel}>TEMPLATE ID</label>
            <input
              type="text"
              value={templateId}
              onChange={(e) => setTemplateId(e.target.value)}
              style={modalInput}
              disabled={submitting}
              placeholder="(optional)"
              spellCheck={false}
            />
          </div>
        </div>

        <label style={modalFieldLabel}>PROMPT</label>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          style={modalTextarea}
          rows={6}
          disabled={submitting}
        />

        <label style={modalFieldLabel}>REFERENCE OUTPUT (optional)</label>
        <textarea
          value={referenceOutput}
          onChange={(e) => setReferenceOutput(e.target.value)}
          style={modalTextarea}
          rows={5}
          disabled={submitting}
          placeholder="What does a known-good answer look like?"
        />

        <label style={modalFieldLabel}>EXPECTED TAGS</label>
        <div style={tagRow}>
          {tags.map((t) => (
            <span key={t} style={tagPill}>
              {t}
              <button
                onClick={() => removeTag(t)}
                style={tagPillRemove}
                aria-label={`remove ${t}`}
                disabled={submitting}
              >
                ×
              </button>
            </span>
          ))}
          <input
            type="text"
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault();
                addTag();
              }
            }}
            onBlur={addTag}
            style={tagInputStyle}
            disabled={submitting}
            placeholder="type tag + enter"
            spellCheck={false}
          />
        </div>

        <div style={twoCol}>
          <div>
            <label style={modalFieldLabel}>PASS THRESHOLD</label>
            <input
              type="number"
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
              style={modalInput}
              disabled={submitting}
            />
          </div>
          <div>
            <label style={modalFieldLabel}>NOTES (auto)</label>
            <input
              type="text"
              value={notes}
              readOnly
              disabled
              style={{ ...modalInput, opacity: 0.6, fontSize: 10.5 }}
            />
          </div>
        </div>

        {error && <div style={errorBox}>{error}</div>}
      </div>
    </Modal>
  );
}

const modalBody: CSSProperties = {
  padding: 16,
  overflowY: 'auto',
  fontSize: 12,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};

const modalFooter: CSSProperties = {
  borderTop: '1px solid var(--color-border)',
  padding: '10px 16px',
  display: 'flex',
  justifyContent: 'flex-end',
  gap: 8,
};

const modalHint: CSSProperties = {
  margin: 0,
  fontSize: 11,
  color: 'var(--color-text-tertiary)',
  fontStyle: 'italic',
};

const modalFieldLabel: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  color: 'var(--color-text-tertiary)',
  letterSpacing: 0.5,
  textTransform: 'uppercase',
  marginTop: 4,
};

const modalInput: CSSProperties = {
  fontFamily: 'inherit',
  fontSize: 12,
  padding: '6px 8px',
  border: '1px solid var(--color-border)',
  borderRadius: 4,
  background: 'var(--color-bg)',
  color: 'var(--color-text-primary)',
  width: '100%',
  boxSizing: 'border-box',
};

const modalTextarea: CSSProperties = {
  fontFamily: '"Fira Code", "Cascadia Code", monospace',
  fontSize: 11.5,
  padding: '8px 10px',
  border: '1px solid var(--color-border)',
  borderRadius: 4,
  background: 'var(--color-bg)',
  color: 'var(--color-text-primary)',
  resize: 'vertical',
  width: '100%',
  boxSizing: 'border-box',
};

const twoCol: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: 10,
};

const tagRow: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 6,
  border: '1px solid var(--color-border)',
  borderRadius: 4,
  padding: '4px 6px',
  background: 'var(--color-bg)',
  minHeight: 30,
};

const tagPill: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  fontSize: 11,
  background: 'var(--color-surface)',
  border: '1px solid var(--color-border)',
  borderRadius: 999,
  padding: '2px 8px',
  color: 'var(--color-text-secondary)',
};

const tagPillRemove: CSSProperties = {
  background: 'transparent',
  border: 'none',
  fontSize: 14,
  lineHeight: 1,
  color: 'var(--color-text-tertiary)',
  cursor: 'pointer',
  padding: 0,
};

const tagInputStyle: CSSProperties = {
  flex: 1,
  minWidth: 100,
  border: 'none',
  outline: 'none',
  fontSize: 12,
  background: 'transparent',
  color: 'var(--color-text-primary)',
};

const errorBox: CSSProperties = {
  padding: '6px 10px',
  background: 'var(--color-danger-bg, #fef2f2)',
  border: '1px solid var(--color-danger, #ef4444)',
  borderRadius: 4,
  color: 'var(--color-danger, #ef4444)',
  fontSize: 11.5,
};

const btnPrimary: CSSProperties = {
  padding: '6px 14px',
  fontSize: 12,
  fontWeight: 500,
  background: 'var(--color-primary, #6366f1)',
  color: '#fff',
  border: '1px solid var(--color-primary, #6366f1)',
  borderRadius: 4,
  cursor: 'pointer',
};

const btnSecondary: CSSProperties = {
  padding: '6px 14px',
  fontSize: 12,
  background: 'var(--color-surface)',
  color: 'var(--color-text-secondary)',
  border: '1px solid var(--color-border)',
  borderRadius: 4,
  cursor: 'pointer',
};

export default SaveAsTestCaseModal;
