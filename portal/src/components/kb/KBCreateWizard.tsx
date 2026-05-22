import { useState, useEffect, useRef } from 'react';
import type { KbRegistryEntry } from '../../pages/admin/KBRegistryPage.js';
import { ProvisioningProgress } from './ProvisioningProgress.js';

// ─── Props ────────────────────────────────────────────────────────────────────

export interface KBCreateWizardProps {
  open: boolean;
  onClose: () => void;
  onCreated: (kb: KbRegistryEntry) => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/^-+/, '')        // strip leading hyphens
    .replace(/-{2,}/g, '-');   // collapse consecutive hyphens
}

function isValidSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,58}[a-z0-9]$/.test(slug) || /^[a-z0-9]{1,2}$/.test(slug);
}

function isValidS3Prefix(prefix: string): boolean {
  // Must end with '/', no consecutive slashes, no leading slash
  return /^[a-zA-Z0-9_\-./]+\/$/.test(prefix) && !prefix.startsWith('/') && !/\/\//.test(prefix);
}

// ─── Shared styles ────────────────────────────────────────────────────────────

function inputStyle(opts?: { disabled?: boolean; error?: boolean }): React.CSSProperties {
  return {
    width: '100%',
    boxSizing: 'border-box',
    padding: '7px 10px',
    fontSize: 13,
    border: `1px solid ${opts?.error ? 'var(--color-danger)' : 'var(--color-border)'}`,
    borderRadius: 6,
    background: opts?.disabled ? 'var(--color-surface-panel)' : 'var(--color-surface)',
    color: opts?.disabled ? 'var(--color-text-secondary)' : 'var(--color-text-primary)',
    outline: 'none',
    boxShadow: opts?.error ? '0 0 0 2px var(--color-danger-bg)' : undefined,
  };
}

function labelStyle(): React.CSSProperties {
  return {
    display: 'block',
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--color-text-primary)',
    marginBottom: 4,
  };
}

function fieldStyle(): React.CSSProperties {
  return { display: 'flex', flexDirection: 'column', marginBottom: 14 };
}

function hintStyle(isError?: boolean): React.CSSProperties {
  return {
    fontSize: 11,
    color: isError ? 'var(--color-danger)' : 'var(--color-text-tertiary)',
    marginTop: 3,
    lineHeight: 1.4,
  };
}

function RequiredStar() {
  return <span style={{ color: 'var(--color-danger)', marginLeft: 2 }}>*</span>;
}

// ─── Step 1 — Identity ────────────────────────────────────────────────────────

interface Step1State {
  name: string;
  slug: string;
  slugTouched: boolean;
  tenant: 'orgiq' | 'newsroom';
  purpose: 'default' | 'articles' | 'hr' | 'engineering' | 'custom';
  description: string;
}

interface Step1Errors {
  name?: string;
  slug?: string;
}

function validateStep1(state: Step1State): Step1Errors {
  const errors: Step1Errors = {};

  if (!state.name.trim()) {
    errors.name = 'Name is required.';
  } else if (state.name.trim().length < 2) {
    errors.name = 'Name must be at least 2 characters.';
  } else if (state.name.trim().length > 100) {
    errors.name = 'Name must be 100 characters or fewer.';
  }

  if (!state.slug) {
    errors.slug = 'Slug is required.';
  } else if (!isValidSlug(state.slug)) {
    errors.slug = 'Slug must start and end with a letter or number, use only a–z, 0–9, hyphens, and be 1–60 chars.';
  }

  return errors;
}

