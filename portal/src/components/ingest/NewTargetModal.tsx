import { useId, useState } from 'react';
import { Card, Modal } from '@connorhoehnslalom/ui-components/shared';
import type { CrawlMode, CrawlTarget } from './types';
import { Button } from './ui';
import {
  Checkbox, FormField, InlineAlert, Inline, Input, MetaLine, SectionLabel, Select, Stack,
} from '@connorhoehnslalom/ui-components/shared';

const CRON_PRESETS = [
  { label: 'On-demand only',  expr: ''               },
  { label: 'Every hour',      expr: '0 * * * *'      },
  { label: 'Every 6 hours',   expr: '0 */6 * * *'    },
  { label: 'Daily midnight',  expr: '0 0 * * *'      },
  { label: 'Daily 9 AM UTC',  expr: '0 9 * * *'      },
  { label: 'Weekly Mon 9 AM', expr: '0 9 * * 1'      },
  { label: 'Custom…',         expr: '__custom__'     },
];

const MODES: Array<{ value: CrawlMode; label: string; desc: string }> = [
  { value: 'fetch',       label: 'fetch',       desc: 'HTTP fetch only — fastest, no JS' },
  { value: 'browser',     label: 'browser',     desc: 'Headless Chrome — JS executes' },
  { value: 'browser_spa', label: 'browser_spa', desc: 'Browser + SPA click traversal via Nova' },
];

export interface TargetDraft {
  label: string;
  startUrl: string;
  mode: CrawlMode;
  maxPages: number;
  sameOriginOnly: boolean;
  includePattern: string | null;
  cronExpr: string | null;
  enabled: boolean;
}

function initialDraft(t?: CrawlTarget | null): TargetDraft {
  return {
    label: t?.label ?? '',
    startUrl: t?.startUrl ?? '',
    mode: t?.mode ?? 'browser',
    maxPages: t?.maxPages ?? 10,
    sameOriginOnly: t?.sameOriginOnly ?? true,
    includePattern: t?.includePattern ?? null,
    cronExpr: t?.cronExpr ?? null,
    enabled: t?.enabled ?? true,
  };
}

