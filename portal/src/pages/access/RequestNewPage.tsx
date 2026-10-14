// /access/requests/new — the request wizard (docs/access-tenant-design.md §4.1):
// who (yourself, or a report when you hold DecideAccess) → what (a catalog
// item, with the separation-of-duties pre-check the server computed for it) →
// why (a justification of at least 20 characters) → how long (time-bound by
// default; standing needs its own reason, A6). Submit posts
// POST /api/access/requests and opens the new record, where the computed
// approval chain is shown. `?item=<id>` (the catalog's Request) preselects.

import {
  Button,
  Chip,
  FormField,
  Inline,
  InlineAlert,
  KeyValue,
  LoadingState,
  PageHeader,
  PageSection,
  RadioGroup,
  Select,
  Stack,
  T,
  Textarea,
  WorkflowStepper,
} from '@connorhoehnslalom/ui-components/shared';
import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { FlushPage } from '../../components/shell/FlushPage';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { useFetch } from '../../hooks/useFetch';
import { useSession } from '../../lib/auth';
import { useCapabilities } from '../../lib/capabilities';
import { writeJson } from '../../lib/writeJson';
import {
  ACCESS_API,
  DURATIONS,
  DURATION_LABELS,
  EMPTY_DRAFT,
  JUSTIFICATION_MIN,
  KIND_LABELS,
  STEWARD_LABELS,
  TENANT_LABELS,
  WIZARD_STEPS,
  draftProblem,
  requestHref,
  submitBody,
  type AccessDuration,
  type AccessPerson,
  type AccessRequest,
  type CatalogItem,
  type ItemsResponse,
  type RequestDraft,
} from '../../lib/accessRequests';
import { ACCESS_SURFACES } from './accessSurfaces';

