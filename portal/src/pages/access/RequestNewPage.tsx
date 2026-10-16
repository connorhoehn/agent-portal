// /access/requests/new — the request form (docs/access-tenant-design.md §4.1),
// one page on the library's FormWizard: what (a searchable catalog picker,
// preselected from `?item=`), why (≥20 characters), how long (the item's
// default selected; standing asks for its own reason, A6) and — only when the
// actor may file for someone else — who, chosen with the library's PersonPicker
// (an approver's direct reports; for an access admin every person in the
// directory, granted or not: GET /api/access/beneficiaries).
//
// Beside the form, a live summary from POST /api/access/requests/preview — the
// same chain resolution and SoD pre-check a submit runs, written nowhere:
// what you'll get, who approves it (step by step, by name), until when (the
// concrete date), and the separation-of-duties result. Submit lives with the
// summary; a duplicate or a blocking policy shows there before and after the
// POST. Success opens the new record, where the chain continues live.

import {
  FormField,
  FormWizard,
  Combobox,
  InlineAlert,
  KeyValue,
  Link,
  LoadingState,
  PageHeader,
  PersonPicker,
  RadioGroup,
  Stack,
  T,
  Textarea,
  type FormWizardSection,
} from '@connorhoehnslalom/ui-components/shared';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
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
  STEP_KIND_LABELS,
  TENANT_LABELS,
  previewStepLabel,
  requestHref,
  sectionProblems,
  submitBody,
  expiryDateLabel,
  untilLabel,
  type AccessDuration,
  type AccessPerson,
  type AccessRequest,
  type AccessRequestPreview,
  type CatalogItem,
  type ItemsResponse,
  type RequestDraft,
} from '../../lib/accessRequests';
import { ACCESS_SURFACES } from './accessSurfaces';

/** A link that opens in-app (plain clicks) and still works as a real href. */
function RequestLink({ id, children }: { id: string; children: ReactNode }) {
  const navigate = useNavigate();
  return (
    <Link href={requestHref(id)} data-testid="access-new-existing"
      onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); navigate(requestHref(id)); }}>
      {children}
    </Link>
  );
}

/** The preview for the current choice, refreshed as it changes; stale answers are dropped. */
function usePreview(itemId: string, beneficiaryId: string, selfId: string, duration: AccessDuration | '', enabled: boolean) {
  const [state, setState] = useState<{ key: string; data: AccessRequestPreview | null; error: string | null } | null>(null);
  const key = `${itemId}|${beneficiaryId}|${duration}`;
  useEffect(() => {
    if (!enabled || !itemId || !beneficiaryId) return undefined;
    let live = true;
    void writeJson<AccessRequestPreview>(`${ACCESS_API}/requests/preview`, 'POST', {
      itemId, ...(beneficiaryId !== selfId ? { beneficiaryId } : {}), ...(duration ? { duration } : {}),
    }).then((res) => {
      if (!live) return;
      setState({ key, data: res.ok ? res.data : null, error: res.ok ? null : (res.error ?? `HTTP ${res.status}`) });
    });
    return () => { live = false; };
  }, [key, itemId, beneficiaryId, selfId, duration, enabled]);
  const current = state?.key === key ? state : null;
  return { preview: current?.data ?? null, error: current?.error ?? null, loading: enabled && !!itemId && !!beneficiaryId && !current };
}

