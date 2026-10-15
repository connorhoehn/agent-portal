// Configuration — cohort motions (title/tag/accent) and the certification target level.
//
// `isHexColour` guards the swatch: the field is free text (it round-trips to
// the server as a string), so a half-typed "#14" must not paint a wrong colour
// confidently — it paints nothing until the value is a complete hex.
// Read-only for everyone except program-lead, who holds ManageAssessmentConfig
// (docs/assessment-tenant.md "Roles (Cedar)" — changing the rubric target level is
// program-lead only; separation of duties from the assessor/lead-assessor roles that can
// score and publish but not reconfigure the program).

import { useEffect, useState } from 'react';
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
  StatusDot,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { useCapabilities } from '../../lib/capabilities';
import { toastError, toastSuccess } from '../../lib/toastStore';
import { sendJson } from '../../lib/writeJson';
import type { AssessmentConfiguration, SecondaryMotionConfig } from './secondaryTypes';

const LEVEL_OPTIONS = [1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: `Level ${n}` }));

/** A complete 3- or 6-digit hex colour — anything else paints no swatch. */
function isHexColour(v: string): boolean {
  return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v.trim());
}

export default function ConfigurationPage() {
  const { can, ready } = useCapabilities();
  const canManage = ready && can('ManageAssessmentConfig');

  const { data: fetched, isLoading: loading, error } = useFetch<AssessmentConfiguration>('/api/assessment/configuration');
  const [config, setConfig] = useState<AssessmentConfiguration | null>(null);
  const [saving, setSaving] = useState(false);

  // Editable local copy, seeded once the read lands — motion edits below
  // mutate this copy, never `fetched` directly.
  useEffect(() => { if (fetched) setConfig(fetched); }, [fetched]);

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
      const body = await sendJson<AssessmentConfiguration>('/api/assessment/configuration', 'PUT', config);
      setConfig(body);
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
            size="sm"
            title="Certification target"
            description={`The level every team's headline measures against. Levels 4 and 5 always require observed evidence regardless of this setting.`}
          >
            <FormRow>
              <FormField label="Target level">
                {(wiring) => (
                  <Select
                    {...wiring}
                    value={String(config.target_level)}
                    onChange={(e) => setConfig({ ...config, target_level: Number(e.target.value) })}
                    options={LEVEL_OPTIONS}
                    disabled={!canManage}
                  />
                )}
              </FormField>
            </FormRow>
          </PageSection>

          <PageSection size="sm" title="Cohort motions" description="The cohort tiles teams are grouped into.">
            <Stack gap="sm">
              {config.motions.map((motion, i) => (
                // Keyed by cohort: MotionConfig has no `key` field, and the
                // undefined key was the "missing key" console error on every
                // load of this page.
                <FormRow key={motion.cohort}>
                  <FormField label="Title">
                    {(wiring) => (
                      <Input {...wiring} value={motion.title} onChange={(e) => updateMotion(i, { title: e.target.value })} disabled={!canManage} />
                    )}
                  </FormField>
                  <FormField label="Tag">
                    {(wiring) => (
                      <Input {...wiring} value={motion.tag} onChange={(e) => updateMotion(i, { tag: e.target.value })} disabled={!canManage} />
                    )}
                  </FormField>
                  <FormField label="Accent">
                    {(wiring) => (
                      // A swatch in the input's prefix, the way the source
                      // project's own Configuration renders this field
                      // (ui/src/components/configuration/Configuration.tsx
                      // paints `backgroundColor: cohort.accent`). Without it
                      // the field was the bare hex string, which nobody
                      // can decode into a colour — and this is the one field
                      // on the page whose entire content IS a colour.
                      //
                      // The value is carried for the source system: this app's
                      // cohort chips take their colour from the tenant's
                      // semantic tones (see MOTIONS' `accent: ChipTone`), which
                      // are theme-aware in a way a stored hex cannot be. So the
                      // swatch shows what is stored, not a preview of the chip.
                      <Input
                        {...wiring}
                        value={motion.accent}
                        onChange={(e) => updateMotion(i, { accent: e.target.value })}
                        disabled={!canManage}
                        prefix={
                          // `StatusDot` takes a `color`, so the swatch is a
                          // library component rather than a hand-rolled span
                          // with an inline style — which the component gate
                          // bans in pages outright, and rightly: a rule you can
                          // evade by hoisting the object to a const is not a
                          // rule (scripts/validate-component-discipline.sh).
                          <StatusDot
                            color={isHexColour(motion.accent) ? motion.accent : 'var(--color-text-tertiary)'}
                            size="sm"
                            aria-label={isHexColour(motion.accent) ? `Accent ${motion.accent}` : 'No colour set'}
                          />
                        }
                      />
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