/** People the actor has requested on behalf of before: the reports the server already knows (A0 has no directory picker). */
function reportsOf(rows: readonly AccessRequest[], selfId: string): AccessPerson[] {
  const seen = new Map<string, AccessPerson>();
  for (const r of rows) if (r.beneficiary.id !== selfId) seen.set(r.beneficiary.id, r.beneficiary);
  return [...seen.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export default function RequestNewPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { session } = useSession();
  const { can, ready } = useCapabilities();
  const selfId = session?.sub ?? '';
  const decides = ready && can('DecideAccess');
  const mayRequest = ready && can('RequestAccess');
  const catalog = useFetch<ItemsResponse<CatalogItem>>(`${ACCESS_API}/catalog`);
  const reportsRead = useFetch<ItemsResponse<AccessRequest>>(decides ? `${ACCESS_API}/requests?scope=reports` : null);
  const reports = useMemo(() => reportsOf(reportsRead.data?.items ?? [], selfId), [reportsRead.data, selfId]);

  const preselected = params.get('item') ?? '';
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<RequestDraft>(() => ({ ...EMPTY_DRAFT, beneficiaryId: selfId, itemId: preselected }));
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const set = (patch: Partial<RequestDraft>) => { setDraft((d) => ({ ...d, ...patch })); setSubmitError(null); };

  const items = catalog.data?.items ?? [];
  const item = items.find((i) => i.id === draft.itemId) ?? null;
  // The beneficiary defaults to the signed-in user once the session lands.
  const beneficiaryId = draft.beneficiaryId || selfId;
  const effective = { ...draft, beneficiaryId };
  const problem = draftProblem(step, effective, item);
  const last = step === WIZARD_STEPS.length - 1;
  const back = { label: 'Requests', to: '/access/requests', onClick: (e: { preventDefault: () => void }) => { e.preventDefault(); navigate('/access/requests'); } };

  async function submit() {
    for (let s = 0; s < WIZARD_STEPS.length; s++) {
      const p = draftProblem(s, effective, item);
      if (p) { setStep(s); setSubmitError(p); return; }
    }
    setSubmitting(true);
    const res = await writeJson<AccessRequest>(`${ACCESS_API}/requests`, 'POST', submitBody(effective, selfId));
    setSubmitting(false);
    if (res.ok && res.data) { navigate(requestHref(res.data.id)); return; }
    setSubmitError(res.error ?? `The request was not submitted (HTTP ${res.status}).`);
  }

  const page = ACCESS_SURFACES['new-request'];
  const stepper = WIZARD_STEPS.map((label, i) => ({ step: i + 1, label, done: i < step, active: i === step }));

  let body;
  if (!mayRequest && ready) {
    body = <InlineAlert tone="info">Your role cannot request access. A requester, approver or access admin can.</InlineAlert>;
  } else if (catalog.error) {
    body = <UnavailableNotice error={catalog.error} what="the access catalog" source="The wizard reads what can be requested from access_catalog_items" onRetry={catalog.refresh} />;
  } else if (!catalog.data) {
    body = <LoadingState label="Loading the catalog…" />;
  } else if (step === 0) {
    body = (
      <PageSection size="sm" title="Who is it for?" description="Access is granted to the person named here; you cannot approve a request you made or benefit from.">
        <Stack gap="md">
          <RadioGroup<'self' | 'report'> name="access-who" value={beneficiaryId === selfId ? 'self' : 'report'}
            onChange={(v) => set({ beneficiaryId: v === 'self' ? selfId : (reports[0]?.id ?? '') })}
            options={[
              { value: 'self', label: `Myself (${session?.name ?? selfId})` },
              ...(decides ? [{ value: 'report' as const, label: 'Someone who reports to me', description: 'Approvers may request on behalf of a report.' }] : []),
            ]} data-testid="access-new-who" />
          {decides && beneficiaryId !== selfId && (
            reports.length ? (
              <FormField label="Report">
                {({ id }) => <Select id={id} size="sm" className="w-full max-w-72" value={beneficiaryId}
                  onChange={(e) => set({ beneficiaryId: e.target.value })}
                  options={reports.map((p) => ({ value: p.id, label: p.displayName }))} data-testid="access-new-report" />}
              </FormField>
            ) : (
              <InlineAlert tone="info">None of your reports has a request yet, so none can be chosen here. The directory picker arrives with lane A1.</InlineAlert>
            )
          )}
        </Stack>
      </PageSection>
    );
  } else if (step === 1) {
    body = (
      <PageSection size="sm" title="What do you need?" description="One catalog item per request. The approval chain depends on it.">
        <Stack gap="md">
          <FormField label="Catalog item">
            {({ id }) => <Select id={id} size="sm" className="w-full max-w-md" value={draft.itemId} placeholder="Choose an item"
              onChange={(e) => set({ itemId: e.target.value, duration: '' })}
              options={items.map((i) => ({ value: i.id, label: `${i.title}${i.heldByActor ? ' (you hold this)' : ''}` }))} data-testid="access-new-item" />}
          </FormField>
          {item && (
            <>
              <KeyValue items={[
                { label: 'Kind', value: KIND_LABELS[item.kind] },
                { label: 'Workspace', value: TENANT_LABELS[item.tenant] ?? item.tenant },
                { label: 'About', value: item.description },
                { label: 'Approved by', value: `Manager, then ${STEWARD_LABELS[item.stewardRule]}${item.sensitive ? ', then an access admin' : ''}` },
              ]} />
              <Stack gap="sm" data-testid="access-new-policy-check">
                <T size="sm" weight="semibold">Policy pre-check</T>
                {item.sodConflicts.length === 0 ? (
                  <InlineAlert tone="success">No separation-of-duties conflict with the access you hold now.</InlineAlert>
                ) : item.sodConflicts.map((c) => (
                  <InlineAlert key={c.policyId} tone={c.severity === 'block' ? 'error' : 'warning'}>
                    {`${c.severity === 'block' ? 'Blocked' : 'Warning'} (${c.policyId}): ${c.reason}`}
                  </InlineAlert>
                ))}
                {item.heldByActor && <InlineAlert tone="info">You already hold this. A request for someone else is still possible.</InlineAlert>}
              </Stack>
            </>
          )}
        </Stack>
      </PageSection>
    );
  } else if (step === 2) {
    const n = draft.justification.trim().length;
    body = (
      <PageSection size="sm" title="Why?" description="Approvers read this first. Say what the access is for and why now.">
        <FormField label="Justification" hint={`${n} of at least ${JUSTIFICATION_MIN} characters`} required>
          {(wiring) => <Textarea {...wiring} rows={5} value={draft.justification} onChange={(e) => set({ justification: e.target.value })} data-testid="access-new-justification" />}
        </FormField>
      </PageSection>
    );
  } else {
    body = (
      <PageSection size="sm" title="For how long?" description="Access ends on its own when the time is up. Standing access is the exception and needs a second reason.">
        <Stack gap="md">
          <RadioGroup<AccessDuration> name="access-duration" value={(draft.duration || item?.defaultDuration || '24h') as AccessDuration}
            onChange={(v) => set({ duration: v })} orientation="horizontal"
            options={DURATIONS.map((d) => ({ value: d, label: DURATION_LABELS[d], ...(d === item?.defaultDuration ? { description: 'This item’s default' } : {}) }))}
            data-testid="access-new-duration" />
          {(draft.duration || item?.defaultDuration) === 'standing' && (
            <FormField label="Why standing access?" hint={`At least ${JUSTIFICATION_MIN} characters`} required>
              {(wiring) => <Textarea {...wiring} rows={3} value={draft.standingReason} onChange={(e) => set({ standingReason: e.target.value })} data-testid="access-new-standing-reason" />}
            </FormField>
          )}
        </Stack>
      </PageSection>
    );
  }

  // A visible default counts as the choice: the duration step reads it into the draft before advancing.
  const advance = () => {
    if (step === 2 && !draft.duration && item) set({ duration: item.defaultDuration });
    setStep(step + 1);
  };

  return (
    // On the list pages' frame (FlushPage): the title at the page gutter, one h1;
    // each step is a 14/600 h2 section (PageSection size="sm"), the stepper compact (12px).
    <FlushPage data-testid="access-request-new">
      <PageHeader density="compact" title={page.title} description={page.description} back={back}
        badge={item ? <Chip tone="neutral" size="xs">{item.title}</Chip> : undefined} />
      <WorkflowStepper size="compact" steps={stepper} aria-label={`Step ${step + 1} of ${WIZARD_STEPS.length}`} data-testid="access-new-stepper" />
      {body}
      {submitError && <InlineAlert tone="error" onDismiss={() => setSubmitError(null)}>{submitError}</InlineAlert>}
      {mayRequest && catalog.data && (
        <Inline gap="sm" justify="between" align="center">
          <Button size="sm" variant="ghost" disabled={step === 0 || submitting} onClick={() => setStep(step - 1)} data-testid="access-new-back">Back</Button>
          <Inline gap="sm" align="center">
            {problem && <T size="xs" tone="secondary">{problem}</T>}
            {last ? (
              <Button size="sm" variant="primary" disabled={!!problem || submitting} onClick={() => void submit()} data-testid="access-new-submit">
                {submitting ? 'Submitting…' : 'Submit request'}
              </Button>
            ) : (
              <Button size="sm" variant="primary" disabled={!!problem} onClick={advance} data-testid="access-new-next">Next</Button>
            )}
          </Inline>
        </Inline>
      )}
    </FlushPage>
  );
}
