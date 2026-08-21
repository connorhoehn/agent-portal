// Schema editor — entity types are read-only chips; actions are editable
// via TagEditor. Adding/removing actions calls PUT /api/identity/schema.
// AVP rejects schema changes that drop actions referenced by live policies;
// the rejection text surfaces inline.

import { useEffect, useMemo, useState } from 'react';
import { TagEditor, CollapsibleSection, PageSection } from '@connorhoehnslalom/ui-components/shared';
import { useCapabilities } from '../../lib/capabilities';
import { useFetch } from '../../hooks/useFetch';

interface SchemaResponse {
  schema: {
    OrgIQ?: {
      entityTypes?: Record<string, unknown>;
      actions?: Record<string, { appliesTo?: { principalTypes?: string[]; resourceTypes?: string[] } }>;
    };
  };
  raw: string;
}

const NS = 'OrgIQ';
const DEFAULT_APPLIES_TO = {
  principalTypes: ['User'],
  resourceTypes: ['Application'],
};

function SchemaPage() {
  // Schema edits PUT /api/identity/schema (EditSchema).
  const { can, ready } = useCapabilities();
  const canEdit = ready && can('EditSchema');
  const { data, isLoading, error, refresh } = useFetch<SchemaResponse>('/api/identity/schema');
  const [busy, setBusy] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [pendingActions, setPendingActions] = useState<string[] | null>(null);

  const liveActions = useMemo(
    () => Object.keys(data?.schema?.OrgIQ?.actions ?? {}).sort(),
    [data],
  );

  // Reset local edits when the live schema reloads (e.g. after Save).
  useEffect(() => {
    setPendingActions(null);
  }, [data]);

  if (isLoading) return <PageSection title="Schema"><div style={{ color: 'var(--color-text-tertiary)' }}>Loading schema…</div></PageSection>;
  if (error) return <PageSection title="Schema"><div style={{ color: 'var(--color-error, #ef4444)' }}>Error: {error}</div></PageSection>;
  if (!data) return null;

  const namespace = data.schema?.[NS];
  const entityTypes = Object.keys(namespace?.entityTypes ?? {}).sort();
  const actions = pendingActions ?? liveActions;
  const dirty = pendingActions !== null && pendingActions.join(',') !== liveActions.join(',');

  function setActions(next: string[]) {
    setPendingActions(next);
  }

  async function save() {
    if (!pendingActions || !data) return;
    setBusy(true); setErrMsg(null);
    try {
      // Build the new schema doc by overwriting the actions map.
      const nextActions: Record<string, { appliesTo: typeof DEFAULT_APPLIES_TO }> = {};
      for (const id of pendingActions) {
        // Preserve existing appliesTo if the action already exists; default for new ones.
        const existing = namespace?.actions?.[id];
        nextActions[id] = {
          appliesTo: (existing?.appliesTo as typeof DEFAULT_APPLIES_TO) ?? DEFAULT_APPLIES_TO,
        };
      }
      const nextSchema = {
        ...data.schema,
        [NS]: {
          ...(namespace ?? {}),
          actions: nextActions,
        },
      };
      const res = await fetch('/api/identity/schema', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schema: nextSchema }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.detail ?? j.error ?? `${res.status}`);
      }
      await refresh();
    } catch (e) {
      setErrMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function discard() {
    setPendingActions(null);
    setErrMsg(null);
  }

  return (
    <PageSection
      title="Schema"
      description="Cedar entity types and actions enforced by AVP. Removing actions referenced by a live policy will fail validation."
      actions={
        canEdit && dirty ? (
          <>
            <button onClick={discard} disabled={busy} style={btnSecondary}>Discard</button>
            <button onClick={save} disabled={busy} style={btnPrimary}>Save changes</button>
          </>
        ) : undefined
      }
    >
      {errMsg && <div style={errorBanner}>{errMsg}</div>}

      <article style={card}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>Namespace: <code>{NS}</code></div>

        <div style={{ marginBottom: 20 }}>
          <div style={sectionLabel}>Entity types</div>
          <div style={chipRow}>
            {entityTypes.length > 0
              ? entityTypes.map(t => <span key={t} style={chip}>{t}</span>)
              : <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>(none)</span>}
          </div>
          <div style={hint}>
            Entity types are fixed in this schema. Edit raw JSON via the AVP API to add custom entities.
          </div>
        </div>

        <div>
          <div style={sectionLabel}>Actions</div>
          {canEdit ? (
            <>
              <TagEditor
                value={actions}
                onChange={setActions}
                placeholder="add action…"
                lowercase={false}
              />
              <div style={hint}>
                Type an action name and press Enter. New actions inherit appliesTo: {DEFAULT_APPLIES_TO.principalTypes.join(', ')} → {DEFAULT_APPLIES_TO.resourceTypes.join(', ')}.
              </div>
            </>
          ) : (
            <div style={chipRow}>
              {actions.length > 0
                ? actions.map(a => <span key={a} style={chip}>{a}</span>)
                : <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>(none)</span>}
            </div>
          )}
        </div>
      </article>

      <CollapsibleSection title="Raw schema (JSON)" defaultOpen={false}>
        <pre style={preBlock}>{JSON.stringify(data.schema, null, 2)}</pre>
      </CollapsibleSection>
    </PageSection>
  );
}

const card: React.CSSProperties = {
  background: 'var(--color-surface)',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-md)',
  padding: 16,
};

const sectionLabel: React.CSSProperties = {
  fontSize: 10,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: 'var(--color-text-tertiary)',
  marginBottom: 8,
};

const chipRow: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 6,
};

const chip: React.CSSProperties = {
  fontSize: 11,
  padding: '2px 8px',
  background: 'var(--color-surface-hover)',
  border: '1px solid var(--color-border)',
  borderRadius: 999,
  color: 'var(--color-text-primary)',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
};

const hint: React.CSSProperties = {
  marginTop: 6,
  fontSize: 11,
  color: 'var(--color-text-tertiary)',
};

const preBlock: React.CSSProperties = {
  margin: '6px 0 0',
  padding: 12,
  background: 'var(--color-surface-hover)',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-sm, 4px)',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 12,
  lineHeight: 1.5,
  color: 'var(--color-text-primary)',
  whiteSpace: 'pre-wrap',
  overflowX: 'auto',
};

const btnPrimary: React.CSSProperties = {
  padding: '5px 12px',
  background: 'var(--color-primary)',
  color: 'white',
  border: 'none',
  borderRadius: 'var(--radius-sm, 4px)',
  fontSize: 12,
  fontWeight: 500,
  cursor: 'pointer',
};

const btnSecondary: React.CSSProperties = {
  padding: '5px 12px',
  background: 'var(--color-surface-hover)',
  color: 'var(--color-text-primary)',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-sm, 4px)',
  fontSize: 12,
  cursor: 'pointer',
};

const errorBanner: React.CSSProperties = {
  padding: 10,
  background: '#fee2e2',
  border: '1px solid #ef4444',
  borderRadius: 'var(--radius-md)',
  color: '#991b1b',
  fontSize: 12,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
};

export default SchemaPage;