function Step1({
  state,
  onChange,
  touched,
  onTouch,
}: {
  state: Step1State;
  onChange: (patch: Partial<Step1State>) => void;
  touched: Set<keyof Step1Errors>;
  onTouch: (field: keyof Step1Errors) => void;
}) {
  const errors = validateStep1(state);

  function handleNameChange(e: React.ChangeEvent<HTMLInputElement>) {
    const name = e.target.value;
    onChange(state.slugTouched ? { name } : { name, slug: toSlug(name) });
  }

  function handleSlugChange(e: React.ChangeEvent<HTMLInputElement>) {
    onChange({ slug: toSlug(e.target.value), slugTouched: true });
  }

  const nameErr = touched.has('name') ? errors.name : undefined;
  const slugErr = touched.has('slug') ? errors.slug : undefined;

  return (
    <div>
      {/* Name */}
      <div style={fieldStyle()}>
        <label style={labelStyle()}>
          Name<RequiredStar />
        </label>
        <input
          style={inputStyle({ error: !!nameErr })}
          value={state.name}
          onChange={handleNameChange}
          onBlur={() => onTouch('name')}
          placeholder="e.g. Engineering Docs"
          maxLength={100}
        />
        {nameErr ? (
          <span style={hintStyle(true)}>{nameErr}</span>
        ) : (
          state.name.trim().length > 80 && (
            <span style={hintStyle()}>{state.name.trim().length}/100 chars</span>
          )
        )}
      </div>

      {/* Slug */}
      <div style={fieldStyle()}>
        <label style={labelStyle()}>
          Slug<RequiredStar />
        </label>
        <input
          style={inputStyle({ error: !!slugErr })}
          value={state.slug}
          onChange={handleSlugChange}
          onBlur={() => onTouch('slug')}
          placeholder="auto-generated from name"
          maxLength={60}
        />
        {slugErr ? (
          <span style={hintStyle(true)}>{slugErr}</span>
        ) : (
          <span style={hintStyle()}>
            {state.slugTouched ? 'Manually edited — locked to this value. ' : 'Auto-generated from name. '}
            Only a–z, 0–9, hyphens.
          </span>
        )}
      </div>

      {/* Tenant */}
      <div style={fieldStyle()}>
        <label style={labelStyle()}>Tenant</label>
        <select
          style={inputStyle()}
          value={state.tenant}
          onChange={e => onChange({ tenant: e.target.value as Step1State['tenant'] })}
        >
          <option value="orgiq">orgiq</option>
          <option value="newsroom">newsroom</option>
        </select>
      </div>

      {/* Purpose */}
      <div style={fieldStyle()}>
        <label style={labelStyle()}>Purpose</label>
        <select
          style={inputStyle()}
          value={state.purpose}
          onChange={e => onChange({ purpose: e.target.value as Step1State['purpose'] })}
        >
          <option value="default">default</option>
          <option value="articles">articles</option>
          <option value="hr">hr</option>
          <option value="engineering">engineering</option>
          <option value="custom">custom</option>
        </select>
      </div>

      {/* Description */}
      <div style={fieldStyle()}>
        <label style={labelStyle()}>Description</label>
        <textarea
          style={{ ...inputStyle(), resize: 'vertical', minHeight: 64 }}
          value={state.description}
          onChange={e => onChange({ description: e.target.value })}
          placeholder="Optional — used as the Bedrock KB description"
          maxLength={300}
        />
        {state.description.length > 240 && (
          <span style={hintStyle()}>{state.description.length}/300 chars</span>
        )}
      </div>
    </div>
  );
}

// ─── Step 2 — Data Configuration ──────────────────────────────────────────────

interface Step2State {
  s3Prefix: string;
  s3PrefixTouched: boolean;
  chunkingStrategy: 'SEMANTIC' | 'FIXED' | 'HIERARCHICAL' | 'NONE';
  maxTokens: number;
}

interface Step2Errors {
  s3Prefix?: string;
  maxTokens?: string;
}

function validateStep2(state: Step2State): Step2Errors {
  const errors: Step2Errors = {};

  if (!state.s3Prefix.trim()) {
    errors.s3Prefix = 'S3 prefix is required.';
  } else if (!isValidS3Prefix(state.s3Prefix.trim())) {
    errors.s3Prefix = 'Prefix must end with "/" and use only letters, numbers, hyphens, underscores, dots, and slashes. No leading slash or double slashes.';
  }

  if (state.chunkingStrategy !== 'NONE') {
    if (state.maxTokens < 64) errors.maxTokens = 'Min 64 tokens.';
    if (state.maxTokens > 2048) errors.maxTokens = 'Max 2048 tokens.';
  }

  return errors;
}