export default function RequestNewPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { session } = useSession();
  const { can, ready } = useCapabilities();
  const selfId = session?.sub ?? '';
  const mayRequest = ready && can('RequestAccess');
  const catalog = useFetch<ItemsResponse<CatalogItem>>(`${ACCESS_API}/catalog`);
  const people = useFetch<ItemsResponse<AccessPerson>>(mayRequest ? `${ACCESS_API}/beneficiaries` : null);
  const beneficiaries = people.data?.items ?? [];

  const [draft, setDraft] = useState<RequestDraft>(() => ({ ...EMPTY_DRAFT, itemId: params.get('item') ?? '' }));
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<ReactNode>(null);
  const set = (patch: Partial<RequestDraft>) => { setDraft((d) => ({ ...d, ...patch })); setSubmitError(null); };

  const items = useMemo(() => catalog.data?.items ?? [], [catalog.data]);
  const item = items.find((i) => i.id === draft.itemId) ?? null;
  // The beneficiary defaults to the signed-in user; the visible duration default counts as the choice.
  const beneficiaryId = draft.beneficiaryId || selfId;
  const duration: AccessDuration | '' = draft.duration || item?.defaultDuration || '';
  const effective: RequestDraft = { ...draft, beneficiaryId, duration };
  const problems = sectionProblems(effective, item);
  const { preview, error: previewError, loading: previewLoading } = usePreview(item?.id ?? '', beneficiaryId, selfId, duration, mayRequest);
  const blocked = !!preview?.refusal || preview?.sod.verdict === 'block';

  async function submit() {
    setSubmitting(true);
    const res = await writeJson<AccessRequest & { requestId?: string; sod?: AccessRequestPreview['sod'] }>(`${ACCESS_API}/requests`, 'POST', submitBody(effective, selfId));
    setSubmitting(false);
    if (res.ok && res.data) { navigate(requestHref(res.data.id)); return; }
    const existing = res.data?.requestId;
    const sod = res.data?.sod?.conflicts ?? [];
    setSubmitError(
      <Stack gap="xs">
        <span>{res.error ?? `The request was not submitted (HTTP ${res.status}).`}</span>
        {existing && <RequestLink id={existing}>Open the existing request</RequestLink>}
        {sod.map((c) => <span key={c.policyId}>{`${c.title ?? 'Separation of duties'}: ${c.reason}`}</span>)}
      </Stack>,
    );
  }

  const page = ACCESS_SURFACES['new-request'];
  const back = { label: 'Requests', to: '/access/requests', onClick: (e: { preventDefault: () => void }) => { e.preventDefault(); navigate('/access/requests'); } };

  const sections: FormWizardSection[] = [
    {
      key: 'who', title: 'Who is it for?', label: 'Who', hidden: beneficiaries.length < 2, error: problems.who,
      description: 'Access is granted to the person named here. Nobody approves a request they made or benefit from.',
      content: (
        <FormField label="Person" required>
          {(w) => <PersonPicker {...w} size="sm" value={beneficiaryId} onChange={(v) => set({ beneficiaryId: v })} placeholder="Search people"
            emptyMessage="Nobody you may request for matches"
            people={beneficiaries.map((p) => ({ id: p.id, name: p.displayName, ...(p.id === selfId ? { tag: 'You' } : {}) }))}
            data-testid="access-new-who" />}
        </FormField>
      ),
    },
    {
      key: 'what', title: 'What do you need?', label: 'What', error: problems.what,
      description: 'One catalog item per request. The approval chain depends on it.',
      content: (
        <FormField label="Catalog item" hint="Search by name, workspace or what it opens." required>
          {(w) => <Combobox {...w} size="sm" value={draft.itemId} onChange={(v) => set({ itemId: v, duration: '' })} placeholder="Search the catalog"
            maxOptions={50} emptyMessage="No catalog item matches"
            options={items.map((i) => ({
              value: i.id, label: i.title, meta: TENANT_LABELS[i.tenant] ?? i.tenant,
              description: `${KIND_LABELS[i.kind]} · ${i.description}${i.heldByActor ? ' · You hold this' : ''}`,
            }))}
            data-testid="access-new-item" />}
        </FormField>
      ),
    },
    {
      key: 'why', title: 'Why?', label: 'Why', error: problems.why,
      description: 'Approvers read this first. Say what the access is for and why now.',
      content: (
        <FormField label="Justification" hint={`${draft.justification.trim().length} of at least ${JUSTIFICATION_MIN} characters`} required>
          {(w) => <Textarea {...w} rows={4} value={draft.justification} onChange={(e) => set({ justification: e.target.value })} data-testid="access-new-justification" />}
        </FormField>
      ),
    },
    {
      key: 'how-long', title: 'For how long?', label: 'How long', error: problems.howLong,
      description: 'Access ends on its own when the time is up. Standing access is the exception and needs a second reason.',
      content: (
        <>
          <RadioGroup<AccessDuration> name="access-duration" aria-label="Duration" value={(duration || '24h') as AccessDuration}
            onChange={(v) => set({ duration: v })} orientation="horizontal"
            options={DURATIONS.map((d) => ({ value: d, label: DURATION_LABELS[d], ...(d === item?.defaultDuration ? { description: 'This item’s default' } : {}) }))}
            data-testid="access-new-duration" />
          {duration === 'standing' && (
            <FormField label="Why standing access?" hint={`${draft.standingReason.trim().length} of at least ${JUSTIFICATION_MIN} characters`} required>
              {(w) => <Textarea {...w} rows={3} value={draft.standingReason} onChange={(e) => set({ standingReason: e.target.value })} data-testid="access-new-standing-reason" />}
            </FormField>
          )}
        </>
      ),
    },
  ];

  const beneficiaryName = beneficiaryId === selfId ? `${session?.name ?? selfId} (you)`
    : beneficiaries.find((p) => p.id === beneficiaryId)?.displayName ?? beneficiaryId;
  const summary = !item ? (
    <T size="sm" tone="secondary" data-testid="access-new-summary-empty">Choose a catalog item to see who approves it, until when, and the policy check.</T>
  ) : (
    <>
      <KeyValue layout="row" labelWidth="w-24" data-testid="access-new-summary-facts" items={[
        { label: 'You get', value: item.title },
        { label: 'Workspace', value: `${TENANT_LABELS[item.tenant] ?? item.tenant} · ${KIND_LABELS[item.kind]}` },
        { label: 'For', value: beneficiaryName },
        { label: 'Until', muted: !preview, value: !preview ? '…' : preview.duration === 'standing' || !preview.expiresIfProvisionedNow ? untilLabel(preview.duration, null) : (
          <Stack gap="none"><span>{expiryDateLabel(preview.expiresIfProvisionedNow)}</span><T size="xs" tone="secondary">{`${DURATION_LABELS[preview.duration]} from approval`}</T></Stack>
        ) },
      ]} />
      {previewLoading && !preview && <LoadingState label="Resolving the approval chain…" />}
      {previewError && <InlineAlert tone="error">{`The approval chain could not be previewed: ${previewError}`}</InlineAlert>}
      {preview && (
        <>
          <KeyValue layout="row" labelWidth="w-24" aria-label="Who approves" data-testid="access-new-chain" items={preview.steps.map((s) => ({
            label: `${s.step}. ${STEP_KIND_LABELS[s.kind]}`,
            value: s.escalated ? <Stack gap="none"><span>{previewStepLabel(s)}</span><T size="xs" tone="secondary">{s.escalated}</T></Stack> : previewStepLabel(s),
          }))} />
          <Stack gap="xs" data-testid="access-new-policy-check">
            {preview.sod.verdict === 'clear' ? (
              <InlineAlert tone="success">No separation-of-duties conflict with the access {beneficiaryId === selfId ? 'you hold' : 'they hold'} now.</InlineAlert>
            ) : preview.sod.conflicts.map((c) => (
              <InlineAlert key={c.policyId} tone={c.severity === 'block' ? 'error' : 'warning'}>
                {`${c.severity === 'block' ? 'Blocked' : 'Warning'} (${c.title ?? 'separation of duties'}): ${c.reason}`}
              </InlineAlert>
            ))}
            {preview.refusal && preview.sod.verdict !== 'block' && (
              <InlineAlert tone={preview.refusal.requestId ? 'info' : 'error'} data-testid="access-new-refusal">
                <Stack gap="xs">
                  <span>{preview.refusal.error}</span>
                  {preview.refusal.requestId && <RequestLink id={preview.refusal.requestId}>Open the existing request</RequestLink>}
                </Stack>
              </InlineAlert>
            )}
          </Stack>
        </>
      )}
    </>
  );

  let body: ReactNode;
  if (!mayRequest && ready) {
    body = <InlineAlert tone="info">Your role cannot request access. A requester, approver or access admin can.</InlineAlert>;
  } else if (catalog.error) {
    body = <UnavailableNotice error={catalog.error} what="the access catalog" source="The form reads what can be requested from access_catalog_items" onRetry={catalog.refresh} />;
  } else if (!catalog.data || !ready) {
    body = <LoadingState label="Loading the catalog…" />;
  } else {
    body = (
      <FormWizard sections={sections} summary={summary} summaryTitle="Your request" aria-label="New access request"
        onSubmit={submit} submitLabel="Submit request" submitting={submitting} submitDisabled={blocked}
        submitError={submitError} onDismissError={() => setSubmitError(null)} data-testid="access-new" />
    );
  }

  return (
    // The list pages' frame (FlushPage): the title at the page gutter, one h1; each
    // section a 14/600 heading with a 12/400 description (FormWizard).
    <FlushPage data-testid="access-request-new">
      <PageHeader density="compact" title={page.title} description={page.description} back={back} />
      {body}
    </FlushPage>
  );
}
