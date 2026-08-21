// Prompt Studio — Bedrock Prompt Library browser, editor, and live test harness.
//
// Layout: left prompt list → center workspace with version dropdown in header.
// Auto-selects first prompt on load. Variables auto-extracted from {{placeholders}}.
// Modes: view (read-only template) | edit (side-by-side, publish/draft) | test (live invoke + AI Assist)

import { useState, useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import { Button } from '@connorhoehnslalom/ui-components/shared';
import { useCapabilities } from '../../lib/capabilities';
import { useFetch } from '../../hooks/useFetch.js';
import {
  usePromptList,
  usePromptVersions,
  usePromptVersionDetail,
  createPrompt,
  saveDraft,
  publishVersion,
  invokePrompt,
  optimizePrompt,
  type OptimizeMetric,
} from '../../components/canary/usePromptLibrary.js';
import type { PromptLibraryEntry } from '../../components/canary/types.js';

// ── Local types ───────────────────────────────────────────────────────────────

interface Selection {
  promptId: string;
  promptName: string;
  promptArn: string;
  version: string;
}

type PanelMode = 'view' | 'edit' | 'test' | 'create';

// ── Timestamp helpers ─────────────────────────────────────────────────────────

function fmtRelative(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

const updatedAtStyle: CSSProperties = {
  fontSize: 10,
  color: 'var(--color-text-tertiary, #94a3b8)',
  marginTop: 4,
};

// ── Variable type detection ───────────────────────────────────────────────────

type VarType = 'person' | 'skill' | 'textarea' | 'text';

function detectVarType(name: string): VarType {
  const n = name.toLowerCase().replace(/[^a-z]/g, '');
  if (/person|name|employee|author|reviewer|user|who/.test(n)) return 'person';
  if (/skill|topic|expertise|technology|domain|area|subject/.test(n)) return 'skill';
  if (/response|content|message|output|body|description|summary|feedback|answer/.test(n)) return 'textarea';
  return 'text';
}

// ── Data hooks for variable autocomplete ─────────────────────────────────────

function usePersonOptions(): string[] {
  const [names, setNames] = useState<string[]>([]);
  useEffect(() => {
    fetch('/api/scores/leaderboard?limit=50')
      .then(r => r.json())
      .then((d: { entries?: { name: string }[] }) =>
        setNames((d.entries ?? []).map(e => e.name).filter(Boolean)),
      )
      .catch(() => undefined);
  }, []);
  return names;
}

function useSkillOptions(): string[] {
  const [names, setNames] = useState<string[]>([]);
  useEffect(() => {
    fetch('/api/scores/skills?limit=60')
      .then(r => r.json())
      .then((d: unknown) =>
        setNames((Array.isArray(d) ? (d as { name: string }[]) : []).map(s => s.name).filter(Boolean)),
      )
      .catch(() => undefined);
  }, []);
  return names;
}

// Combobox + textarea styles — hoisted before VarCombobox/VariableInput to satisfy TS 5.9.
const comboboxContainerStyle: CSSProperties = { position: 'relative' };
const comboboxDropStyle: CSSProperties = {
  position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 200,
  background: '#fff', border: '1px solid var(--color-border, #e2e8f0)',
  borderTop: 'none', borderRadius: '0 0 4px 4px',
  boxShadow: '0 4px 12px rgba(0,0,0,0.08)', maxHeight: 200, overflowY: 'auto',
  listStyle: 'none', margin: 0, padding: 0,
};
const comboboxItemStyle: CSSProperties = {
  padding: '7px 10px', fontSize: 12, cursor: 'pointer',
  color: 'var(--color-text-primary, #0f172a)', userSelect: 'none',
};
const comboboxItemHighStyle: CSSProperties = {
  padding: '7px 10px', fontSize: 12, cursor: 'pointer',
  background: 'var(--color-primary-subtle, #ede9fe)', color: 'var(--color-optimize)', userSelect: 'none',
};
const testVarTextareaStyle: CSSProperties = {
  padding: '7px 10px', fontSize: 12, border: '1px solid var(--color-border, #e2e8f0)',
  borderRadius: 4, background: '#fff', color: 'var(--color-text-primary, #0f172a)',
  outline: 'none', fontFamily: 'inherit', resize: 'vertical', minHeight: 72,
  width: '100%', boxSizing: 'border-box', lineHeight: 1.5,
};

// ── VarCombobox — searchable autocomplete that still allows free text ─────────

function VarCombobox({
  value,
  onChange,
  options,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  placeholder: string;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const filtered = value
    ? options.filter(o => o.toLowerCase().includes(value.toLowerCase())).slice(0, 8)
    : options.slice(0, 8);

  function pick(v: string): void {
    onChange(v);
    setOpen(false);
    setHighlighted(0);
  }

  function handleKey(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'Enter') {
        setOpen(true);
        setHighlighted(0);
        e.preventDefault();
      }
      return;
    }
    if (e.key === 'Escape') { setOpen(false); return; }
    if (e.key === 'ArrowDown') {
      setHighlighted(h => Math.min(h + 1, filtered.length - 1));
      e.preventDefault();
    } else if (e.key === 'ArrowUp') {
      setHighlighted(h => Math.max(h - 1, 0));
      e.preventDefault();
    } else if (e.key === 'Enter' && filtered[highlighted] !== undefined) {
      pick(filtered[highlighted]);
      e.preventDefault();
    }
  }

  useEffect(() => {
    if (!open) return;
    function handleOutside(e: MouseEvent): void {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, [open]);

  return (
    <div ref={containerRef} style={comboboxContainerStyle}>
      <input
        type="text"
        value={value}
        onChange={e => { onChange(e.target.value); setOpen(true); setHighlighted(0); }}
        onFocus={() => { setOpen(true); setHighlighted(0); }}
        onKeyDown={handleKey}
        placeholder={placeholder}
        style={testVarInputStyle}
        autoComplete="off"
      />
      {open && filtered.length > 0 && (
        <ul style={comboboxDropStyle} role="listbox">
          {filtered.map((item, i) => (
            <li
              key={item}
              role="option"
              aria-selected={i === highlighted}
              onMouseDown={() => pick(item)}
              onMouseEnter={() => setHighlighted(i)}
              style={i === highlighted ? comboboxItemHighStyle : comboboxItemStyle}
            >
              {item}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── VariableInput — routes each variable to the right control ─────────────────

function VariableInput({
  name,
  value,
  onChange,
  personOptions,
  skillOptions,
}: {
  name: string;
  value: string;
  onChange: (v: string) => void;
  personOptions: string[];
  skillOptions: string[];
}): React.ReactElement {
  const type = detectVarType(name);
  if (type === 'person') {
    return (
      <VarCombobox
        value={value}
        onChange={onChange}
        options={personOptions}
        placeholder="Select or type a person…"
      />
    );
  }
  if (type === 'skill') {
    return (
      <VarCombobox
        value={value}
        onChange={onChange}
        options={skillOptions}
        placeholder="Select or type a topic / skill…"
      />
    );
  }
  if (type === 'textarea') {
    return (
      <textarea
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={`Value for ${name}…`}
        style={testVarTextareaStyle}
        rows={3}
      />
    );
  }
  return (
    <input
      type="text"
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={`Value for ${name}…`}
      style={testVarInputStyle}
    />
  );
}

// ── Max-token preset options ───────────────────────────────────────────────────

const MAX_TOKEN_OPTIONS = [
  { value: '256',  label: '256 — short' },
  { value: '512',  label: '512 — brief' },
  { value: '1024', label: '1 K — standard' },
  { value: '2048', label: '2 K — moderate' },
  { value: '4096', label: '4 K — detailed' },
  { value: '8192', label: '8 K — long form' },
] as const;

// ── Template highlighter ──────────────────────────────────────────────────────

function HighlightedLine({ line }: { line: string }): React.ReactElement {
  const parts = line.split(/({{[^}]+}})/g);
  return (
    <>
      {parts.map((part, i) =>
        /^{{[^}]+}}$/.test(part) ? (
          <span key={i} style={{ color: 'var(--color-optimize)', fontWeight: 600 }}>{part}</span>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

function TemplateHighlighted({ text }: { text: string }): React.ReactElement {
  const lines = text.split('\n');
  const gutterWidth = String(lines.length).length;
  return (
    <div style={lineNumberWrapStyle}>
      {/* gutter */}
      <div style={gutterStyle} aria-hidden>
        {lines.map((_, i) => (
          <div key={i} style={gutterLineStyle}>
            {String(i + 1).padStart(gutterWidth, ' ')}
          </div>
        ))}
      </div>
      {/* code */}
      <pre style={preStyle}>
        {lines.map((line, i) => (
          <div key={i} style={codeLineStyle}>
            <HighlightedLine line={line} />
          </div>
        ))}
      </pre>
    </div>
  );
}

// ── Line-numbered editable textarea ───────────────────────────────────────────

function LineNumberedTextarea({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}): React.ReactElement {
  const gutterRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const lines = value.split('\n');
  const lineCount = Math.max(lines.length, 1);
  const gutterWidth = String(lineCount).length;

  const syncScroll = () => {
    if (gutterRef.current && textareaRef.current) {
      gutterRef.current.scrollTop = textareaRef.current.scrollTop;
    }
  };

  return (
    <div style={lnWrapStyle}>
      <div ref={gutterRef} style={lnGutterStyle} aria-hidden>
        {Array.from({ length: lineCount }, (_, i) => (
          <div key={i} style={gutterLineStyle}>
            {String(i + 1).padStart(gutterWidth, ' ')}
          </div>
        ))}
      </div>
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onScroll={syncScroll}
        placeholder={placeholder}
        spellCheck={false}
        style={lnTextareaStyle}
      />
    </div>
  );
}

// ── Version dropdown ──────────────────────────────────────────────────────────

function VersionSelect({
  promptId,
  value,
  onChange,
}: {
  promptId: string;
  value: string;
  onChange: (v: string) => void;
}): React.ReactElement {
  const { versions } = usePromptVersions(promptId);
  const numbered = versions.filter((v) => v.version !== 'DRAFT' && !v.isDraft);

  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} style={versionSelectStyle}>
      <option value="DRAFT">DRAFT</option>
      {numbered.map((v) => (
        <option key={v.version} value={v.version}>
          v{v.version}
        </option>
      ))}
    </select>
  );
}

// ── ViewPanel ─────────────────────────────────────────────────────────────────

function ViewPanel({
  selection,
  onVersionChange,
  onEdit,
  onTest,
  canManage,
}: {
  selection: Selection;
  onVersionChange: (v: string) => void;
  onEdit: () => void;
  onTest: () => void;
  /** ManageCanary — Test/Edit affordances hide without it. */
  canManage: boolean;
}): React.ReactElement {
  const { detail, loading, error } = usePromptVersionDetail(selection.promptId, selection.version);

  const templateText = detail?.variant?.templateText ?? '';
  const modelId = detail?.variant?.modelId ?? '';
  const inf = detail?.variant?.inferenceConfig;
  const variables = [...new Set(templateText.match(/{{[^}]+}}/g) ?? [])];

  if (loading) {
    return (
      <div style={workspacePadStyle}>
        <div style={{ ...skeletonStyle, height: 28, width: 280, marginBottom: 12 }} />
        <div style={{ ...skeletonStyle, height: 360 }} />
      </div>
    );
  }

  if (error) {
    return (
      <div style={workspacePadStyle}>
        <div style={errorBoxStyle}>Failed to load: {error}</div>
      </div>
    );
  }

  return (
    <div style={workspacePanelStyle}>
      <div style={workspaceHeaderStyle}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={promptTitleStyle}>{selection.promptName}</div>
          {detail?.arn && (
            <code style={arnStyle} title={detail.arn}>{detail.arn}</code>
          )}
          {detail?.updatedAt && (
            <div style={updatedAtStyle}>Updated {fmtRelative(detail.updatedAt)}</div>
          )}
        </div>
        <div style={headerActionsStyle}>
          <VersionSelect
            promptId={selection.promptId}
            value={selection.version}
            onChange={onVersionChange}
          />
          {canManage && (
            <>
              <Button variant="ghost" onClick={onTest}>
                Test ▶
              </Button>
              <Button variant="primary" onClick={onEdit}>
                Edit / new version
              </Button>
            </>
          )}
        </div>
      </div>

      <div style={templateScrollStyle}>
        {templateText ? (
          <TemplateHighlighted text={templateText} />
        ) : (
          <p style={emptyTemplateMsgStyle}>(no template text for this version)</p>
        )}
      </div>

      {(variables.length > 0 || modelId || inf) && (
        <div style={infoBarStyle}>
          {variables.length > 0 && (
            <div style={infoSectionStyle}>
              <span style={infoLabelStyle}>Variables</span>
              {variables.map((v) => (
                <span key={v} style={varChipStyle}>{v}</span>
              ))}
            </div>
          )}
          {(modelId || inf) && (
            <div style={infoSectionStyle}>
              {modelId && <span style={modelChipStyle}>{modelId}</span>}
              {inf?.temperature !== undefined && (
                <span style={paramChipStyle}>temp {inf.temperature}</span>
              )}
              {inf?.maxTokens !== undefined && (
                <span style={paramChipStyle}>{inf.maxTokens} tok</span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── EditPanel ─────────────────────────────────────────────────────────────────

function EditPanel({
  selection,
  onCancel,
  onPublished,
  onDraftSaved,
}: {
  selection: Selection;
  onCancel: () => void;
  onPublished: (newVersion: string, newArn: string) => void;
  onDraftSaved: () => void;
}): React.ReactElement {
  const { detail, loading } = usePromptVersionDetail(selection.promptId, selection.version);

  const baselineText = detail?.variant?.templateText ?? '';
  const baselineModelId = detail?.variant?.modelId ?? '';
  const baselineInf = detail?.variant?.inferenceConfig;

  const [challengerText, setChallengerText] = useState('');
  const [temperature, setTemperature] = useState('');
  const [maxTokens, setMaxTokens] = useState('2048');
  const [modelId, setModelId] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  useEffect(() => {
    if (detail) {
      setChallengerText(detail.variant?.templateText ?? '');
      setModelId(detail.variant?.modelId ?? '');
      setTemperature(
        detail.variant?.inferenceConfig?.temperature !== undefined
          ? String(detail.variant.inferenceConfig.temperature)
          : '',
      );
      const existingMax = detail.variant?.inferenceConfig?.maxTokens;
      setMaxTokens(
        existingMax !== undefined && MAX_TOKEN_OPTIONS.some(o => o.value === String(existingMax))
          ? String(existingMax)
          : '2048',
      );
    }
  }, [detail]);

  async function handlePublish(): Promise<void> {
    setSaving(true);
    setSaveError(null);
    setSuccessMsg(null);
    try {
      const inferenceConfig: { temperature?: number; maxTokens?: number } = {};
      if (temperature !== '') inferenceConfig.temperature = parseFloat(temperature);
      if (maxTokens !== '') inferenceConfig.maxTokens = parseInt(maxTokens, 10);
      await saveDraft(
        selection.promptId, selection.promptName, challengerText,
        modelId || undefined,
        Object.keys(inferenceConfig).length > 0 ? inferenceConfig : undefined,
      );
      const result = await publishVersion(selection.promptId, description || undefined);
      setSuccessMsg(`Published as v${result.version}`);
      onPublished(result.version, result.arn);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveDraft(): Promise<void> {
    setSaving(true);
    setSaveError(null);
    setSuccessMsg(null);
    try {
      const inferenceConfig: { temperature?: number; maxTokens?: number } = {};
      if (temperature !== '') inferenceConfig.temperature = parseFloat(temperature);
      if (maxTokens !== '') inferenceConfig.maxTokens = parseInt(maxTokens, 10);
      await saveDraft(
        selection.promptId, selection.promptName, challengerText,
        modelId || undefined,
        Object.keys(inferenceConfig).length > 0 ? inferenceConfig : undefined,
      );
      setSuccessMsg('Saved to DRAFT');
      onDraftSaved();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div style={workspacePadStyle}>
        <div style={{ ...skeletonStyle, height: 28, width: 240, marginBottom: 16 }} />
        <div style={{ ...skeletonStyle, height: 300 }} />
      </div>
    );
  }

  const versionLabel = selection.version === 'DRAFT' ? 'DRAFT' : `v${selection.version}`;

  return (
    <div style={editPanelStyle}>
      <div style={editHeaderStyle}>
        <div>
          <div style={promptTitleStyle}>{selection.promptName}</div>
          <div style={editSubtitleStyle}>Creating new version from {versionLabel}</div>
        </div>
        <Button variant="secondary" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
      </div>

      <div style={panesStyle}>
        <div style={paneStyle}>
          <div style={paneHeaderStyle}>Baseline — {versionLabel}</div>
          <div style={viewerBoxStyle}>
            {baselineText
              ? <TemplateHighlighted text={baselineText} />
              : <pre style={{ ...preStyle, color: '#94a3b8', fontStyle: 'italic' }}>(empty)</pre>}
          </div>
          {(baselineModelId || baselineInf) && (
            <div style={baselineChipsStyle}>
              {baselineModelId && <span style={paramChipStyle}>{baselineModelId}</span>}
              {baselineInf?.temperature !== undefined && (
                <span style={paramChipStyle}>temp {baselineInf.temperature}</span>
              )}
              {baselineInf?.maxTokens !== undefined && (
                <span style={paramChipStyle}>{baselineInf.maxTokens} tok</span>
              )}
            </div>
          )}
        </div>
        <div style={paneStyle}>
          <div style={paneHeaderStyle}>New version</div>
          <LineNumberedTextarea
            value={challengerText}
            onChange={setChallengerText}
            placeholder="Edit the prompt template here…"
          />
        </div>
      </div>

      <div style={inferenceCardStyle}>
        <span style={inferenceTitleStyle}>Inference settings (new version)</span>
        <div style={inferenceRowStyle}>
          <label style={fieldLabelStyle}>
            <span style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>Temperature</span>
              <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                {temperature !== '' ? parseFloat(temperature).toFixed(2) : (baselineInf?.temperature !== undefined ? String(baselineInf.temperature) : '0.70')}
              </span>
            </span>
            <input
              type="range" min={0} max={1} step={0.01}
              value={temperature !== '' ? temperature : (baselineInf?.temperature ?? 0.7)}
              onChange={(e) => setTemperature(e.target.value)}
              style={{ width: '100%', marginTop: 6, accentColor: 'var(--color-optimize)' }}
            />
          </label>
          <label style={fieldLabelStyle}>
            Max tokens
            <select
              value={maxTokens}
              onChange={(e) => setMaxTokens(e.target.value)}
              style={smallInputStyle}
            >
              {MAX_TOKEN_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>
          <label style={{ ...fieldLabelStyle, flex: 2 }}>
            Model ID
            <input
              type="text"
              value={modelId}
              onChange={(e) => setModelId(e.target.value)}
              placeholder="amazon.nova-pro-v1:0"
              style={{ ...smallInputStyle, fontFamily: 'monospace' }}
            />
          </label>
        </div>
      </div>

      <div style={actionBarWrapStyle}>
        <label style={descLabelStyle}>
          What changed?
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="e.g. 'More concise, removed redundant instructions'"
            style={{ ...smallInputStyle, width: '100%', boxSizing: 'border-box', marginTop: 4 }}
            disabled={saving}
          />
        </label>
        {successMsg && <div style={successMsgStyle}>{successMsg}</div>}
        {saveError && <div style={errorMsgStyle}>{saveError}</div>}
        <div style={actionBarStyle}>
          <div style={{ flex: 1 }} />
          <Button
            variant="secondary"
            onClick={() => { void handleSaveDraft(); }}
            disabled={saving || !challengerText.trim()}
            title="Overwrite DRAFT without creating a numbered version"
          >
            Save draft
          </Button>
          <Button
            variant="primary"
            onClick={() => { void handlePublish(); }}
            disabled={saving || !challengerText.trim()}
          >
            {saving ? 'Publishing…' : 'Publish new version →'}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Guardrail overlay ─────────────────────────────────────────────────────────

interface GuardrailIntervention {
  action?: string;
  type?: string;
  text?: string;
}

function GuardrailBanner({ interventions }: { interventions: GuardrailIntervention[] }): React.ReactElement | null {
  if (interventions.length === 0) return null;
  const blocked = interventions.filter(i => i.action === 'BLOCKED' || i.action === 'ANONYMIZED');
  if (blocked.length === 0) return null;
  return (
    <div style={guardrailBannerStyle}>
      <span style={{ fontWeight: 700 }}>Guardrail triggered</span>
      {blocked.map((b, i) => (
        <span key={i} style={guardrailChipStyle}>{b.type ?? b.action}</span>
      ))}
    </div>
  );
}

// ── GuardrailSelect ───────────────────────────────────────────────────────────

interface GuardrailSnapshot {
  id: string;
  name: string;
  version: string;
}

function GuardrailSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (id: string) => void;
}): React.ReactElement {
  const { data, isLoading } = useFetch<GuardrailSnapshot>('/api/capabilities/guardrail', 0);

  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={testVarInputStyle}
      disabled={isLoading}
    >
      <option value="">None — skip guardrail</option>
      {data && (
        <option value={data.id}>
          {data.name} (v{data.version})
        </option>
      )}
    </select>
  );
}

// ── TestPanel ─────────────────────────────────────────────────────────────────

function TestPanel({
  selection,
  onClose,
}: {
  selection: Selection;
  onClose: () => void;
}): React.ReactElement {
  const { detail, loading: detailLoading } = usePromptVersionDetail(selection.promptId, selection.version);

  const templateText = detail?.variant?.templateText ?? '';
  const rawVars = [...new Set(templateText.match(/{{[^}]+}}/g) ?? [])];
  const varNames = rawVars.map(v => v.slice(2, -2).trim());

  const personOptions = usePersonOptions();
  const skillOptions = useSkillOptions();

  const [varValues, setVarValues] = useState<Record<string, string>>({});
  const [guardrailId, setGuardrailId] = useState('');
  const [running, setRunning] = useState(false);
  const [output, setOutput] = useState('');
  const [guardrailEvents, setGuardrailEvents] = useState<GuardrailIntervention[]>([]);
  const [runError, setRunError] = useState<string | null>(null);

  const [assistOpen, setAssistOpen] = useState(false);
  const [metric, setMetric] = useState<OptimizeMetric>('clarity');
  const [optimizing, setOptimizing] = useState(false);
  const [optimizedText, setOptimizedText] = useState('');
  const [optimizeError, setOptimizeError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  function setVar(name: string, value: string): void {
    setVarValues(prev => ({ ...prev, [name]: value }));
  }

  async function handleRun(): Promise<void> {
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
        onGuardrail: (trace: unknown) => {
          const t = trace as { inputAssessment?: Record<string, { topicPolicy?: { topics?: GuardrailIntervention[] }; sensitiveInformationPolicy?: { piiEntities?: GuardrailIntervention[] } }> };
          const assessments = Object.values(t.inputAssessment ?? {});
          const items: GuardrailIntervention[] = [];
          for (const a of assessments) {
            for (const topic of a.topicPolicy?.topics ?? []) items.push(topic);
            for (const pii of a.sensitiveInformationPolicy?.piiEntities ?? []) items.push(pii);
          }
          setGuardrailEvents(prev => [...prev, ...items]);
        },
      });
    } catch (e) {
      setRunError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  async function handleOptimize(): Promise<void> {
    setOptimizing(true);
    setOptimizedText('');
    setOptimizeError(null);
    setCopied(false);
    try {
      const result = await optimizePrompt(selection.promptId, templateText, metric);
      setOptimizedText(result);
    } catch (e) {
      setOptimizeError(e instanceof Error ? e.message : String(e));
    } finally {
      setOptimizing(false);
    }
  }

  const versionLabel = selection.version === 'DRAFT' ? 'DRAFT' : `v${selection.version}`;

  return (
    <div style={testPanelStyle}>
      <div style={testHeaderStyle}>
        <div>
          <div style={promptTitleStyle}>{selection.promptName}</div>
          <div style={{ fontSize: 12, color: 'var(--color-text-tertiary, #94a3b8)', marginTop: 2 }}>
            Testing {versionLabel}
          </div>
        </div>
        <Button variant="secondary" onClick={onClose}>Close</Button>
      </div>

      <div style={testBodyStyle}>
        <div style={testLeftStyle}>
          {detailLoading ? (
            <div style={{ ...skeletonStyle, height: 80 }} />
          ) : (
            <>
              {varNames.length > 0 && (
                <div style={testSectionStyle}>
                  <div style={testSectionTitleStyle}>Variables</div>
                  {varNames.map(name => (
                    <label key={name} style={testVarLabelStyle}>
                      <span style={testVarNameStyle}>{`{{${name}}}`}</span>
                      <VariableInput
                        name={name}
                        value={varValues[name] ?? ''}
                        onChange={v => setVar(name, v)}
                        personOptions={personOptions}
                        skillOptions={skillOptions}
                      />
                    </label>
                  ))}
                </div>
              )}

              <div style={testSectionStyle}>
                <div style={testSectionTitleStyle}>Guardrail (optional)</div>
                <GuardrailSelect value={guardrailId} onChange={setGuardrailId} />
              </div>
            </>
          )}

          <Button
            variant="primary"
            onClick={() => { void handleRun(); }}
            disabled={running || detailLoading}
          >
            {running ? 'Running…' : 'Run prompt ▶'}
          </Button>

          <GuardrailBanner interventions={guardrailEvents} />

          <div style={testSectionStyle}>
            <div style={testSectionTitleStyle}>Output</div>
            <div style={outputBoxStyle}>
              {runError && <span style={{ color: '#991b1b' }}>{runError}</span>}
              {!runError && !output && !running && (
                <span style={{ color: 'var(--color-text-tertiary, #94a3b8)', fontStyle: 'italic' }}>
                  Response will appear here…
                </span>
              )}
              {running && !output && (
                <span style={{ color: 'var(--color-text-tertiary, #94a3b8)' }}>Waiting for first token…</span>
              )}
              <span style={{ whiteSpace: 'pre-wrap' }}>{output}</span>
              {running && output && <span style={cursorStyle}>▌</span>}
            </div>
          </div>
        </div>

        <div style={testRightStyle}>
          <button
            type="button"
            onClick={() => setAssistOpen(v => !v)}
            style={assistToggleStyle}
          >
            <span>AI Assist</span>
            <span style={{ fontSize: 10, opacity: 0.6 }}>{assistOpen ? '▾' : '▸'}</span>
          </button>

          {assistOpen && (
            <div style={assistBodyStyle}>
              <p style={assistHintStyle}>
                Let Nova Pro rewrite the current template for a specific goal.
                Review the result and copy it to your editor.
              </p>

              <label style={fieldLabelStyle}>
                Optimize for
                <select
                  value={metric}
                  onChange={e => setMetric(e.target.value as OptimizeMetric)}
                  style={{ ...smallInputStyle, marginTop: 4, width: '100%' }}
                >
                  <option value="clarity">Clarity — clearer instructions</option>
                  <option value="brevity">Brevity — fewer tokens</option>
                  <option value="safety">Safety — reduce harmful output risk</option>
                  <option value="groundedness">Groundedness — stick to facts</option>
                </select>
              </label>

              <Button
                variant="primary"
                onClick={() => { void handleOptimize(); }}
                disabled={optimizing || !templateText}
                style={{ background: 'var(--color-optimize)', borderColor: 'var(--color-optimize)', color: '#fff' }}
              >
                {optimizing ? 'Optimizing…' : 'Optimize template'}
              </Button>

              {optimizeError && (
                <div style={errorBoxStyle}>{optimizeError}</div>
              )}

              {optimizedText && (
                <div style={optimizedBlockStyle}>
                  <div style={testSectionTitleStyle}>Suggested rewrite</div>
                  <pre style={{ ...preStyle, fontSize: 11, padding: '10px 12px', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 4 }}>
                    {optimizedText}
                  </pre>
                  {!copied ? (
                    <Button
                      variant="secondary"
                      onClick={() => {
                        navigator.clipboard.writeText(optimizedText).catch(() => undefined);
                        setCopied(true);
                      }}
                      style={{ borderColor: 'var(--color-optimize)', color: 'var(--color-optimize)' }}
                    >
                      Copy to clipboard
                    </Button>
                  ) : (
                    <span style={{ fontSize: 11, color: '#059669' }}>Copied ✓</span>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Starter templates ─────────────────────────────────────────────────────────

const STARTER_TEMPLATES: { label: string; hint: string; template: string }[] = [
  {
    label: 'Expert Finder',
    hint: 'Find top experts for a topic',
    template: `You are an organizational intelligence assistant.

Find the top experts in {{topic}} across the org.

For each person, provide:
- Name and current role
- Why they are an expert (projects, skills, tenure)
- Best way to engage them

Org context: {{org_context}}`,
  },
  {
    label: 'Candidate Brief',
    hint: 'Summarize a person for a role evaluation',
    template: `You are an HR analyst preparing a candidate brief.

Evaluate {{person_name}} for the {{role}} role.

Include:
- Current role and team
- Key skills and expertise areas
- Notable projects and contributions
- Collaboration patterns and reputation

Background: {{summary}}`,
  },
  {
    label: 'Decision Summary',
    hint: 'Summarize an architectural or product decision',
    template: `You are a technical writer summarizing a decision record.

Summarize the following decision for {{audience}}:

Decision: {{decision_title}}
Context: {{context}}
Options considered: {{options}}
Outcome: {{outcome}}

Keep it concise. Highlight the key tradeoff that drove the choice.`,
  },
  {
    label: 'Skill Gap',
    hint: 'Compare required skills against org capabilities',
    template: `You are a workforce planning analyst.

Assess the skill coverage for {{role}} on the {{team_name}} team.

Required skills: {{required_skills}}

For each required skill, identify:
1. Who in the team already covers it
2. Gaps that need hiring or training
3. Adjacent experts who could upskill quickly`,
  },
  {
    label: 'Org Briefing',
    hint: 'One-page briefing on a person for leadership',
    template: `You are an executive briefing assistant.

Prepare a concise briefing on {{person_name}} for {{audience}}.

Cover:
- Role, team, and tenure
- Top 3 areas of expertise with evidence
- Key ongoing projects and impact
- Primary collaborators and influence network

Keep it to 200 words or fewer.`,
  },
];

function starterChipStyle(active: boolean): CSSProperties {
  return {
    fontSize: 10, padding: '2px 8px', borderRadius: 10, cursor: 'pointer',
    fontFamily: 'inherit', fontWeight: active ? 600 : 400, border: '1px solid',
    borderColor: active ? 'var(--color-optimize)' : 'var(--color-border, #e2e8f0)',
    background: active ? '#ede9fe' : 'var(--color-surface, #fff)',
    color: active ? 'var(--color-optimize)' : 'var(--color-text-secondary)',
    transition: 'all 0.1s',
  };
}

// ── CreatePanel ───────────────────────────────────────────────────────────────

function CreatePanel({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: (id: string, arn: string, name: string) => void;
}): React.ReactElement {
  const [name, setName] = useState('orgiq-');
  const [description, setDescription] = useState('');
  const [templateText, setTemplateText] = useState('');
  const [temperature, setTemperature] = useState('');
  const [maxTokens, setMaxTokens] = useState('2048');
  const [modelId, setModelId] = useState('amazon.nova-pro-v1:0');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const previewVars = [...new Set(templateText.match(/{{[^}]+}}/g) ?? [])];
  const canCreate = name.trim().length > 'orgiq-'.length && templateText.trim().length > 0;

  async function handleCreate(): Promise<void> {
    setSaving(true);
    setSaveError(null);
    try {
      const inferenceConfig: { temperature?: number; maxTokens?: number } = {
        maxTokens: parseInt(maxTokens, 10),
      };
      if (temperature !== '') inferenceConfig.temperature = parseFloat(temperature);

      const result = await createPrompt({
        name: name.trim(),
        templateText,
        modelId: modelId.trim() || 'amazon.nova-pro-v1:0',
        inferenceConfig,
        description: description.trim() || undefined,
      });
      onCreated(result.id, result.arn, result.name);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={createPanelStyle}>
      <div style={editHeaderStyle}>
        <div>
          <div style={promptTitleStyle}>New prompt</div>
          <div style={editSubtitleStyle}>Creates a DRAFT in Bedrock Prompt Library</div>
        </div>
        <Button variant="secondary" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
      </div>

      <div style={createFieldsStyle}>
        {/* Name + description row */}
        <div style={createTopRowStyle}>
          <label style={{ ...fieldLabelStyle, flex: 1 }}>
            Prompt name <span style={requiredMarkStyle}>*</span>
            <input
              type="text"
              value={name}
              onChange={e => {
                const v = e.target.value;
                setName(v.startsWith('orgiq-') ? v : 'orgiq-');
              }}
              placeholder="orgiq-my-prompt"
              style={{ ...smallInputStyle, marginTop: 4, fontFamily: 'monospace', width: '100%', boxSizing: 'border-box' }}
              disabled={saving}
              autoFocus
            />
          </label>
          <label style={{ ...fieldLabelStyle, flex: 2 }}>
            Description (optional)
            <input
              type="text"
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="What does this prompt do?"
              style={{ ...smallInputStyle, marginTop: 4, width: '100%', boxSizing: 'border-box' }}
              disabled={saving}
            />
          </label>
        </div>

        {/* Template text */}
        <div style={fieldLabelStyle}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
            <span>Template <span style={requiredMarkStyle}>*</span></span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' as const, justifyContent: 'flex-end' }}>
              <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)', marginRight: 2 }}>Start from</span>
              {STARTER_TEMPLATES.map(t => (
                <button
                  key={t.label}
                  type="button"
                  onClick={() => setTemplateText(t.template)}
                  disabled={saving}
                  style={starterChipStyle(templateText === t.template)}
                  title={t.hint}
                >
                  {t.label}
                </button>
              ))}
              {templateText && (
                <button
                  type="button"
                  onClick={() => setTemplateText('')}
                  disabled={saving}
                  title="Clear template"
                  style={{ ...starterChipStyle(false), color: 'var(--color-error, #ef4444)', borderColor: 'var(--color-error, #ef4444)' }}
                >
                  Clear ✕
                </button>
              )}
            </span>
          </div>
          <textarea
            value={templateText}
            onChange={e => setTemplateText(e.target.value)}
            style={createTemplateStyle}
            placeholder={'Write your prompt template here.\n\nUse {{variable_name}} for dynamic slots that callers fill in at runtime.\n\nExample:\nYou are an expert evaluator.\nAssess whether {{person_name}} is a strong fit for {{topic}}.\nTheir background: {{summary}}'}
            spellCheck={false}
            disabled={saving}
          />
        </div>

        {/* Live variable preview */}
        {previewVars.length > 0 && (
          <div style={createVarPreviewStyle}>
            <span style={infoLabelStyle}>Detected variables</span>
            {previewVars.map(v => (
              <span key={v} style={varChipStyle}>{v}</span>
            ))}
          </div>
        )}

        {/* Inference settings */}
        <div style={inferenceCardStyle}>
          <span style={inferenceTitleStyle}>Inference settings</span>
          <div style={inferenceRowStyle}>
            <label style={fieldLabelStyle}>
              <span style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>Temperature</span>
                <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                  {temperature !== '' ? parseFloat(temperature).toFixed(2) : '0.70'}
                </span>
              </span>
              <input
                type="range" min={0} max={1} step={0.01}
                value={temperature !== '' ? temperature : '0.7'}
                onChange={e => setTemperature(e.target.value)}
                style={{ width: '100%', marginTop: 6, accentColor: 'var(--color-optimize)' }}
                disabled={saving}
              />
            </label>
            <label style={fieldLabelStyle}>
              Max tokens
              <select
                value={maxTokens}
                onChange={e => setMaxTokens(e.target.value)}
                style={smallInputStyle}
                disabled={saving}
              >
                {MAX_TOKEN_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </label>
            <label style={{ ...fieldLabelStyle, flex: 2 }}>
              Model ID
              <input
                type="text"
                value={modelId}
                onChange={e => setModelId(e.target.value)}
                placeholder="amazon.nova-pro-v1:0"
                style={{ ...smallInputStyle, fontFamily: 'monospace' }}
                disabled={saving}
              />
            </label>
          </div>
        </div>
      </div>

      <div style={actionBarWrapStyle}>
        {saveError && <div style={errorMsgStyle}>{saveError}</div>}
        <div style={actionBarStyle}>
          <div style={{ flex: 1 }} />
          <Button
            variant="primary"
            onClick={() => { void handleCreate(); }}
            disabled={!canCreate || saving}
          >
            {saving ? 'Creating…' : 'Create prompt →'}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

function PromptsPage(): React.ReactElement {
  // Create/edit/publish/test/optimize all POST the canary prompt library
  // (ManageCanary); reading the library stays open.
  const { can, ready } = useCapabilities();
  const canManage = ready && can('ManageCanary');
  const { prompts, loading: listLoading, error: listError, refresh } = usePromptList();
  const [search, setSearch] = useState('');
  const [selection, setSelection] = useState<Selection | null>(null);
  const [mode, setMode] = useState<PanelMode>('view');
  const [versionRefreshKey, setVersionRefreshKey] = useState(0);

  useEffect(() => {
    if (!selection && prompts.length > 0) {
      const first = prompts[0];
      setSelection({ promptId: first.id, promptName: first.name, promptArn: first.arn, version: 'DRAFT' });
    }
  }, [prompts, selection]);

  const filtered = prompts.filter(
    (p) => !search || p.name.toLowerCase().includes(search.toLowerCase()),
  );

  function handleSelectPrompt(prompt: PromptLibraryEntry): void {
    setSelection({ promptId: prompt.id, promptName: prompt.name, promptArn: prompt.arn, version: 'DRAFT' });
    setMode('view');
  }

  function handleVersionChange(version: string): void {
    if (!selection) return;
    setSelection({ ...selection, version });
    setMode('view');
  }

  function handlePublished(newVersion: string, newArn: string): void {
    if (!selection) return;
    setVersionRefreshKey((k) => k + 1);
    setSelection({ ...selection, version: newVersion, promptArn: newArn });
    setMode('view');
  }

  function handleDraftSaved(): void {
    if (!selection) return;
    setVersionRefreshKey((k) => k + 1);
    setSelection({ ...selection, version: 'DRAFT' });
    setMode('view');
  }

  function handleCreated(newId: string, newArn: string, newName: string): void {
    refresh();
    setSelection({ promptId: newId, promptName: newName, promptArn: newArn, version: 'DRAFT' });
    setMode('view');
  }

  return (
    <div style={pageStyle}>
      <div style={sidebarStyle}>
        <div style={sidebarTopStyle}>
          {canManage && (
            <Button
              variant="primary"
              fullWidth
              onClick={() => { setSelection(null); setMode('create'); }}
              style={{ marginBottom: 8 }}
            >
              + New prompt
            </Button>
          )}
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search prompts…"
            style={searchInputStyle}
          />
        </div>

        <div style={promptListStyle}>
          {listLoading && <div style={listMsgStyle}>Loading…</div>}
          {listError && <div style={{ ...listMsgStyle, color: '#991b1b' }}>{listError}</div>}
          {!listLoading && !listError && filtered.length === 0 && (
            <div style={listMsgStyle}>No prompts found.</div>
          )}
          {filtered.map((prompt) => {
            const active = selection?.promptId === prompt.id;
            return (
              <button
                key={prompt.id}
                type="button"
                style={active ? { ...promptRowStyle, ...promptRowActiveStyle } : promptRowStyle}
                onClick={() => handleSelectPrompt(prompt)}
              >
                <div style={promptNameStyle}>{prompt.name}</div>
                {prompt.description && (
                  <div style={promptDescStyle}>{prompt.description}</div>
                )}
              </button>
            );
          })}
        </div>

        <div style={{ margin: 12 }}>
          <Button variant="secondary" fullWidth onClick={refresh}>
            Refresh library
          </Button>
        </div>
      </div>

      <div style={workspaceStyle}>
        {!selection && !listLoading && (
          <div style={emptyWorkspaceStyle}>
            <svg width="44" height="44" viewBox="0 0 44 44" fill="none" style={{ opacity: 0.2 }} aria-hidden="true">
              <rect x="6" y="8" width="32" height="28" rx="4" stroke="#64748b" strokeWidth="2" />
              <line x1="12" y1="17" x2="32" y2="17" stroke="#64748b" strokeWidth="1.5" strokeLinecap="round" />
              <line x1="12" y1="23" x2="28" y2="23" stroke="#64748b" strokeWidth="1.5" strokeLinecap="round" />
              <line x1="12" y1="29" x2="22" y2="29" stroke="#64748b" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            <p style={emptyWorkspaceMsgStyle}>No prompts in the Bedrock Prompt Library yet.</p>
          </div>
        )}

        {selection && mode === 'view' && (
          <ViewPanel
            key={`${selection.promptId}-${versionRefreshKey}`}
            selection={selection}
            onVersionChange={handleVersionChange}
            onEdit={() => setMode('edit')}
            onTest={() => setMode('test')}
            canManage={canManage}
          />
        )}

        {selection && mode === 'test' && (
          <TestPanel
            key={`${selection.promptId}-${selection.version}-test`}
            selection={selection}
            onClose={() => setMode('view')}
          />
        )}

        {selection && mode === 'edit' && (
          <EditPanel
            key={`${selection.promptId}-${selection.version}-edit`}
            selection={selection}
            onCancel={() => setMode('view')}
            onPublished={handlePublished}
            onDraftSaved={handleDraftSaved}
          />
        )}

        {mode === 'create' && (
          <CreatePanel
            onCancel={() => { if (selection) setMode('view'); }}
            onCreated={handleCreated}
          />
        )}
      </div>
    </div>
  );
}

export default PromptsPage;

// ── Styles ────────────────────────────────────────────────────────────────────

const pageStyle: CSSProperties = {
  display: 'flex',
  height: '100%',
  minHeight: 0,
  margin: -24,
};

const sidebarStyle: CSSProperties = {
  width: 240,
  flexShrink: 0,
  borderRight: '1px solid var(--color-border, #e2e8f0)',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  background: 'var(--color-surface, #fff)',
};

const sidebarTopStyle: CSSProperties = {
  padding: '14px 12px 10px',
  borderBottom: '1px solid var(--color-border, #e2e8f0)',
  flexShrink: 0,
};

const searchInputStyle: CSSProperties = {
  width: '100%',
  padding: '7px 10px',
  fontSize: 12,
  border: '1px solid var(--color-border, #e2e8f0)',
  borderRadius: 5,
  background: 'var(--color-bg, #f8fafc)',
  color: 'var(--color-text-primary, #0f172a)',
  outline: 'none',
  boxSizing: 'border-box',
  fontFamily: 'inherit',
};

const promptListStyle: CSSProperties = {
  flex: 1,
  overflowY: 'auto',
};

const listMsgStyle: CSSProperties = {
  padding: '12px 14px',
  fontSize: 12,
  color: 'var(--color-text-tertiary, #94a3b8)',
};

const promptRowStyle: CSSProperties = {
  display: 'block',
  width: '100%',
  paddingTop: 11,
  paddingRight: 14,
  paddingBottom: 11,
  paddingLeft: 14,
  background: 'transparent',
  borderTop: 'none',
  borderRight: 'none',
  borderBottom: '1px solid var(--color-border, #e2e8f0)',
  borderLeft: 'none',
  cursor: 'pointer',
  textAlign: 'left',
  fontFamily: 'inherit',
  boxSizing: 'border-box',
};

const promptRowActiveStyle: CSSProperties = {
  background: 'var(--color-primary-subtle, #ede9fe)',
  borderLeft: '3px solid var(--color-primary, #6366f1)',
  paddingLeft: 11,
};

const promptNameStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--color-text-primary, #0f172a)',
  lineHeight: 1.4,
  fontFamily: 'monospace',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const promptDescStyle: CSSProperties = {
  fontSize: 11,
  color: 'var(--color-text-tertiary, #94a3b8)',
  marginTop: 3,
  lineHeight: 1.4,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const workspaceStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  overflow: 'auto',
  background: '#fff',
};

const emptyWorkspaceStyle: CSSProperties = {
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 12,
  padding: 40,
};

const emptyWorkspaceMsgStyle: CSSProperties = {
  fontSize: 13,
  color: 'var(--color-text-tertiary, #94a3b8)',
  margin: 0,
};

const workspacePanelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  minHeight: 0,
};

const workspacePadStyle: CSSProperties = {
  padding: 24,
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
};

const workspaceHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 16,
  padding: '20px 24px 16px',
  borderBottom: '1px solid var(--color-border, #e2e8f0)',
  flexShrink: 0,
};

const promptTitleStyle: CSSProperties = {
  fontSize: 15,
  fontWeight: 700,
  color: 'var(--color-text-primary, #0f172a)',
  fontFamily: 'monospace',
  marginBottom: 4,
};

const arnStyle: CSSProperties = {
  fontSize: 10,
  color: 'var(--color-text-tertiary, #94a3b8)',
  fontFamily: 'monospace',
  background: 'var(--color-bg, #f8fafc)',
  padding: '2px 6px',
  borderRadius: 3,
  border: '1px solid var(--color-border, #e2e8f0)',
  display: 'inline-block',
  maxWidth: 480,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  verticalAlign: 'middle',
};

const headerActionsStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexShrink: 0,
};

const versionSelectStyle: CSSProperties = {
  padding: '6px 10px',
  fontSize: 12,
  fontWeight: 600,
  border: '1px solid var(--color-border, #e2e8f0)',
  borderRadius: 4,
  background: 'var(--color-bg, #f8fafc)',
  color: 'var(--color-text-primary, #0f172a)',
  cursor: 'pointer',
  fontFamily: 'monospace',
  outline: 'none',
  minWidth: 90,
};

const templateScrollStyle: CSSProperties = {
  flex: 1,
  overflow: 'auto',
  borderBottom: '1px solid var(--color-border, #e2e8f0)',
};

const lineNumberWrapStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'stretch',
  minHeight: '100%',
};

const gutterStyle: CSSProperties = {
  flexShrink: 0,
  padding: '20px 12px 20px 20px',
  fontFamily: 'monospace',
  fontSize: 13,
  lineHeight: 1.7,
  color: 'var(--color-text-tertiary, #94a3b8)',
  userSelect: 'none',
  textAlign: 'right',
  borderRight: '1px solid var(--color-border, #e2e8f0)',
  background: 'var(--color-bg, #f8fafc)',
};

const gutterLineStyle: CSSProperties = {
  display: 'block',
  whiteSpace: 'pre',
};

const codeLineStyle: CSSProperties = {
  display: 'block',
  minHeight: '1.7em',
};

const preStyle: CSSProperties = {
  fontFamily: 'monospace',
  fontSize: 13,
  lineHeight: 1.7,
  padding: '20px 24px',
  margin: 0,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  color: 'var(--color-text-primary, #0f172a)',
  flex: 1,
  minWidth: 0,
};

const emptyTemplateMsgStyle: CSSProperties = {
  padding: '20px 24px',
  fontSize: 13,
  color: 'var(--color-text-tertiary, #94a3b8)',
  fontStyle: 'italic',
  margin: 0,
};

const infoBarStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 12,
  padding: '10px 24px',
  background: 'var(--color-bg, #f8fafc)',
  flexShrink: 0,
};

const infoSectionStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  flexWrap: 'wrap',
};

const infoLabelStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: 'var(--color-text-tertiary, #94a3b8)',
  marginRight: 2,
};

const varChipStyle: CSSProperties = {
  fontSize: 11,
  padding: '2px 8px',
  background: '#ede9fe',
  color: 'var(--color-optimize)',
  borderRadius: 3,
  fontFamily: 'monospace',
  fontWeight: 600,
};

const modelChipStyle: CSSProperties = {
  fontSize: 11,
  padding: '2px 8px',
  background: 'var(--color-bg, #f8fafc)',
  border: '1px solid var(--color-border, #e2e8f0)',
  borderRadius: 3,
  color: 'var(--color-text-secondary, #475569)',
  fontFamily: 'monospace',
};

const paramChipStyle: CSSProperties = {
  fontSize: 11,
  padding: '2px 8px',
  background: 'var(--color-bg, #f8fafc)',
  border: '1px solid var(--color-border, #e2e8f0)',
  borderRadius: 3,
  color: 'var(--color-text-tertiary, #94a3b8)',
  fontFamily: 'monospace',
};

const skeletonStyle: CSSProperties = {
  borderRadius: 4,
  background: 'var(--color-bg, #f8fafc)',
  border: '1px solid var(--color-border, #e2e8f0)',
};

const errorBoxStyle: CSSProperties = {
  padding: '10px 14px',
  background: '#fee2e2',
  border: '1px solid #fca5a5',
  borderRadius: 4,
  fontSize: 12,
  color: '#991b1b',
};

// Edit panel
const editPanelStyle: CSSProperties = {
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
  padding: 24,
  overflow: 'auto',
};

const editHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 16,
  paddingBottom: 16,
  borderBottom: '1px solid var(--color-border, #e2e8f0)',
};

const editSubtitleStyle: CSSProperties = {
  fontSize: 12,
  color: 'var(--color-text-tertiary, #94a3b8)',
  marginTop: 4,
};

const panesStyle: CSSProperties = {
  display: 'flex',
  gap: 16,
  flex: 1,
  minHeight: 280,
};

const paneStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};

const paneHeaderStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  color: 'var(--color-text-tertiary, #94a3b8)',
};

const viewerBoxStyle: CSSProperties = {
  flex: 1,
  border: '1px solid var(--color-border, #e2e8f0)',
  borderRadius: 4,
  background: 'var(--color-bg, #f8fafc)',
  overflow: 'auto',
};

const baselineChipsStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 4,
  marginTop: 4,
};

const textareaStyle: CSSProperties = {
  fontFamily: 'monospace',
  fontSize: 12,
  lineHeight: 1.6,
  padding: 12,
  border: '1px solid var(--color-border, #e2e8f0)',
  borderRadius: 4,
  resize: 'none',
  width: '100%',
  flex: 1,
  background: '#fff',
  boxSizing: 'border-box',
  minHeight: 200,
  fontWeight: 400,
  color: 'var(--color-text-primary, #0f172a)',
  outline: 'none',
};

// Line-numbered textarea styles — font metrics must match exactly so numbers align
const LN_FONT_SIZE = 12;
const LN_LINE_HEIGHT = 1.6;
const LN_PADDING = 12;

const lnWrapStyle: CSSProperties = {
  display: 'flex',
  flex: 1,
  border: '1px solid var(--color-border, #e2e8f0)',
  borderRadius: 4,
  overflow: 'hidden',
  minHeight: 200,
  background: '#fff',
};

const lnGutterStyle: CSSProperties = {
  flexShrink: 0,
  overflow: 'hidden',           // hidden scrollbar; scrollTop synced via JS
  paddingTop: LN_PADDING,
  paddingRight: 10,
  paddingBottom: LN_PADDING,
  paddingLeft: LN_PADDING,
  fontFamily: 'monospace',
  fontSize: LN_FONT_SIZE,
  lineHeight: LN_LINE_HEIGHT,
  color: 'var(--color-text-tertiary, #94a3b8)',
  userSelect: 'none',
  textAlign: 'right',
  borderRight: '1px solid var(--color-border, #e2e8f0)',
  background: 'var(--color-bg, #f8fafc)',
};

const lnTextareaStyle: CSSProperties = {
  fontFamily: 'monospace',
  fontSize: LN_FONT_SIZE,
  lineHeight: LN_LINE_HEIGHT,
  paddingTop: LN_PADDING,
  paddingRight: LN_PADDING,
  paddingBottom: LN_PADDING,
  paddingLeft: LN_PADDING,
  border: 'none',
  resize: 'none',
  flex: 1,
  minWidth: 0,
  background: '#fff',
  fontWeight: 400,
  color: 'var(--color-text-primary, #0f172a)',
  outline: 'none',
};

const inferenceCardStyle: CSSProperties = {
  padding: '12px 14px',
  background: 'var(--color-bg, #f8fafc)',
  border: '1px solid var(--color-border, #e2e8f0)',
  borderRadius: 6,
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  flexShrink: 0,
};

const inferenceTitleStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: 'var(--color-text-tertiary, #94a3b8)',
};

const inferenceRowStyle: CSSProperties = {
  display: 'flex',
  gap: 12,
  alignItems: 'flex-start',
  flexWrap: 'wrap',
};

const fieldLabelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--color-text-secondary, #64748b)',
  flex: 1,
};

const smallInputStyle: CSSProperties = {
  padding: '6px 9px',
  fontSize: 12,
  border: '1px solid var(--color-border, #e2e8f0)',
  borderRadius: 4,
  background: '#fff',
  fontFamily: 'inherit',
  outline: 'none',
  color: 'var(--color-text-primary, #0f172a)',
};

const actionBarWrapStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  paddingTop: 4,
  borderTop: '1px solid var(--color-border, #e2e8f0)',
  flexShrink: 0,
};

const descLabelStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 500,
  color: 'var(--color-text-secondary, #475569)',
};

const actionBarStyle: CSSProperties = {
  display: 'flex',
  gap: 8,
  alignItems: 'center',
};

const successMsgStyle: CSSProperties = {
  padding: '8px 12px',
  background: '#dcfce7',
  border: '1px solid #86efac',
  borderRadius: 4,
  fontSize: 12,
  color: '#166534',
};

const errorMsgStyle: CSSProperties = {
  padding: '8px 12px',
  background: '#fee2e2',
  border: '1px solid #fca5a5',
  borderRadius: 4,
  fontSize: 12,
  color: '#991b1b',
};

// Test panel
const testPanelStyle: CSSProperties = {
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  minHeight: 0,
};

const testHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 16,
  padding: '20px 24px 16px',
  borderBottom: '1px solid var(--color-border, #e2e8f0)',
  flexShrink: 0,
};

const testBodyStyle: CSSProperties = {
  flex: 1,
  display: 'flex',
  minHeight: 0,
  overflow: 'hidden',
};

const testLeftStyle: CSSProperties = {
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
  padding: 24,
  overflowY: 'auto',
  minWidth: 0,
};

const testRightStyle: CSSProperties = {
  width: 280,
  flexShrink: 0,
  borderLeft: '1px solid var(--color-border, #e2e8f0)',
  display: 'flex',
  flexDirection: 'column',
  background: 'var(--color-bg, #f8fafc)',
  overflowY: 'auto',
};

const testSectionStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};

const testSectionTitleStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  color: 'var(--color-text-tertiary, #94a3b8)',
};

const testVarLabelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

const testVarNameStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  fontFamily: 'monospace',
  color: 'var(--color-optimize)',
};

const testVarInputStyle: CSSProperties = {
  padding: '7px 10px',
  fontSize: 12,
  border: '1px solid var(--color-border, #e2e8f0)',
  borderRadius: 4,
  background: '#fff',
  color: 'var(--color-text-primary, #0f172a)',
  outline: 'none',
  fontFamily: 'inherit',
};

const outputBoxStyle: CSSProperties = {
  fontFamily: 'monospace',
  fontSize: 13,
  lineHeight: 1.7,
  padding: '14px 16px',
  background: '#f8fafc',
  border: '1px solid var(--color-border, #e2e8f0)',
  borderRadius: 4,
  minHeight: 140,
  overflowY: 'auto',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};

const cursorStyle: CSSProperties = {
  display: 'inline-block',
  color: 'var(--color-primary, #6366f1)',
};

const guardrailBannerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '8px 12px',
  background: '#fef3c7',
  border: '1px solid #fcd34d',
  borderRadius: 4,
  fontSize: 12,
  color: '#92400e',
  flexWrap: 'wrap',
};

const guardrailChipStyle: CSSProperties = {
  fontSize: 11,
  padding: '2px 8px',
  background: '#fbbf24',
  color: '#78350f',
  borderRadius: 3,
  fontWeight: 600,
};

const assistToggleStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  width: '100%',
  padding: '14px 16px',
  background: 'transparent',
  border: 'none',
  borderBottom: '1px solid var(--color-border, #e2e8f0)',
  cursor: 'pointer',
  fontSize: 12,
  fontWeight: 700,
  fontFamily: 'inherit',
  color: 'var(--color-text-primary, #0f172a)',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
};

const assistBodyStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  padding: 16,
};

const assistHintStyle: CSSProperties = {
  fontSize: 11,
  color: 'var(--color-text-tertiary, #94a3b8)',
  lineHeight: 1.5,
  margin: 0,
};

const optimizedBlockStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};

// Create panel

const createPanelStyle: CSSProperties = {
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  gap: 20,
  padding: 24,
  overflow: 'auto',
};

const createFieldsStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
  flex: 1,
};

const createTopRowStyle: CSSProperties = {
  display: 'flex',
  gap: 12,
  alignItems: 'flex-end',
};

const createTemplateStyle: CSSProperties = {
  fontFamily: 'monospace',
  fontSize: 12,
  lineHeight: 1.6,
  padding: 12,
  border: '1px solid var(--color-border, #e2e8f0)',
  borderRadius: 4,
  resize: 'vertical',
  width: '100%',
  minHeight: 200,
  background: '#fff',
  boxSizing: 'border-box',
  color: 'var(--color-text-primary, #0f172a)',
  outline: 'none',
  marginTop: 4,
};

const createVarPreviewStyle: CSSProperties = {
  display: 'flex',
  gap: 6,
  flexWrap: 'wrap',
  alignItems: 'center',
  padding: '8px 12px',
  background: '#faf5ff',
  border: '1px solid #e9d5ff',
  borderRadius: 4,
};

const requiredMarkStyle: CSSProperties = {
  color: '#dc2626',
  fontWeight: 700,
};