function Step2({
  state,
  step1,
  onChange,
  touched,
  onTouch,
}: {
  state: Step2State;
  step1: Step1State;
  onChange: (patch: Partial<Step2State>) => void;
  touched: Set<keyof Step2Errors>;
  onTouch: (field: keyof Step2Errors) => void;
}) {
  const errors = validateStep2(state);
  const s3PrefixErr = touched.has('s3Prefix') ? errors.s3Prefix : undefined;
  const maxTokensErr = touched.has('maxTokens') ? errors.maxTokens : undefined;

  // Derived info for the preview panel
  const bedrockName = step1.tenant && step1.slug ? `${step1.tenant}-${step1.slug}` : '—';
  const auroraTable = step1.slug ? `bedrock_kb_${step1.slug.replace(/-/g, '_')}` : '—';

  return (
    <div>
      {/* Resource preview panel */}
      <div
        style={{
          marginBottom: 18,
          padding: '10px 14px',
          background: 'var(--color-surface-panel)',
          border: '1px solid var(--color-border)',
          borderRadius: 7,
          fontSize: 12,
        }}
      >
        <div style={{ fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 6, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Resources that will be created
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', rowGap: 4, columnGap: 10 }}>
          <span style={{ color: 'var(--color-text-secondary)' }}>Bedrock KB name</span>
          <code style={{ fontFamily: 'monospace', color: 'var(--color-text-primary)', fontSize: 12 }}>{bedrockName}</code>
          <span style={{ color: 'var(--color-text-secondary)' }}>Aurora table</span>
          <code style={{ fontFamily: 'monospace', color: 'var(--color-text-primary)', fontSize: 12 }}>{auroraTable}</code>
          <span style={{ color: 'var(--color-text-secondary)' }}>S3 prefix</span>
          <code style={{ fontFamily: 'monospace', color: 'var(--color-text-primary)', fontSize: 12 }}>{state.s3Prefix || '—'}</code>
        </div>
      </div>

      {/* S3 Prefix */}
      <div style={fieldStyle()}>
        <label style={labelStyle()}>
          S3 Prefix<RequiredStar />
        </label>
        <input
          style={inputStyle({ error: !!s3PrefixErr })}
          value={state.s3Prefix}
          onChange={e => onChange({ s3Prefix: e.target.value, s3PrefixTouched: true })}
          onBlur={() => onTouch('s3Prefix')}
          placeholder="tenant/slug/"
        />
        {s3PrefixErr ? (
          <span style={hintStyle(true)}>{s3PrefixErr}</span>
        ) : (
          <span style={hintStyle()}>Must end with "/". Documents synced here will be ingested into this KB.</span>
        )}
      </div>

      {/* Chunking strategy */}
      <div style={fieldStyle()}>
        <label style={labelStyle()}>Chunking Strategy</label>
        <select
          style={inputStyle()}
          value={state.chunkingStrategy}
          onChange={e =>
            onChange({ chunkingStrategy: e.target.value as Step2State['chunkingStrategy'] })
          }
        >
          <option value="SEMANTIC">SEMANTIC — context-aware variable chunks</option>
          <option value="FIXED">FIXED — fixed-size chunks</option>
          <option value="HIERARCHICAL">HIERARCHICAL — parent + child chunks</option>
          <option value="NONE">NONE — no chunking (whole documents)</option>
        </select>
      </div>

      {/* Max tokens — only relevant for non-NONE strategies */}
      {state.chunkingStrategy !== 'NONE' && (
        <div style={fieldStyle()}>
          <label style={labelStyle()}>Max Tokens per Chunk</label>
          <input
            type="number"
            style={inputStyle({ error: !!maxTokensErr })}
            value={state.maxTokens}
            min={64}
            max={2048}
            onBlur={() => onTouch('maxTokens')}
            onChange={e =>
              onChange({ maxTokens: Math.min(2048, Math.max(1, Number(e.target.value))) })
            }
          />
          {maxTokensErr ? (
            <span style={hintStyle(true)}>{maxTokensErr}</span>
          ) : (
            <span style={hintStyle()}>64–2048. SEMANTIC: target size (actual may vary). FIXED: exact size.</span>
          )}
        </div>
      )}

      {/* Embedding model — fixed */}
      <div
        style={{
          marginTop: 4,
          padding: '8px 12px',
          background: 'var(--color-primary-soft)',
          border: '1px solid var(--color-info-border)',
          borderRadius: 6,
          fontSize: 12,
          color: 'var(--color-primary)',
        }}
      >
        Embedding model: <strong>amazon.titan-embed-text-v2:0 (1024d)</strong> — fixed
      </div>
    </div>
  );
}

// ─── Step 3 — Provisioning ────────────────────────────────────────────────────

function Step3({
  kb,
  onComplete,
  onError,
}: {
  kb: KbRegistryEntry;
  onComplete: (bedrockKbId: string) => void;
  onError: (message: string) => void;
}) {
  return (
    <div>
      <div
        style={{
          padding: '10px 14px',
          background: 'var(--color-surface-panel)',
          border: '1px solid var(--color-border)',
          borderRadius: 6,
          marginBottom: 20,
        }}
      >
        <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 2 }}>Creating</div>
        <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--color-text-primary)' }}>{kb.name}</div>
        <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', fontFamily: 'monospace', marginTop: 2 }}>
          {kb.slug} · {kb.tenant}
        </div>
      </div>

      <ProvisioningProgress
        registryId={kb.id}
        onComplete={onComplete}
        onError={onError}
      />
    </div>
  );
}

