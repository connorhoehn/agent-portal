// `/deck` in the tenants' own discussions: an orgiq initiative's Discussion
// builds the initiative status deck (slice 6, /api/initiative-decks) and a
// pipelines run's thread builds the run report deck (slice 3, /api/pipelines).
// Social's `/deck` is its own flow run (pages/social/decks); these tenants build
// synchronously through the deck routes the pages already use, so the command
// calls the same create function and leaves a private card for the stored deck.
//
// One write rule (deckWriteAuthority, mirrored by DECK_WRITE_ACTION): whoever
// may run the tenant's agent builds. A reader's `/deck` is refused with the
// reason. Budget figures stay the server's tier decision: the portal never asks
// for them, and a deck that carries them is never posted into a thread.
//
// Pure: no React, so node:test covers the routing.

import type { ChatCommand } from '@connorhoehn/ui-components/social';
import { parseDeckText } from '@connorhoehn/ui-components/doc-editor';
import { DECK_WRITE_ACTION, type DeckSpec, type DeckPreviewResult, type DeckDetailCore, type DeckTenantId } from '../decks/deckApi.ts';
import {
  createInitiativeDeck, getInitiativeDeck, getInitiativeDeckSpec, initiativeDeckPaths, narrativeNotice as initiativeNotice, previewInitiativeDeck,
  shareWithheldReason, type InitiativeDeckDetail,
} from '../../pages/projects/decks/initiativeDecksApi.ts';
import {
  createRunDeck, getRunDeck, getRunDeckSpec, narrativeNotice as runNotice, previewRunDeck, runDeckPaths,
} from '../../pages/pipelines/decks/pipelineDecksApi.ts';

export const TENANT_DECK_PIPELINE_ID = 'tenant-deck';

export interface TenantDeckAdapter {
  tenant: Extract<DeckTenantId, 'orgiq' | 'pipelines'>;
  /** What the deck is called in copy. */
  noun: string;
  /** The Cedar action that builds it (DECK_WRITE_ACTION). */
  action: string;
  targetId: string;
  create(input: { title?: string; narrative: boolean }): Promise<{ deckId: string; notice: string | null }>;
  detail(deckId: string): Promise<DeckDetailCore & { includesBudget?: boolean }>;
  spec(deckId: string, revisionId: string): Promise<DeckSpec>;
  preview(deckId: string, spec: DeckSpec): Promise<DeckPreviewResult>;
  page(deckId: string): string;
  /** Why the deck cannot be posted into the thread, or null. */
  postWithheld(detail: { includesBudget?: boolean }): string | null;
}

// A run id may itself contain a colon (`agent-run:<uuid>`), so the id is the rest of the channel.
const INITIATIVE = /^orgiq:initiative:([^:]+)$/;
const RUN = /^pipelines:run:(.+)$/;

/** The tenant deck a conversation channel builds, or null (work items, definitions, huddles, Social: no `/deck` here). */
export function tenantDeckAdapterOf(channel: string | null): TenantDeckAdapter | null {
  const initiative = channel ? INITIATIVE.exec(channel)?.[1] : undefined;
  if (initiative) {
    return {
      tenant: 'orgiq', noun: 'status deck', action: DECK_WRITE_ACTION.orgiq, targetId: initiative,
      async create(input) {
        const out = await createInitiativeDeck(initiative, { ...(input.title ? { title: input.title } : {}), ...(input.narrative ? { narrative: true } : {}) });
        return { deckId: out.deckId, notice: initiativeNotice(out.narrative) };
      },
      detail: deckId => getInitiativeDeck(deckId) as Promise<InitiativeDeckDetail>,
      spec: getInitiativeDeckSpec, preview: previewInitiativeDeck, page: initiativeDeckPaths.page,
      postWithheld: detail => shareWithheldReason({ includesBudget: !!detail.includesBudget }),
    };
  }
  const run = channel ? RUN.exec(channel)?.[1] : undefined;
  if (run) {
    return {
      tenant: 'pipelines', noun: 'run report deck', action: DECK_WRITE_ACTION.pipelines, targetId: run,
      async create(input) {
        const out = await createRunDeck(run, { ...(input.title ? { title: input.title } : {}), ...(input.narrative ? { narrative: true } : {}) });
        return { deckId: out.deckId, notice: runNotice(out.narrative) };
      },
      detail: getRunDeck, spec: getRunDeckSpec, preview: previewRunDeck, page: runDeckPaths.page,
      postWithheld: () => null,
    };
  }
  return null;
}

export interface TenantDeckRequest { title?: string; preview: boolean }

/**
 * The library grammar, as far as these tenants take it: the prompt becomes the
 * title (`#page` tokens name pages only Social cites, so they are dropped), and
 * `--from` is refused (these decks read the record, not a transcript).
 * Returns the refusal as a string.
 */
export function parseTenantDeckText(argumentText: string): TenantDeckRequest | string {
  const parsed = parseDeckText(argumentText);
  if (parsed.from) return '/deck here builds from the record, so --from does not apply. Remove it and try again.';
  const title = parsed.prompt.split(/\s+/).filter(word => word && !word.startsWith('#')).join(' ').trim();
  return { ...(title ? { title } : {}), preview: parsed.preview };
}

/** Why a reader may not build, or null. */
export const deckRefusal = (adapter: TenantDeckAdapter): string =>
  `Your role cannot build ${adapter.tenant === 'orgiq' ? 'an initiative status deck' : 'a run report deck'}. ${adapter.tenant === 'orgiq' ? 'An SME or program owner can' : 'Someone who can run pipelines can'}.`;

/** The tenant `/deck`. `ctx.deckWriter` is the hook's reading of the capability (presentation only: the server decides again). */
export const tenantDeckCommand: ChatCommand = {
  trigger: '/deck',
  label: 'Build a deck from this record',
  hint: '<title> · --preview',
  description: 'Builds the deck from the record behind this page. Counts and figures come from the record; Nova only writes prose. The card is private until you post it.',
  scope: 'always',
  async run(ctx) {
    const adapter = tenantDeckAdapterOf(ctx.channel);
    if (!adapter) throw new Error('/deck is not available in this conversation.');
    if ((ctx as { deckWriter?: boolean }).deckWriter === false) throw new Error(deckRefusal(adapter));
    const request = parseTenantDeckText(ctx.argumentText);
    if (typeof request === 'string') throw new Error(request);
    const built = await adapter.create({ ...(request.title ? { title: request.title } : {}), narrative: true });
    return { kind: 'run', runId: built.deckId, pipelineId: TENANT_DECK_PIPELINE_ID, card: { notice: built.notice },
      echo: ctx.text.trim() || '/deck', visibility: 'private' };
  },
};
