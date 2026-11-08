// Schema editor — entity types are read-only chips; actions are editable
// via TagEditor. Adding/removing actions calls PUT /api/identity/schema.
// AVP rejects schema changes that drop actions referenced by live policies;
// the rejection text surfaces inline.

import { useEffect, useMemo, useState } from 'react';
import {
  T,
  Button,
  Card,
  Chip,
  CodeBlock,
  CollapsibleSection,
  ConfirmDialog,
  Inline,
  InlineAlert,
  LoadingState,
  PageSection,
  SectionLabel,
  Stack,
  TagEditor,
} from '@connorhoehn/ui-components/shared';
import { useCapabilities } from '../../lib/capabilities';
import { useFetch } from '../../hooks/useFetch';
import { KeyValue } from '../../components/KeyValue';
import { writeJson } from '../../lib/writeJson';
import { UnavailableNotice } from '../../components/UnavailableNotice';

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
  const [confirmingSave, setConfirmingSave] = useState(false);

  const liveActions = useMemo(
    () => Object.keys(data?.schema?.OrgIQ?.actions ?? {}).sort(),
    [data],
  );

  // Reset local edits when the live schema reloads (e.g. after Save).
  useEffect(() => {
    setPendingActions(null);
  }, [data]);

  if (isLoading) {
    return (
      <PageSection title="Schema">
        <LoadingState label="Loading schema…" />
      </PageSection>
    );
  }
  if (error) {
    return (
      <PageSection title="Schema">
        <UnavailableNotice
          error={error}
          what="the schema"
          source="The entity and action schema is read from Verified Permissions"
          onRetry={() => void refresh()}
        />
      </PageSection>
    );
  }
  if (!data) return null;

  const namespace = data.schema?.[NS];
  const entityTypes = Object.keys(namespace?.entityTypes ?? {}).sort();
  const actions = pendingActions ?? liveActions;
  const dirty = pendingActions !== null && pendingActions.join(',') !== liveActions.join(',');
  // What "Save changes" actually does — a schema PUT is enforced on every
  // middleware request platform-wide the moment AVP accepts it, so the
  // confirm names the effect instead of asking to confirm a click.
  const addedActions = pendingActions ? pendingActions.filter(a => !liveActions.includes(a)) : [];
  const removedActions = pendingActions ? liveActions.filter(a => !pendingActions.includes(a)) : [];

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
      const res = await writeJson<{ detail?: string; error?: string }>('/api/identity/schema', 'PUT', { schema: nextSchema });
      if (!res.ok) {
        throw new Error(res.data?.detail ?? res.data?.error ?? `${res.status}`);
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
            <Button variant="secondary" onClick={discard} disabled={busy}>Discard</Button>
            <Button onClick={() => setConfirmingSave(true)} disabled={busy}>Save changes</Button>
          </>
        ) : undefined
      }
    >
      {errMsg && <InlineAlert tone="error">{errMsg}</InlineAlert>}

      <ConfirmDialog
        open={confirmingSave}
        onConfirm={() => { setConfirmingSave(false); void save(); }}
        onCancel={() => setConfirmingSave(false)}
        tone={removedActions.length > 0 ? 'destructive' : 'caution'}
        title="Save schema changes?"
        body={
          [
            'Enforced by AVP on every middleware request as soon as this saves.',
            addedActions.length > 0 ? `Adds: ${addedActions.join(', ')}.` : null,
            removedActions.length > 0 ? `Removes: ${removedActions.join(', ')} — rejected if a live policy still references one of them.` : null,
          ].filter(Boolean).join(' ')
        }
      />

      <Card>
        <Stack gap="lg">
          <KeyValue layout="row" labelWidth="w-auto" label="Namespace" value={NS} mono />

          <Stack gap="xs">
            <SectionLabel>Entity types</SectionLabel>
            <Inline gap="xs" wrap>
              {entityTypes.length > 0
                ? entityTypes.map(t => <Chip key={t} size="xs" mono>{t}</Chip>)
                : <T as="span" size="xs" tone="tertiary">(none)</T>}
            </Inline>
            <T as="p" size="xs" tone="tertiary" className="m-0">
              Entity types are fixed in this schema. Edit raw JSON via the AVP API to add custom entities.
            </T>
          </Stack>

          <Stack gap="xs">
            <SectionLabel>Actions</SectionLabel>
            {canEdit ? (
              <>
                <TagEditor
                  value={actions}
                  onChange={setActions}
                  placeholder="add action…"
                  lowercase={false}
                />
                <T as="p" size="xs" tone="tertiary" className="m-0">
                  Type an action name and press Enter. New actions inherit appliesTo: {DEFAULT_APPLIES_TO.principalTypes.join(', ')} → {DEFAULT_APPLIES_TO.resourceTypes.join(', ')}.
                </T>
              </>
            ) : (
              <Inline gap="xs" wrap>
                {actions.length > 0
                  ? actions.map(a => <Chip key={a} size="xs" mono>{a}</Chip>)
                  : <T as="span" size="xs" tone="tertiary">(none)</T>}
              </Inline>
            )}
          </Stack>
        </Stack>
      </Card>

      <CollapsibleSection title="Raw schema (JSON)" defaultOpen={false}>
        <CodeBlock code={JSON.stringify(data.schema, null, 2)} language="json" ariaLabel="Raw Cedar schema" />
      </CollapsibleSection>
    </PageSection>
  );
}

export default SchemaPage;
