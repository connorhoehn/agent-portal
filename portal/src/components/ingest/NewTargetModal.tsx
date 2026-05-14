import { useState } from 'react';
import { Card, Modal } from '@connorhoehnslalom/ui-components/shared';
import type { CrawlMode, CrawlTarget } from './types';
import {
  inputStyle,
  labelStyle,
  primaryBtnStyle,
  secondaryBtnStyle,
} from './ui';

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
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open={true} onClose={onCancel} maxWidth={560}>
      <Card padding="md" style={{ width: 'min(560px, 92vw)' }}>
        <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 16 }}>
          {isEdit ? 'Edit Crawl Target' : 'New Crawl Target'}
        </h3>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <label style={labelStyle}>Label</label>
            <input
              value={draft.label}
              onChange={e => patch('label', e.target.value)}
              placeholder="Engineering wiki"
              style={inputStyle}
            />
          </div>

          <div>
            <label style={labelStyle}>Start URL</label>
            <input
              value={draft.startUrl}
              onChange={e => patch('startUrl', e.target.value)}
              placeholder="https://example.com/docs"
              style={{ ...inputStyle, fontFamily: 'monospace' }}
            />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <label style={labelStyle}>Mode</label>
              <select
                value={draft.mode}
                onChange={e => patch('mode', e.target.value as CrawlMode)}
                style={inputStyle}
              >
                {MODES.map(m => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
              <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)', marginTop: 3 }}>
                {MODES.find(m => m.value === draft.mode)?.desc}
              </div>
            </div>

            <div>
              <label style={labelStyle}>
                Max pages: <strong>{draft.maxPages}</strong>
              </label>
              <input
                type="range"
                min={1}
                max={50}
                value={draft.maxPages}
                onChange={e => patch('maxPages', Number(e.target.value))}
                style={{ width: '100%' }}
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--color-text-tertiary)' }}>
                <span>1</span><span>50</span>
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              id="sameOrigin"
              type="checkbox"
              checked={draft.sameOriginOnly}
              onChange={e => patch('sameOriginOnly', e.target.checked)}
            />
            <label htmlFor="sameOrigin" style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
              Same-origin only (block links to other domains)
            </label>
          </div>

          <div>
            <label style={labelStyle}>Include pattern (regex, optional)</label>
            <input
              value={draft.includePattern ?? ''}
              onChange={e => patch('includePattern', e.target.value || null)}
              placeholder="e.g. /docs/.*"
              style={{ ...inputStyle, fontFamily: 'monospace' }}
            />
          </div>

          <div>
            <label style={labelStyle}>Schedule</label>
            <select
              value={preset}
              onChange={e => setPreset(e.target.value)}
              style={inputStyle}
            >
              {CRON_PRESETS.map(p => (
                <option key={p.expr || p.label} value={p.expr}>{p.label}</option>
              ))}
            </select>
            {preset === '__custom__' && (
              <input
                value={custom}
                onChange={e => setCustom(e.target.value)}
                placeholder="e.g. 0 */4 * * *"
                style={{ ...inputStyle, fontFamily: 'monospace', marginTop: 6 }}
              />
            )}
            {preset === '__custom__' && (
              <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)', marginTop: 3 }}>
                Format: minute hour day month weekday — all times UTC
              </div>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              id="enabled"
              type="checkbox"
              checked={draft.enabled}
              onChange={e => patch('enabled', e.target.checked)}
            />
            <label htmlFor="enabled" style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
              Enabled (run on schedule)
            </label>
          </div>

          {error && (
            <div style={{ fontSize: 12, color: 'var(--color-danger)' }}>{error}</div>
          )}

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
            <button onClick={onCancel} style={secondaryBtnStyle}>Cancel</button>
            <button onClick={submit} disabled={saving} style={primaryBtnStyle(saving)}>
              {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Create target'}
            </button>
          </div>
        </div>
      </Card>
    </Modal>
  );
}
