// /pipelines/configuration — the pipelines tenant's settings
// (docs/pipelines-tenant-goal.md §"Cedar: separation of duties"): today one,
// the default approver role a step falls to when its definition names nobody
// (design §8). pipeline-admin only — the rail, the palette and the route are
// gated together (Layout.tsx, portalCommands.ts, App.tsx), because author and
// operator never see Configuration. The effective default is not hidden from
// them: every Definition and Approval shows who approves it ("Operator
// (default)"), which is the part of this setting their work depends on.
//
// GET/PUT /api/pipelines/configuration; the PUT is ManagePipelineConfig.

import { useEffect, useState } from 'react';
import { CheckIcon, FormField,
  Button, ErrorState, InlineAlert, KeyValue, LoadingState, PageHeader, PageSection, Select, Stack,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { useCapabilities } from '../../lib/capabilities';
import { roleLabel } from '../../lib/pipelineDefinitions';
import { writeJson } from '../../lib/writeJson';

interface PipelinesConfig { defaultApproverRole: string; updatedBy: string | null; approverRoleOptions: string[] }

export default function ConfigurationPage() {
  const { can } = useCapabilities();
  const { data, error, isLoading, refresh } = useFetch<PipelinesConfig>('/api/pipelines/configuration');
  const [role, setRole] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => { if (data) setRole(data.defaultApproverRole); }, [data]);
  const canEdit = can('ManagePipelineConfig');

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    const res = await writeJson<PipelinesConfig>('/api/pipelines/configuration', 'PUT', { defaultApproverRole: role });
    setSaving(false);
    if (!res.ok) { setSaveError(res.error); return; }
    setSaved(true);
    refresh();
  };

  return (
    <Stack gap="md" className="min-w-0" data-testid="pipelines-configuration">
      <PageHeader density="compact" title="Configuration" description="How this workspace decides who approves a step." />
      {error ? (
        <ErrorState title="Configuration unavailable" body={error} />
      ) : !data ? (
        <LoadingState label={isLoading ? 'Loading configuration…' : 'Loading…'} />
      ) : (
        <PageSection
          title="Default approver"
          description="Who approves a step when its definition names nobody. A definition's own approver roles always win."
        >
          <Stack gap="md">
            <KeyValue items={[
              { label: 'Now', value: roleLabel(data.defaultApproverRole) },
              { label: 'Last changed by', value: data.updatedBy ?? 'Nobody — the design default (operator)' },
            ]} />
            {canEdit && (
              <Stack gap="sm">
                <FormField label="Default approver role">{({ id }) => <Select id={id}
                  aria-label="Default approver role"
                  size="sm"
                  className="w-full max-w-56"
                  value={role}
                  onChange={(e) => { setRole(e.target.value); setSaved(false); }}
                  options={data.approverRoleOptions.map((r) => ({ value: r, label: roleLabel(r) }))}
                  data-testid="pipelines-default-approver"
                />}</FormField>
                <Button size="sm" variant="primary" className="self-start" data-testid="pipelines-configuration-save"
                  disabled={saving || role === data.defaultApproverRole} onClick={() => { void save(); }}>
                  <CheckIcon />{saving ? 'Saving…' : 'Save'}
                </Button>
              </Stack>
            )}
            {saveError && <InlineAlert tone="error" onDismiss={() => setSaveError(null)}>{saveError}</InlineAlert>}
            {saved && <InlineAlert tone="success" onDismiss={() => setSaved(false)}>Saved — new approvals fall to {roleLabel(data.defaultApproverRole)}.</InlineAlert>}
          </Stack>
        </PageSection>
      )}
    </Stack>
  );
}
