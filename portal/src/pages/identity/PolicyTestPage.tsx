// Policy sandbox: dry-run "what happens if user with role X does action Y"
// against AVP. Shows the decision and the determining policy IDs.

import { useEffect, useMemo, useState } from 'react';
import {
  T,
  Button,
  Card,
  Chip,
  DetailSection,
  FormField,
  Inline,
  InlineAlert,
  MetaLine,
  Select,
  Stack,
  TagEditor,
  PageSection,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { writeJson } from '../../lib/writeJson';
import { decisionTone, inputWiring, rolesForTenantMap, truncateId } from './identityFormat';

interface SchemaResponse {
  schema: { OrgIQ?: { actions?: Record<string, unknown> } };
}

interface PolicyEntry {
  policyId: string;
  description: string;
}

interface TenantInfo { id: string; displayName: string }
interface RoleInfo { id: string; tenant: string | null; label: string }

interface TestResult {
  decision?: 'ALLOW' | 'DENY';
  determiningPolicies?: Array<{ policyId: string }>;
  errors?: Array<{ errorDescription?: string }>;
  error?: string;
  ts: string;
  request: { role: string; action: string; tenant: string };
}

function PolicyTestPage() {
  const { data: schema } = useFetch<SchemaResponse>('/api/identity/schema');
  const { data: policies } = useFetch<{ policies: PolicyEntry[] }>('/api/identity/policies');
  // Tenant + role live off the same registries Users/Roles read — a
  // hardcoded 3-role list here used to silently drop sme, program-owner,
  // admin and every assessment-tenant role from what the sandbox could test,
  // with no sign that more roles existed.
  const { data: tenantsData } = useFetch<TenantInfo[]>('/api/identity/tenants');
  const { data: rolesData } = useFetch<RoleInfo[]>('/api/identity/roles');
  const tenants = tenantsData ?? [];
  const roles = rolesData ?? [];
  const rolesForTenant = useMemo(() => rolesForTenantMap(tenants, roles), [tenants, roles]);

  const allActions = useMemo(
    () => Object.keys(schema?.schema?.OrgIQ?.actions ?? {}).sort(),
    [schema],
  );
  const policyById = useMemo(() => {
    const m = new Map<string, PolicyEntry>();
    for (const p of policies?.policies ?? []) m.set(p.policyId, p);
    return m;
  }, [policies]);

  const [tenant, setTenant] = useState<string>('orgiq');
  const [role, setRole] = useState<string>('member');
  const [actions, setActions] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [history, setHistory] = useState<TestResult[]>([]);

  const tenantOptions = tenants.map(t => ({ value: t.id, label: t.displayName }));
  const roleOptions = (rolesForTenant.get(tenant) ?? []).map(r => ({ value: r.id, label: r.label }));

  // Keep the selected role valid for the selected tenant — switching from
  // orgiq to assessment used to leave "member" selected even though that
  // role doesn't exist there, testing a role that could never actually sign
  // in to that tenant.
  useEffect(() => {
    if (roleOptions.length > 0 && !roleOptions.some(o => o.value === role)) {
      setRole(roleOptions[0]!.value);
    }
  }, [tenant, roleOptions, role]);

  async function runTests() {
    if (actions.length === 0) {
      setErrMsg('Pick at least one action to test.');
      return;
    }
    setBusy(true); setErrMsg(null);
    const results: TestResult[] = [];
    for (const action of actions) {
      const res = await writeJson<Record<string, unknown>>('/api/identity/policies/test', 'POST', { role, action, tenant });
      if (res.status === 0) {
        setErrMsg(res.error ?? 'Request failed');
        setBusy(false);
        return;
      }
      results.push({
        ...(res.ok ? res.data : { error: res.data?.error ?? `${res.status}` }),
        ts: new Date().toISOString(),
        request: { role, action, tenant },
      } as TestResult);
    }
    setHistory(prev => [...results, ...prev].slice(0, 50));
    setBusy(false);
  }

  return (
    <PageSection
      title="Policy Sandbox"
      description="Dry-run AVP authorization. Pick a tenant + role + one or more actions to see what each policy would decide."
    >
      <Card>
        <Stack gap="md">
          <FormField label="Tenant" layout="inline">
            {(wiring) => (
              <Select {...inputWiring(wiring)} className="min-w-[220px]" options={tenantOptions} value={tenant} onChange={e => setTenant(e.target.value)} />
            )}
          </FormField>
          <FormField label="Role" layout="inline">
            {(wiring) => (
              <Select {...inputWiring(wiring)} className="min-w-[220px]" options={roleOptions} value={role} onChange={e => setRole(e.target.value)} />
            )}
          </FormField>
          <FormField label="Actions" layout="inline">
            {() => (
              <TagEditor
                value={actions}
                onChange={setActions}
                suggestions={allActions}
                placeholder={allActions.length ? 'add action…' : 'loading schema…'}
                lowercase={false}
              />
            )}
          </FormField>
          <FormField label="Resource" layout="inline">
            {() => (
              <T as="span" size="xs" tone="tertiary">
                Application <code>(fixed)</code>
              </T>
            )}
          </FormField>
          <Inline justify="end">
            <Button onClick={runTests} disabled={busy}>
              {busy ? 'Testing…' : `Test ${actions.length || 0} action${actions.length === 1 ? '' : 's'}`}
            </Button>
          </Inline>
          {errMsg && <InlineAlert tone="error">{errMsg}</InlineAlert>}
        </Stack>
      </Card>

      {history.length > 0 && (
        <DetailSection title="Recent results">
          <Stack gap="sm">
            {history.map((r, i) => (
              <Card key={`${r.ts}-${i}`}>
                <Inline gap="md" align="start">
                  <DecisionChip value={r.decision} hasError={!!r.error} />
                  <Stack gap="xs" className="min-w-0 flex-1">
                    <T as="span" size="sm" weight="semibold" className="inline-flex items-center gap-1">
                      <code>{r.request.tenant}/{r.request.role}</code>
                      <T as="span" size="sm" tone="tertiary">→</T>
                      <code>{r.request.action}</code>
                    </T>
                    {r.error && (
                      <T as="span" size="xs" className="text-danger">{r.error}</T>
                    )}
                    {r.determiningPolicies && r.determiningPolicies.length > 0 && (
                      <Inline gap="xs" wrap>
                        {r.determiningPolicies.map(dp => {
                          const p = policyById.get(dp.policyId);
                          return (
                            <Chip key={dp.policyId} size="xs" mono title={dp.policyId}>
                              {p?.description || truncateId(dp.policyId)}
                            </Chip>
                          );
                        })}
                      </Inline>
                    )}
                    {r.errors && r.errors.length > 0 && (
                      <Stack gap="none">
                        {r.errors.map((e, j) => (
                          <T key={j} as="span" size="xs" className="text-danger">{e.errorDescription}</T>
                        ))}
                      </Stack>
                    )}
                  </Stack>
                  <MetaLine items={[new Date(r.ts).toLocaleTimeString()]} className="whitespace-nowrap" />
                </Inline>
              </Card>
            ))}
          </Stack>
        </DetailSection>
      )}
    </PageSection>
  );
}

function DecisionChip({ value, hasError }: { value?: string; hasError: boolean }) {
  return (
    <Chip tone={decisionTone(value as 'ALLOW' | 'DENY' | undefined, hasError)} size="sm" className="min-w-[60px] text-center">
      {hasError ? 'ERROR' : (value ?? '—')}
    </Chip>
  );
}

export default PolicyTestPage;
