// "New deck" as a page in its own tenant (no dialog): the library PageFrame with the shell's trail, the tenant's
// subject (an initiative, a team, a run, a conversation) inline, then two ways to start, the tenant's own generate
// path first ("From this initiative's facts") beside "From an example": the library TemplateGallery fed by
// GET <tenant>/deck-templates. Confirming creates the deck through the tenant's existing create route (with
// `templateId` for an example) and opens the editor. Each tenant page supplies the subject, the facts form and
// the two create calls; this frame owns the choice, the title and the gallery.

import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { Button, DetailSection, FormField, InlineAlert, Inline, Input, PageFrame, SegmentedControl, Stack, T } from '@connorhoehn/ui-components/shared';
import { TemplateGallery, type DeckTemplate } from '@connorhoehn/ui-components/doc-editor';
import { useFlushTrailItems } from '../shell/FlushPage';
import { listDeckTemplates, type DeckTemplateSummary, type DeckTenantId } from './deckApi';
import { toastError } from '../../lib/toastStore';

export type NewDeckSource = 'facts' | 'example';

export interface NewDeckFacts {
  /** "From this initiative's facts". */
  label: string;
  /** The tenant's existing form fields (focus, narrative, dimensions…), inline. */
  fields: ReactNode;
  /** One line under the form on what is read from the record. */
  note?: string;
  submitLabel: string;
  busyLabel: string;
  /** Builds through the tenant's generate route; resolves to the new deck's id. */
  create: (title: string) => Promise<string>;
}

export interface NewDeckPageProps {
  tenant: DeckTenantId;
  title: string;
  description: string;
  testIdPrefix: string;
  /** The subject chooser (inline) when the address did not name one, or a line naming it. */
  subject: ReactNode;
  /** Whether the subject is chosen, so a create can go. */
  ready: boolean;
  titlePlaceholder: string;
  /** Null when this tenant has no generate path on this page (Social: /deck stays in the conversation). */
  facts: NewDeckFacts | null;
  /** Shown instead of the create controls when the role cannot create decks here. */
  denied: string | null;
  createFromTemplate: (templateId: string, title: string) => Promise<string>;
  deckHref: (deckId: string) => string;
  /** A line under the example choice (what the template's example sources mean). */
  exampleNote?: string;
}

const EXAMPLE_NOTE = 'The example slides are about an invented organisation and cite it as their source; the editor marks each slide until you replace its content and sources with your own.';

export const templateTiles = (templates: readonly DeckTemplateSummary[]): DeckTemplate[] => templates.map((t) => ({
  id: t.id, title: t.title, description: t.description, slideCount: t.slideCount,
  ...(t.audience ? { audience: t.audience } : {}), previews: (t.preview ?? []).map((p) => p.svg).filter(Boolean),
}));

export function NewDeckPage(props: NewDeckPageProps) {
  const { tenant, facts, ready, denied, testIdPrefix } = props;
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const breadcrumbs = useFlushTrailItems();
  const preset = params.get('template');
  const [source, setSource] = useState<NewDeckSource>(facts && !preset ? 'facts' : 'example');
  const [templates, setTemplates] = useState<DeckTemplateSummary[] | null>(null);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const [templateId, setTemplateId] = useState<string | null>(preset);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const ctl = new AbortController();
    setTemplatesError(null);
    listDeckTemplates(tenant, ctl.signal).then((out) => setTemplates(out.templates ?? [])).catch((err: unknown) => {
      if (!ctl.signal.aborted) setTemplatesError(err instanceof Error ? err.message : 'The examples could not be read.');
    });
    return () => ctl.abort();
  }, [tenant, attempt]);

  const chosen = templates?.find((t) => t.id === templateId) ?? null;
  const canGo = ready && !busy && !denied && (source === 'facts' ? !!facts : !!chosen);

  async function go() {
    if (!canGo) return;
    setBusy(true);
    try {
      const id = source === 'facts' && facts ? await facts.create(title.trim()) : await props.createFromTemplate(chosen!.id, title.trim());
      navigate(props.deckHref(id));
    } catch (err) {
      toastError(null, 'Could not create the deck', err instanceof Error ? err.message : 'Try again.');
    } finally {
      setBusy(false);
    }
  }

  const submitLabel = busy ? (source === 'facts' && facts ? facts.busyLabel : 'Creating…')
    : source === 'facts' && facts ? facts.submitLabel : chosen ? `Create from ${chosen.title}` : 'Choose an example';

  return (
    <PageFrame title={props.title} description={props.description} breadcrumbs={breadcrumbs} data-testid={`${testIdPrefix}-new`}
      actions={denied ? undefined : <Button variant="primary" disabled={!canGo} onClick={() => { void go(); }} data-testid={`${testIdPrefix}-new-submit`}>{submitLabel}</Button>}>
      <Stack gap="lg">
        {props.subject}
        {denied ? <InlineAlert tone="info" data-testid={`${testIdPrefix}-new-denied`}>{denied}</InlineAlert> : (
          <>
            <Inline gap="md" align="end" wrap>
              {facts && (
                <SegmentedControl aria-label="How to start" value={source} onChange={(v) => setSource(v as NewDeckSource)}
                  options={[{ value: 'facts', label: facts.label }, { value: 'example', label: 'From an example' }]} />
              )}
              <FormField label="Title">
                {({ id }) => <Input id={id} value={title} placeholder={props.titlePlaceholder} onChange={(e) => setTitle(e.target.value)} data-testid={`${testIdPrefix}-new-title`} />}
              </FormField>
            </Inline>
            {source === 'facts' && facts ? (
              <DetailSection title={facts.label} as="h2">
                <Stack gap="md">
                  {facts.fields}
                  {facts.note && <InlineAlert tone="info">{facts.note}</InlineAlert>}
                </Stack>
              </DetailSection>
            ) : (
              <DetailSection title="From an example" as="h2" hint={props.exampleNote ?? EXAMPLE_NOTE}>
                {templatesError ? (
                  <InlineAlert tone="error">The examples could not be read: {templatesError} <Button size="sm" variant="link" onClick={() => setAttempt((n) => n + 1)}>Retry</Button></InlineAlert>
                ) : (
                  <TemplateGallery templates={templates ? templateTiles(templates) : []} loading={templates === null} selectedId={templateId ?? undefined}
                    onSelect={setTemplateId} label="Example decks" emptyTitle="No examples here" emptyDescription="This workspace offers no example decks yet."
                    testIdPrefix={`${testIdPrefix}-template`} />
                )}
                {chosen && <T size="xs" tone="secondary" wrap>{chosen.title}: {chosen.slideCount} slides, {chosen.layouts.length} layouts.</T>}
              </DetailSection>
            )}
          </>
        )}
      </Stack>
    </PageFrame>
  );
}