// ─── Wizard ───────────────────────────────────────────────────────────────────

export function KBCreateWizard({ open, onClose, onCreated }: KBCreateWizardProps) {
  const [step, setStep] = useState<1 | 2 | 3>(1);

  const [step1, setStep1] = useState<Step1State>({
    name: '',
    slug: '',
    slugTouched: false,
    tenant: 'orgiq',
    purpose: 'default',
    description: '',
  });

  const [step2, setStep2] = useState<Step2State>({
    s3Prefix: '',
    s3PrefixTouched: false,
    chunkingStrategy: 'SEMANTIC',
    maxTokens: 512,
  });

  const [step1Touched, setStep1Touched] = useState<Set<keyof Step1Errors>>(new Set());
  const [step2Touched, setStep2Touched] = useState<Set<keyof Step2Errors>>(new Set());

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [createdKb, setCreatedKb] = useState<KbRegistryEntry | null>(null);
  const [step1Checking, setStep1Checking] = useState(false);

  // Tracks the pending reset timer so we can clear it on unmount / re-open.
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => {
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
  }, []);

  // Auto-update s3Prefix when tenant/slug changes (unless user already touched it)
  useEffect(() => {
    if (!step2.s3PrefixTouched) {
      setStep2(prev => ({
        ...prev,
        s3Prefix: step1.tenant && step1.slug ? `${step1.tenant}/${step1.slug}/` : '',
      }));
    }
  }, [step1.tenant, step1.slug, step2.s3PrefixTouched]);

  // Reset wizard state when closed
  useEffect(() => {
    if (!open) {
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
      resetTimerRef.current = setTimeout(() => {
        setStep(1);
        setStep1({ name: '', slug: '', slugTouched: false, tenant: 'orgiq', purpose: 'default', description: '' });
        setStep2({ s3Prefix: '', s3PrefixTouched: false, chunkingStrategy: 'SEMANTIC', maxTokens: 512 });
        setStep1Touched(new Set());
        setStep2Touched(new Set());
        setSubmitting(false);
        setSubmitError(null);
        setCreatedKb(null);
        setStep1Checking(false);
      }, 200);
    }
  }, [open]);

  if (!open) return null;

  // ── Derived validation ──────────────────────────────────────────────────────

  const step1Errors = validateStep1(step1);
  const step2Errors = validateStep2(step2);
  const step1Valid  = Object.keys(step1Errors).length === 0;
  const step2Valid  = Object.keys(step2Errors).length === 0;

  function canAdvanceStep1(): boolean {
    return step1Valid && !step1Checking;
  }

  function canCreate(): boolean {
    return step2Valid && !submitting;
  }

  // ── Touch all fields in current step (reveal errors on button click) ─────────

  function touchAllStep1() {
    setStep1Touched(new Set<keyof Step1Errors>(['name', 'slug']));
  }

  function touchAllStep2() {
    setStep2Touched(new Set<keyof Step2Errors>(['s3Prefix', 'maxTokens']));
  }

  // ── Handlers ─────────────────────────────────────────────────────────────────

  function handleStep1Change(patch: Partial<Step1State>) {
    setStep1(prev => ({ ...prev, ...patch }));
  }

  function handleStep2Change(patch: Partial<Step2State>) {
    setStep2(prev => ({ ...prev, ...patch }));
  }

  function touchStep1Field(field: keyof Step1Errors) {
    setStep1Touched(prev => new Set([...prev, field]));
  }

  function touchStep2Field(field: keyof Step2Errors) {
    setStep2Touched(prev => new Set([...prev, field]));
  }

  async function handleNext() {
    touchAllStep1();
    if (!step1Valid) return;

    setStep1Checking(true);
    setSubmitError(null);
    try {
      const res = await fetch(
        `/api/admin/kb-registry/check?slug=${encodeURIComponent(step1.slug)}&name=${encodeURIComponent(step1.name.trim())}`,
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        setSubmitError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      const data = await res.json() as { slugAvailable: boolean; nameAvailable: boolean };
      if (!data.slugAvailable) {
        setSubmitError(`Slug "${step1.slug}" is already in use. Choose a different name/slug.`);
        return;
      }
      if (!data.nameAvailable) {
        setSubmitError(`Name "${step1.name.trim()}" is already taken. Choose a different name.`);
        return;
      }
      setSubmitError(null);
      setStep(2);
    } catch {
      // Network error — let server validate again on Create
      setStep(2);
    } finally {
      setStep1Checking(false);
    }
  }

  async function handleCreate() {
    touchAllStep2();
    if (!step2Valid) return;

    setSubmitting(true);
    setSubmitError(null);

    try {
      const res = await fetch('/api/admin/kb-registry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name:             step1.name.trim(),
          slug:             step1.slug,
          tenant:           step1.tenant,
          purpose:          step1.purpose,
          description:      step1.description.trim() || undefined,
          s3Prefix:         step2.s3Prefix.trim(),
          chunkingStrategy: step2.chunkingStrategy,
          maxTokens:        step2.maxTokens,
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string; message?: string };
        setSubmitError(body.error ?? body.message ?? `HTTP ${res.status}`);
        setSubmitting(false);
        return;
      }

      const data = await res.json() as { kb: KbRegistryEntry };
      setCreatedKb(data.kb);
      setStep(3);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setSubmitting(false);
    }
  }

  function handleProvisioningComplete(bedrockKbId: string) {
    if (createdKb) {
      onCreated({ ...createdKb, bedrockKbId, status: 'ACTIVE' });
    }
    onClose();
  }

  function handleProvisioningError(message: string) {
    setSubmitError(message);
    // Stay on step 3 so the user can see which step failed
  }

  // ─── Layout ──────────────────────────────────────────────────────────────────

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          width: 500,
          background: 'var(--color-surface)',
          borderRadius: 10,
          boxShadow: '0 20px 60px rgba(0,0,0,0.18)',
          display: 'flex',
          flexDirection: 'column',
          maxHeight: '92vh',
          overflow: 'hidden',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '16px 20px',
            borderBottom: '1px solid var(--color-border)',
          }}
        >
          <div>
            <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--color-text-primary)' }}>
              New Knowledge Base
            </div>
            <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', marginTop: 2 }}>
              Step {step} of 3
              {step === 1 && ' — Identity'}
              {step === 2 && ' — Data Configuration'}
              {step === 3 && ' — Provisioning'}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              fontSize: 18,
              color: 'var(--color-text-secondary)',
              cursor: 'pointer',
              lineHeight: 1,
              padding: '2px 6px',
            }}
          >
            ×
          </button>
        </div>

        {/* Step indicator bar */}
        <div style={{ display: 'flex', height: 3 }}>
          {([1, 2, 3] as const).map(n => (
            <div
              key={n}
              style={{
                flex: 1,
                background: n <= step ? 'var(--color-primary)' : 'var(--color-border)',
                transition: 'background 0.3s',
              }}
            />
          ))}
        </div>

        {/* Body */}
        <div
          style={{
            padding: '20px 20px 0',
            overflowY: 'auto',
            flex: 1,
          }}
        >
          {step === 1 && (
            <Step1
              state={step1}
              onChange={handleStep1Change}
              touched={step1Touched}
              onTouch={touchStep1Field}
            />
          )}
          {step === 2 && (
            <Step2
              state={step2}
              step1={step1}
              onChange={handleStep2Change}
              touched={step2Touched}
              onTouch={touchStep2Field}
            />
          )}
          {step === 3 && createdKb && (
            <Step3
              kb={createdKb}
              onComplete={handleProvisioningComplete}
              onError={handleProvisioningError}
            />
          )}

          {submitError && (
            <div
              style={{
                margin: '10px 0',
                padding: '8px 12px',
                background: 'var(--color-danger-bg)',
                border: '1px solid var(--color-danger-border)',
                borderRadius: 6,
                fontSize: 12,
                color: 'var(--color-danger)',
              }}
            >
              {submitError}
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 10,
            padding: '16px 20px',
            borderTop: '1px solid var(--color-border)',
          }}
        >
          {/* Back — only on step 2 */}
          {step === 2 && (
            <button
              onClick={() => { setSubmitError(null); setStep(1); }}
              style={{
                padding: '7px 18px',
                fontSize: 13,
                background: 'var(--color-surface)',
                border: '1px solid var(--color-border)',
                borderRadius: 6,
                cursor: 'pointer',
                color: 'var(--color-text-primary)',
              }}
            >
              Back
            </button>
          )}

          {/* Cancel */}
          {step !== 3 && (
            <button
              onClick={onClose}
              style={{
                padding: '7px 18px',
                fontSize: 13,
                background: 'var(--color-surface)',
                border: '1px solid var(--color-border)',
                borderRadius: 6,
                cursor: 'pointer',
                color: 'var(--color-text-primary)',
              }}
            >
              Cancel
            </button>
          )}

          {/* Next (step 1) */}
          {step === 1 && (
            <button
              disabled={step1Checking}
              onClick={handleNext}
              style={{
                padding: '7px 18px',
                fontSize: 13,
                fontWeight: 600,
                background: step1Checking ? 'var(--color-state-pending)' : 'var(--color-primary)',
                color: 'var(--color-surface)',
                border: 'none',
                borderRadius: 6,
                cursor: step1Checking ? 'not-allowed' : 'pointer',
                minWidth: 80,
              }}
            >
              {step1Checking ? 'Checking…' : 'Next →'}
            </button>
          )}

          {/* Create (step 2) */}
          {step === 2 && (
            <button
              disabled={submitting}
              onClick={handleCreate}
              style={{
                padding: '7px 18px',
                fontSize: 13,
                fontWeight: 600,
                background: submitting ? 'var(--color-state-pending)' : 'var(--color-primary)',
                color: 'var(--color-surface)',
                border: 'none',
                borderRadius: 6,
                cursor: submitting ? 'not-allowed' : 'pointer',
                minWidth: 80,
              }}
            >
              {submitting ? 'Creating…' : 'Create KB'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default KBCreateWizard;