export function NewTargetModal({
  existing,
  onSave,
  onCancel,
}: {
  existing?: CrawlTarget | null;
  onSave: (draft: TargetDraft) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<TargetDraft>(() => initialDraft(existing));
  const initialPreset = draft.cronExpr ?? '';
  const isKnownPreset = CRON_PRESETS.some(p => p.expr === initialPreset);
  const [preset, setPreset] = useState(isKnownPreset ? initialPreset : '__custom__');
  const [custom, setCustom] = useState(!isKnownPreset ? (draft.cronExpr ?? '') : '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const labelInputId = useId();
  const startUrlId = useId();
  const modeId = useId();
  const includePatternId = useId();
  const scheduleId = useId();
  const customCronId = useId();

  const isEdit = !!existing;

  function patch<K extends keyof TargetDraft>(key: K, value: TargetDraft[K]) {
    setDraft(d => ({ ...d, [key]: value }));
  }

  async function submit() {
    setError('');
    if (!draft.label.trim()) { setError('Label is required.'); return; }
    if (!draft.startUrl.trim()) { setError('Start URL is required.'); return; }
    try {
      new URL(draft.startUrl);
    } catch {
      setError('Start URL must be a valid absolute URL.');
      return;
    }
    if (draft.maxPages < 1 || draft.maxPages > 50) {
      setError('Max pages must be between 1 and 50.');
      return;
    }
    const cronExpr =
      preset === '__custom__' ? (custom.trim() || null) :
      preset === ''           ? null :
      preset;

    setSaving(true);
    try {
      await onSave({ ...draft, cronExpr });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open={true} onClose={onCancel} maxWidth={560}>
      <Card padding="md" style={{ width: 'min(560px, 92vw)' }}>
        <SectionLabel as="h3" className="text-sm mb-4">
          {isEdit ? 'Edit Crawl Target' : 'New Crawl Target'}
        </SectionLabel>

        {/* `labelId` is dropped from every wiring bag: FormField hands it to the
            consumer but it is not a DOM prop, so spreading it onto a control
            makes React warn. Queued against the library. */}
        <Stack gap="md">
          <FormField label="Label">
            {({ labelId: _l, ...w }) => (
              <Input
                {...w}
                size="sm"
                value={draft.label}
                onChange={e => patch('label', e.target.value)}
                placeholder="Engineering wiki"
              />
            )}
          </FormField>

          <FormField label="Start URL">
            {({ labelId: _l, ...w }) => (
              <Input
                {...w}
                mono
                size="sm"
                value={draft.startUrl}
                onChange={e => patch('startUrl', e.target.value)}
                placeholder="https://example.com/docs"
              />
            )}
          </FormField>

          <Inline gap="md" className="grid grid-cols-2">
            <FormField label="Mode" hint={MODES.find(m => m.value === draft.mode)?.desc}>
              {({ labelId: _l, ...w }) => (
                <Select
                  {...w}
                  size="sm"
                  value={draft.mode}
                  onChange={e => patch('mode', e.target.value as CrawlMode)}
                  options={MODES.map(m => ({ value: m.value, label: m.label }))}
                />
              )}
            </FormField>

            <FormField label={`Max pages: ${draft.maxPages}`}>
              {({ labelId: _l, ...w }) => (
                <Stack gap="none">
                  {/* Raw range input: `Slider` is exported only from the package
                      root, and importing the root pulls @tiptap/react — a peer
                      dep this portal never installed — into `vite build`.
                      Already queued. */}
                  <input
                    {...w}
                    type="range"
                    min={1}
                    max={50}
                    value={draft.maxPages}
                    onChange={e => patch('maxPages', Number(e.target.value))}
                    aria-label="Maximum pages to crawl"
                    className="w-full accent-primary"
                  />
                  <Inline justify="between">
                    <MetaLine size="xs" items={['1']} />
                    <MetaLine size="xs" items={['50']} />
                  </Inline>
                </Stack>
              )}
            </FormField>
          </Inline>

          {/* Checkbox takes no `label`; its own docs prefer `aria-labelledby`
              over a hand-written aria-label when a visible label exists but
              cannot wrap the control — which is exactly what FormField's
              `labelId` is. */}
          <FormField label="Same-origin only (block links to other domains)" layout="inline">
            {({ labelId, id }) => (
              <Checkbox
                id={id}
                checked={draft.sameOriginOnly}
                onChange={(checked) => patch('sameOriginOnly', checked)}
                aria-labelledby={labelId}
              />
            )}
          </FormField>

          <FormField label="Include pattern (regex, optional)">
            {({ labelId: _l, ...w }) => (
              <Input
                {...w}
                mono
                size="sm"
                value={draft.includePattern ?? ''}
                onChange={e => patch('includePattern', e.target.value || null)}
                placeholder="e.g. /docs/.*"
              />
            )}
          </FormField>

          <FormField
            label="Schedule"
            hint={preset === '__custom__' ? 'Format: minute hour day month weekday — all times UTC' : undefined}
          >
            {({ labelId: _l, ...w }) => (
              <Stack gap="xs">
                <Select
                  {...w}
                  size="sm"
                  value={preset}
                  onChange={e => setPreset(e.target.value)}
                  options={CRON_PRESETS.map(pr => ({ value: pr.expr, label: pr.label }))}
                />
                {preset === '__custom__' && (
                  <Input
                    mono
                    size="sm"
                    value={custom}
                    onChange={e => setCustom(e.target.value)}
                    placeholder="e.g. 0 */4 * * *"
                    aria-label="Custom cron expression"
                  />
                )}
              </Stack>
            )}
          </FormField>

          {/* Checkbox takes no `label`; its own docs prefer `aria-labelledby`
              over a hand-written aria-label when a visible label exists but
              cannot wrap the control — which is exactly what FormField's
              `labelId` is. */}
          <FormField label="Enabled (run on schedule)" layout="inline">
            {({ labelId, id }) => (
              <Checkbox
                id={id}
                checked={draft.enabled}
                onChange={(checked) => patch('enabled', checked)}
                aria-labelledby={labelId}
              />
            )}
          </FormField>

          {error && <InlineAlert tone="error">{error}</InlineAlert>}

          <Inline gap="sm" justify="end" className="mt-2">
            <Button variant="secondary" onClick={onCancel}>Cancel</Button>
            <Button variant="primary" onClick={submit} disabled={saving}>
              {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Create target'}
            </Button>
          </Inline>
        </Stack>
      </Card>
    </Modal>
  );
}
