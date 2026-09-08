import { useState, useEffect, useRef } from 'react';
import { Button, FormField, Modal } from '@connorhoehnslalom/ui-components/shared';
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

// ─── Step 1 — Identity ────────────────────────────────────────────────────────

interface Step1State {
  name: string;
  slug: string;
  slugTouched: boolean;
  tenant: 'orgiq';
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
  const nameHint =
    state.name.trim().length > 80
      ? `${state.name.trim().length}/100 chars`
      : undefined;
  const slugHint = state.slugTouched
    ? 'Manually edited — locked to this value. Only a–z, 0–9, hyphens.'
    : 'Auto-generated from name. Only a–z, 0–9, hyphens.';

  return (
    <div>
      <FormField label="Name" required error={nameErr} hint={nameHint}>
        {(p) => (
          <input
            {...p}
            value={state.name}
            onChange={handleNameChange}
            onBlur={() => onTouch('name')}
            placeholder="e.g. Engineering Docs"
            maxLength={100}
          />
        )}
      </FormField>

      <FormField label="Slug" required error={slugErr} hint={slugHint}>
        {(p) => (
          <input
            {...p}
            value={state.slug}
            onChange={handleSlugChange}
            onBlur={() => onTouch('slug')}
            placeholder="auto-generated from name"
            maxLength={60}
          />
        )}
      </FormField>

      <FormField label="Tenant">
        {(p) => (
          <select
            {...p}
            value={state.tenant}
            onChange={(e) => onChange({ tenant: e.target.value as Step1State['tenant'] })}
          >
            <option value="orgiq">orgiq</option>
          </select>
        )}
      </FormField>

      <FormField label="Purpose">
        {(p) => (
          <select
            {...p}
            value={state.purpose}
            onChange={(e) => onChange({ purpose: e.target.value as Step1State['purpose'] })}
          >
            <option value="default">default</option>
            <option value="articles">articles</option>
            <option value="hr">hr</option>
            <option value="engineering">engineering</option>
            <option value="custom">custom</option>
          </select>
        )}
      </FormField>

      <FormField
        label="Description"
        hint={state.description.length > 240 ? `${state.description.length}/300 chars` : undefined}
      >
        {(p) => (
          <textarea
            {...p}
            style={{ resize: 'vertical', minHeight: 64 }}
            value={state.description}
            onChange={(e) => onChange({ description: e.target.value })}
            placeholder="Optional — used as the Bedrock KB description"
            maxLength={300}
          />
        )}
      </FormField>
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

      <FormField
        label="S3 Prefix"
        required
        error={s3PrefixErr}
        hint='Must end with "/". Documents synced here will be ingested into this KB.'
      >
        {(p) => (
          <input
            {...p}
            value={state.s3Prefix}
            onChange={(e) => onChange({ s3Prefix: e.target.value, s3PrefixTouched: true })}
            onBlur={() => onTouch('s3Prefix')}
            placeholder="tenant/slug/"
          />
        )}
      </FormField>

      <FormField label="Chunking Strategy">
        {(p) => (
          <select
            {...p}
            value={state.chunkingStrategy}
            onChange={(e) =>
              onChange({ chunkingStrategy: e.target.value as Step2State['chunkingStrategy'] })
            }
          >
            <option value="SEMANTIC">SEMANTIC — context-aware variable chunks</option>
            <option value="FIXED">FIXED — fixed-size chunks</option>
            <option value="HIERARCHICAL">HIERARCHICAL — parent + child chunks</option>
            <option value="NONE">NONE — no chunking (whole documents)</option>
          </select>
        )}
      </FormField>

      {state.chunkingStrategy !== 'NONE' && (
        <FormField
          label="Max Tokens per Chunk"
          error={maxTokensErr}
          hint="64–2048. SEMANTIC: target size (actual may vary). FIXED: exact size."
        >
          {(p) => (
            <input
              {...p}
              type="number"
              value={state.maxTokens}
              min={64}
              max={2048}
              onBlur={() => onTouch('maxTokens')}
              onChange={(e) =>
                onChange({ maxTokens: Math.min(2048, Math.max(1, Number(e.target.value))) })
              }
            />
          )}
        </FormField>
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

  // ── Derived validation ──────────────────────────────────────────────────────

  const step1Errors = validateStep1(step1);
  const step2Errors = validateStep2(step2);
  const step1Valid  = Object.keys(step1Errors).length === 0;
  const step2Valid  = Object.keys(step2Errors).length === 0;

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

  const stepLabel =
    step === 1 ? 'Identity' : step === 2 ? 'Data Configuration' : 'Provisioning';

  const footer = (
    <>
      {step === 2 && (
        <Button variant="secondary" onClick={() => { setSubmitError(null); setStep(1); }}>
          Back
        </Button>
      )}
      {step !== 3 && (
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
      )}
      {step === 1 && (
        <Button variant="primary" disabled={step1Checking} onClick={handleNext}>
          {step1Checking ? 'Checking…' : 'Next →'}
        </Button>
      )}
      {step === 2 && (
        <Button variant="primary" disabled={submitting} onClick={handleCreate}>
          {submitting ? 'Creating…' : 'Create KB'}
        </Button>
      )}
    </>
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`New Knowledge Base — Step ${step} of 3 — ${stepLabel}`}
      maxWidth={500}
      footer={footer}
    >
      {/* Step indicator bar */}
      <div style={{ display: 'flex', height: 3, marginBottom: 16 }}>
        {([1, 2, 3] as const).map((n) => (
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
    </Modal>
  );
}

export default KBCreateWizard;
