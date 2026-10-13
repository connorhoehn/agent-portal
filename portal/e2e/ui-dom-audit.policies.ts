/** Reviewed composer policies; exceptions require positive evidence of the view. */
export type ComposerPolicy = { mode: 'required' } | { mode: 'exempt'; reason: string };
export interface PipelineViewEvidence {
  graph?: boolean;
  communicationOverview?: boolean;
  socialAccessRequired?: boolean;
  configurationForm?: boolean;
  settingsPlaceholder?: boolean;
  missingDeck?: boolean;
}
export function pipelineComposerPolicy(path: string, view: PipelineViewEvidence = {}): ComposerPolicy | undefined {
  const pathname = new URL(path, 'http://audit.local').pathname;
  if (/^\/pipelines(?:\/(?:runs(?:\/[^/]+)?|definitions|runbooks|queues|artifacts|approvals|agents|bots|commands))?$/.test(pathname)) return { mode: 'required' };
  if (pathname === '/pipelines/activity' && view.graph) return { mode: 'exempt', reason: 'The spatial work graph uses its own date, focus and node controls; collection commands are available in Runs.' };
  if (pathname === '/pipelines/communication') {
    if (view.socialAccessRequired) return { mode: 'exempt', reason: 'Social access is unavailable for this viewer; the visible access state explains how to obtain it.' };
    if (view.communicationOverview) return { mode: 'exempt', reason: 'The communication directory has no selected conversation. Selecting a channel or person opens its contextual composer.' };
  }
  if (pathname === '/pipelines/configuration' && view.configurationForm) return { mode: 'exempt', reason: 'This single-setting approval-authority form uses an explicit role selector and Save action, rather than a searchable collection.' };
  if (pathname === '/pipelines/settings' && view.settingsPlaceholder) return { mode: 'exempt', reason: 'The preferences feature is not available yet; the page displays its registration state and exposes no configurable data.' };
  if (/^\/pipelines\/decks\/[^/]+$/.test(pathname)) return view.missingDeck
    ? { mode: 'exempt', reason: 'The report endpoint returned 404 and its load-error view is visible; there is no document to compose against. Loaded report coverage remains separate.' }
    : { mode: 'required' };
  return undefined;
}

/**
 * Evidence the adapter gathers on an orgiq / assessment / social route. Every
 * flag is a positive observation of the rendered view, never an inference from
 * the composer's absence. The inventory's `table` judge is the one piece of
 * static evidence: it marks the app's list pages (docs/layout-cascade.md).
 */
export interface TenantViewEvidence {
  /** The route carries the inventory's `table` judge (a list page). */
  listRoute?: boolean;
  /** `[data-collection-page]` or a collection toolbar is visible. */
  collection?: boolean;
  /** A content table is visible (not inside a dialog or an editor). */
  table?: boolean;
  /** A visible table has its own search or filter control. */
  tableSearch?: boolean;
  /** A `ListRailLayout` (`[data-list-rail]`) is visible: a rail of records with a detail column. */
  listRail?: boolean;
  /** A `[data-composer-surface]` is visible: whatever it is, it must be real. */
  composer?: boolean;
  /** A spatial canvas is visible (work graph, activity graph, A2A/flow canvas). */
  graph?: boolean;
  /** One or more charts are visible. */
  charts?: boolean;
  /** The chat workspace rail is visible with no selected conversation. */
  chatDirectory?: boolean;
  /** The document rail is visible with no document open (the library/directory view). */
  documentDirectory?: boolean;
  /** Communication plane states, shared with the pipelines policy. */
  communicationOverview?: boolean;
  socialAccessRequired?: boolean;
  /** A configuration/settings surface: its marker, or a settings route whose content is controls. */
  settingsSurface?: boolean;
  /** A `<form>` or preference controls are the page's content. */
  form?: boolean;
  /** A registered-but-unavailable surface shows its placeholder state. */
  placeholder?: boolean;
  /** The Computer Lab workspace (boxes, panes, its own terminal input) is visible. */
  lab?: boolean;
  /** A section landing (`[data-testid$="-landing"]`): links and summaries, no collection of its own. */
  landing?: boolean;
  /** Deck route whose API answered 404 and whose load-error view is visible. */
  missingDeck?: boolean;
  /** Record/editor route whose record is missing: API 404 plus the visible unavailable state. */
  missingRecord?: boolean;
  /** Record route that rendered a titled detail (section titles, heading or pane). */
  recordDetail?: boolean;
  /** Social channel states. */
  channelNotJoined?: boolean;
  sharedWorkView?: boolean;
}

export interface TenantRouteSpec { tenant: string; path: string; kind?: string; judges?: readonly string[]; pattern?: string }

const TENANTS = new Set(['orgiq', 'assessment', 'social']);

