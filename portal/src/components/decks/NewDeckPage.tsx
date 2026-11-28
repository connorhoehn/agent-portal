// "New deck" as a page in its own tenant (no dialog): the library PageFrame with the shell's trail, the tenant's
// subject (an initiative, a team, a run, a conversation) inline, then both ways to start at once, no click to reveal
// either: the tenant's own generate path as one compact row ("From this initiative's facts", its fields and its
// button) and, directly under it, "From an example": the library TemplateGallery fed by GET <tenant>/deck-templates. Confirming creates the deck through the tenant's existing create route (with
// `templateId` for an example) and opens the editor. Each tenant page supplies the subject, the facts form and
// the two create calls; this frame owns the choice, the title and the gallery.

import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { Button, Disclosure, FormField, InlineAlert, Inline, Input, PageFrame, PageSection, Stack, T, useViewportWidth } from '@connorhoehn/ui-components/shared';
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

/** Below this window width the facts choice is one row (its name and its button) with its options folded under it. */
const COMPACT_FACTS_BELOW = 640;

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
  const [templates, setTemplates] = useState<DeckTemplateSummary[] | null>(null);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const [templateId, setTemplateId] = useState<string | null>(preset);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState<NewDeckSource | null>(null);
  const [attempt, setAttempt] = useState(0);
  const compactFacts = useViewportWidth() < COMPACT_FACTS_BELOW;

  useEffect(() => {
    const ctl = new AbortController();
    setTemplatesError(null);
    listDeckTemplates(tenant, ctl.signal).then((out) => setTemplates(out.templates ?? [])).catch((err: unknown) => {
      if (!ctl.signal.aborted) setTemplatesError(err instanceof Error ? err.message : 'The examples could not be read.');
    });
    return () => ctl.abort();
  }, [tenant, attempt]);

  const chosen = templates?.find((t) => t.id === templateId) ?? null;
  const canStart = ready && !busy && !denied;

  async function go(source: NewDeckSource) {
    if (!canStart || (source === 'facts' ? !facts : !chosen)) return;
    setBusy(source);
    try {
      const id = source === 'facts' && facts ? await facts.create(title.trim()) : await props.createFromTemplate(chosen!.id, title.trim());
      navigate(props.deckHref(id));
    } catch (err) {
      // The server's own sentence (a 403 says why: not on the initiative); never an empty toast.
      toastError(null, 'Could not create the deck', err instanceof Error && err.message.trim() ? err.message : 'Try again.');
    } finally {
      setBusy(null);
    }
  }

  const factsBody = facts ? (
    <Stack gap="xs">
      <Inline gap="md" align="end" wrap>{facts.fields}</Inline>
      {facts.note && <T size="xs" tone="secondary" wrap>{facts.note}</T>}
    </Stack>
  ) : null;
  const factsAction = facts ? (
    <Button variant="primary" size="sm" disabled={!canStart} onClick={() => { void go('facts'); }} data-testid={`${testIdPrefix}-new-submit`}>
      {busy === 'facts' ? facts.busyLabel : facts.submitLabel}</Button>
  ) : null;
  // Each choice carries its own button; the header has none, and its title wraps rather than truncating at phone width.
  // The sections are PageSection, h2 under the frame's h1 (ui-components 2.549.0).
  return (
    <PageFrame title={props.title} titleOverflow="wrap" description={props.description} breadcrumbs={breadcrumbs} data-testid={`${testIdPrefix}-new`}>
      <Stack gap="lg">
        {props.subject}
        {denied ? <InlineAlert tone="info" data-testid={`${testIdPrefix}-new-denied`}>{denied}</InlineAlert> : (
          <>
            <FormField label="Title" className="w-full min-w-0 sm:w-auto sm:max-w-md">
              {({ id }) => <Input id={id} value={title} placeholder={props.titlePlaceholder} onChange={(e) => setTitle(e.target.value)} data-testid={`${testIdPrefix}-new-title`} />}
            </FormField>
            {facts && (
              <PageSection size="sm" title={facts.label} data-testid={`${testIdPrefix}-new-facts`} {...(compactFacts ? {} : { actions: factsAction })}>
                {/* At phone width the choice is one row, its options folded beside its button, so the examples show on arrival. */}
                {compactFacts ? (
                  <Inline gap="sm" align="start" wrap={false}>
                    <Disclosure density="compact" className="min-w-0 flex-1" summary={<T as="span" size="xs" weight="medium">Options</T>} data-testid={`${testIdPrefix}-new-facts-options`}>{factsBody}</Disclosure>
                    {factsAction}
                  </Inline>
                ) : factsBody}
              </PageSection>
            )}
            <PageSection size="sm" title="From an example" data-testid={`${testIdPrefix}-new-examples`}
              actions={<Button variant={facts ? 'secondary' : 'primary'} size="sm" disabled={!canStart || !chosen} onClick={() => { void go('example'); }}
                data-testid={`${testIdPrefix}-new-template-submit`}>{busy === 'example' ? 'Creating…' : chosen ? `Create from ${chosen.title}` : 'Choose an example'}</Button>}>
              {/* The note on its own wrapping line: as a hint beside the title it truncated at phone width. */}
              <T size="xs" tone="secondary" wrap>{props.exampleNote ?? EXAMPLE_NOTE}</T>
              {templatesError ? (
                <InlineAlert tone="error">The examples could not be read: {templatesError} <Button size="sm" variant="link" onClick={() => setAttempt((n) => n + 1)}>Retry</Button></InlineAlert>
              ) : (
                <TemplateGallery templates={templates ? templateTiles(templates) : []} loading={templates === null} selectedId={templateId ?? undefined}
                  onSelect={setTemplateId} label="Example decks" emptyTitle="No examples here" emptyDescription="This workspace offers no example decks yet."
                  testIdPrefix={`${testIdPrefix}-template`} />
              )}
              {chosen && <T size="xs" tone="secondary" wrap>{chosen.title}: {chosen.slideCount} slides, {chosen.layouts.length} layouts.</T>}
            </PageSection>
          </>
        )}
      </Stack>
    </PageFrame>
  );
}
