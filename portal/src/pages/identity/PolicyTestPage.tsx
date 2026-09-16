// Policy sandbox: dry-run "what happens if user with role X does action Y"
// against AVP. Shows the decision and the determining policy IDs.

import { useMemo, useState } from 'react';
import {
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
import { decisionTone, inputWiring, truncateId } from './identityFormat';

interface SchemaResponse {
  schema: { OrgIQ?: { actions?: Record<string, unknown> } };
}

interface PolicyEntry {
  policyId: string;
  description: string;
}

interface TestResult {
  decision?: 'ALLOW' | 'DENY';
  determiningPolicies?: Array<{ policyId: string }>;
  errors?: Array<{ errorDescription?: string }>;
  error?: string;
  ts: string;
  request: { role: string; action: string };
}

const ROLE_OPTIONS = ['member', 'org-leader', 'hr-admin'].map(r => ({ value: r, label: r }));

function PolicyTestPage() {
  const { data: schema } = useFetch<SchemaResponse>('/api/identity/schema');
  const { data: policies } = useFetch<{ policies: PolicyEntry[] }>('/api/identity/policies');
  const allActions = useMemo(
    () => Object.keys(schema?.schema?.OrgIQ?.actions ?? {}).sort(),
    [schema],
  );
  const policyById = useMemo(() => {
    const m = new Map<string, PolicyEntry>();
    for (const p of policies?.policies ?? []) m.set(p.policyId, p);
    return m;
  }, [policies]);

  const [role, setRole] = useState<string>('member');
  const [actions, setActions] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [history, setHistory] = useState<TestResult[]>([]);

  async function runTests() {
    if (actions.length === 0) {
      setErrMsg('Pick at least one action to test.');
      return;
    }
    setBusy(true); setErrMsg(null);
    const results: TestResult[] = [];
    try {
      for (const action of actions) {
        const res = await fetch('/api/identity/policies/test', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role, action }),
        });
        const j = await res.json();
        results.push({
          ...(res.ok ? j : { error: j.error ?? `${res.status}` }),
          ts: new Date().toISOString(),
          request: { role, action },
        });
      }
      setHistory(prev => [...results, ...prev].slice(0, 50));
    } catch (e) {
      setErrMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <PageSection
      title="Policy Sandbox"
      description="Dry-run AVP authorization. Pick a role + one or more actions to see what each policy would decide."
    >
      <Card>
        <Stack gap="md">
          <FormField label="Role" layout="inline">
            {(wiring) => (
              <Select {...inputWiring(wiring)} className="min-w-[220px]" options={ROLE_OPTIONS} value={role} onChange={e => setRole(e.target.value)} />
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
              <Inline as="span" gap="xs" className="text-[12px] text-text-tertiary">
                Application <code>(fixed)</code>
              </Inline>
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
                    <Inline as="span" gap="xs" className="text-[13px] font-medium">
                      <code>{r.request.role}</code>
                      <Inline as="span" className="text-text-tertiary">→</Inline>
                      <code>{r.request.action}</code>
                    </Inline>
                    {r.error && (
                      <Inline as="span" className="text-[11px] text-danger">{r.error}</Inline>
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
                          <Inline key={j} as="span" className="text-[11px] text-danger">{e.errorDescription}</Inline>
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