/** Reviewed collections that render an empty state in the seeded mock, so no table is visible to prove them. */
const REVIEWED_COLLECTIONS = new Set(['/iq/work/changes', '/admin/changes', '/admin/projects', '/admin/observability/sessions', '/admin/observability/capability-events']);
/** Reviewed non-collection pages whose evidence is only the absence of a table; each carries its own reason. */
const REVIEWED_LANDINGS: Record<string, string> = {
  '/iq/prompt-ops': 'Prompt Ops home: summary strips and links to Prompts, History, Diff and Evaluations; the collections live on those pages.',
  '/iq/scores/cohorts': 'Department cohort comparison cards computed server-side; there is no record list to search or filter.',
};

/**
 * The reviewed policy for the three non-pipelines tenants. Order matters: a
 * list page, a searchable table or a visible composer is `required` before
 * any exemption is considered, so an exemption can never hide a collection
 * that lost its composer. Anything without positive evidence stays unclassified.
 */
export function tenantComposerPolicy(spec: TenantRouteSpec, view: TenantViewEvidence = {}): ComposerPolicy | undefined {
  if (!TENANTS.has(spec.tenant)) return undefined;
  const pathname = new URL(spec.path, 'http://audit.local').pathname;
  const record = spec.kind === 'record' || spec.kind === 'editor';
  if (view.listRoute || spec.judges?.includes('table') || view.collection) return { mode: 'required' };
  if (REVIEWED_COLLECTIONS.has(pathname)) return { mode: 'required' };
  if (view.tableSearch) return { mode: 'required' };
  if (view.composer) return { mode: 'required' };
  if (/^\/(?:iq|assessment|social)\/decks\/[^/]+$/.test(pathname)) return view.missingDeck
    ? { mode: 'exempt', reason: 'The deck endpoint returned 404 and its load-error view is visible; there is no document to compose against. Loaded deck coverage remains separate.' }
    : { mode: 'required' };
  if (/^\/(?:iq|assessment)\/communication$/.test(pathname)) {
    if (view.socialAccessRequired) return { mode: 'exempt', reason: 'Social access is unavailable for this viewer; the visible access state explains how to obtain it.' };
    if (view.communicationOverview) return { mode: 'exempt', reason: 'The communication directory has no selected conversation. Selecting a channel or person opens its contextual composer.' };
  }
  if (view.channelNotJoined) return { mode: 'exempt', reason: 'Channel membership is required before the user can compose messages; join-required state is visible.' };
  if (view.sharedWorkView) return { mode: 'exempt', reason: 'The active shared-work view displays contextual work; its message composer is outside this view.' };
  if (view.placeholder) return { mode: 'exempt', reason: 'The surface is registered but not available yet; the page displays its registration state and exposes no data to search or command.' };
  if (view.settingsSurface) return { mode: 'exempt', reason: 'A configuration surface of explicit controls and a Save action, rather than a searchable collection.' };
  if (view.landing && !view.table) return { mode: 'exempt', reason: 'A section landing of summaries and links; its collections live on the pages it links to.' };
  if (view.lab) return { mode: 'exempt', reason: 'The Computer Lab workspace has its own box selector, panes and terminal input; it is not a searchable collection.' };
  if (view.graph) return { mode: 'exempt', reason: 'The spatial canvas uses its own date, focus and node controls; collection commands belong to the list pages that feed it.' };
  if (view.charts && !view.listRail) return { mode: 'exempt', reason: 'A dashboard of charts and summary strips; its tables are supporting read-outs without search or filters, so there is no collection to command.' };
  if (view.listRail) return { mode: 'required' };
  // A page whose content is a table is a collection; a record's supporting tables are not.
  if (view.table && !record) return { mode: 'required' };
  if (view.documentDirectory) return { mode: 'exempt', reason: 'The document rail has no open document; opening one shows its editor and composer. The directory itself is navigation, not a collection to command.' };
  if (view.chatDirectory) return { mode: 'exempt', reason: 'The conversation rail has no selected conversation. Selecting a channel, person, call, room or team opens its contextual composer.' };
  if (view.form) return { mode: 'exempt', reason: 'A single form with explicit inputs and a Save action, rather than a searchable collection.' };
  if (record && view.missingRecord) return { mode: 'exempt', reason: 'The record endpoint returned 404 and its unavailable state is visible; there is no record to discuss or command.' };
  if (spec.kind === 'record' && view.recordDetail) return { mode: 'exempt', reason: 'A record detail page: its discussion opens in the right pane on demand and the page itself holds no collection to command.' };
  if (REVIEWED_LANDINGS[pathname] && !view.table && !view.collection) return { mode: 'exempt', reason: REVIEWED_LANDINGS[pathname] };
  return undefined;
}
