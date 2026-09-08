// Configuration — cohort motions (title/tag/accent) and the certification target level.
// Read-only for everyone except program-lead, who holds ManageAssessmentConfig
// (docs/assessment-tenant.md "Roles (Cedar)" — changing the rubric target level is
// program-lead only; separation of duties from the assessor/lead-assessor roles that can
// score and publish but not reconfigure the program).

import { useEffect, useState } from 'react';
import { inputWiring } from './assessmentFormat';
import {
  Button,
  FormField,
  FormRow,
  Inline,
  InlineAlert,
  Input,
  LoadingState,
  PageHeader,
  Stack,
  PageSection,
  Select,
} from '@connorhoehnslalom/ui-components/shared';
import { useCapabilities } from '../../lib/capabilities';
import { toastError, toastSuccess } from '../../lib/toastStore';
import type { AssessmentConfiguration, SecondaryMotionConfig } from './secondaryTypes';

const LEVEL_OPTIONS = [1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: `Level ${n}` }));

export default function ConfigurationPage() {
  const { can, ready } = useCapabilities();
  const canManage = ready && can('ManageAssessmentConfig');

  const [config, setConfig] = useState<AssessmentConfiguration | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch('/api/assessment/configuration', { credentials: 'include' })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((body: AssessmentConfiguration) => { setConfig(body); setError(null); })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  function updateMotion(index: number, patch: Partial<SecondaryMotionConfig>) {
    setConfig((prev) => {
      if (!prev) return prev;
      const motions = prev.motions.map((m, i) => (i === index ? { ...m, ...patch } : m));
      return { ...prev, motions };
    });
  }

  async function save() {
    if (!config || !canManage) return;
    setSaving(true);
    try {
      const res = await fetch('/api/assessment/configuration', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      const body = (await res.json().catch(() => ({}))) as Partial<AssessmentConfiguration> & { error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setConfig(body as AssessmentConfiguration);
      toastSuccess(null, 'Configuration saved');
    } catch (err) {
      toastError(null, 'Could not save', (err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Stack gap="lg">
      <PageHeader title="Configuration" description="Cohort motions and the certification target level used across every team's assessment." />

      {!canManage && (
        <InlineAlert tone="info">
          Only a program lead can change these settings — everything below is read-only for your role.
        </InlineAlert>
      )}

      {loading ? (
        <LoadingState label="Loading configuration…" />
      ) : error ? (
        <InlineAlert tone="error">{error}</InlineAlert>
      ) : config ? (
        <>
          <PageSection
            title="Certification target"
            description={`The level every team's headline measures against. Levels 4 and 5 always require observed evidence regardless of this setting.`}
          >
            <FormRow>
              <FormField label="Target level">
                {(wiring) => (
                  <Select
                    {...inputWiring(wiring)}
                    value={String(config.target_level)}
                    onChange={(e) => setConfig({ ...config, target_level: Number(e.target.value) })}
                    options={LEVEL_OPTIONS}
                    disabled={!canManage}
                  />
                )}
              </FormField>
            </FormRow>
          </PageSection>

          <PageSection title="Cohort motions" description="The cohort tiles teams are grouped into.">
            <Stack gap="sm">
              {config.motions.map((motion, i) => (
                // Keyed by cohort: MotionConfig has no `key` field, and the
                // undefined key was the "missing key" console error on every
                // load of this page.
                <FormRow key={motion.cohort}>
                  <FormField label="Title">
                    {(wiring) => (
                      <Input {...inputWiring(wiring)} value={motion.title} onChange={(e) => updateMotion(i, { title: e.target.value })} disabled={!canManage} />
                    )}
                  </FormField>
                  <FormField label="Tag">
                    {(wiring) => (
                      <Input {...inputWiring(wiring)} value={motion.tag} onChange={(e) => updateMotion(i, { tag: e.target.value })} disabled={!canManage} />
                    )}
                  </FormField>
                  <FormField label="Accent">
                    {(wiring) => (
                      <Input {...inputWiring(wiring)} value={motion.accent} onChange={(e) => updateMotion(i, { accent: e.target.value })} disabled={!canManage} />
                    )}
                  </FormField>
                </FormRow>
              ))}
            </Stack>
          </PageSection>

          {canManage && (
            <Inline justify="end">
              <Button onClick={() => void save()} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
            </Inline>
          )}
        </>
      ) : null}
    </Stack>
  );
}
