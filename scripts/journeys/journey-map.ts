// The journey-map format (docs/journeys.md "Journey maps"). A map is data: who
// walks, what they want, the ordered steps, what each step must show, and which
// fields of the family's PROTOCOL.md the steps prove. scripts/journeys/run-maps.mjs
// walks it headlessly, measures every step with the ui-dom-audit, writes the
// family's journey log and seals the directory when every step passed.
//
// Maps live at docs/journeys/maps/<family>/<dir>/<surface>.ts and default-export
// one `JourneyMap` (`satisfies JourneyMap`); files starting with `_` are shared
// fragments, not maps. This file holds only types: maps import it with
// `import type`, which Node's type stripping and Playwright both erase.

export type Text = string | RegExp;

/** How a step finds an element: by accessible role and name first; a test id, label, text or CSS only where the role/name is not unique. */
export type Target =
  | { role: string; name?: Text; exact?: boolean; level?: number; within?: Target; nth?: number }
  | { testId: string; within?: Target; nth?: number }
  | { label: Text; exact?: boolean; within?: Target; nth?: number }
  | { placeholder: Text; within?: Target; nth?: number }
  | { text: Text; exact?: boolean; within?: Target; nth?: number }
  | { css: string; within?: Target; nth?: number };

export interface Expect {
  /** Pathname (+ search when the string has one) the page is on after the step; a RegExp is tested on pathname+search. */
  url?: Text;
  /** The page must NOT be on a matching pathname+search (a refused deep link). */
  urlNot?: RegExp;
  /** Each target has a visible match. */
  visible?: Target[];
  /** Each target has no match in the DOM at all (gated controls are absent, not hidden). */
  absent?: Target[];
  /** Each target has no visible match. */
  hidden?: Target[];
  /** Each text is visible somewhere on the page. */
  text?: Text[];
  /** No text on the page matches (document.body.innerText). */
  noText?: Text[];
  disabled?: Target[];
  enabled?: Target[];
  /** The focused element matches this target. */
  focused?: Target;
  /** Visible matches, polled until they settle (rows a write round-trips for). */
  count?: Array<{ target: Target; eq?: number; min?: number; max?: number }>;
  /** An attribute, polled until it settles; `value` on an input/select/textarea is the live value it holds, not the default attribute. */
  attr?: Array<{ target: Target; name: string; value: Text | null }>;
  /** api steps: the response status (one or any of a list). */
  status?: number | number[];
  /** tab-walk steps: at least this many distinct visible controls took focus. */
  minVisited?: number;
  /** The first data row (table body row, grid row, list item) starts at or above this many px (the density rule). */
  firstRowTopMax?: number;
  /**
   * Numbers that must agree: the first number in `of` (or `re`'s first group) equals a constant (`eq`), the
   * visible count of `eqCount` (a badge equals its rows), or the number in `eqNumberOf` (a header equals a stat).
   */
  numbers?: Array<{ of: Target; re?: RegExp; eq?: number; eqCount?: Target; eqNumberOf?: Target; reOther?: RegExp }>;
  /** Page steps check `scrollWidth <= innerWidth` unless this is false. */
  noHscroll?: boolean;
}

/** Protocol field names a step can prove (the family profile lists which a kind requires). */
export type Field = string;

interface StepBase {
  /** A named peer in this map; omitted means the primary walker. */
  actor?: string;
  /** One plain sentence: what this step does and shows. It is written into the log. */
  name: string;
  /** The UI state this step shows, for the coverage map (default, filtered-empty, not-found, dialog-open, refused, row-open, …). Navigate defaults to `default`. */
  state?: string;
  /** The PROTOCOL fields this step is evidence for. */
  proves?: Field | Field[];
  expect?: Expect;
  /** Measure with the ui-dom-audit (default: true for page steps, false for api, gateway-refusal and tab-walk). `false` needs `auditReason`. */
  audit?: boolean;
  auditReason?: string;
  /** Extra required regions for the audit (`$alias` selectors of the adapter). */
  required?: string[];
  /** Console errors this step expects (a 404 lookup, a refused API call); others fail the step. */
  expectConsole?: RegExp;
  /** This step's screenshot is the log's `screenshot:` (default: the first navigate). */
  screenshot?: 'log';
  /** This step writes business state: the map must run under a mock scope or clone (lane M). */
  writes?: boolean;
  /**
   * Tab stability: each target's bounding box is read before the action and after it settles, and must not
   * move or resize (±1px) — the header, the tab strip and the panes stay put when a tab is clicked.
   */
  stable?: Target[];
  /** Judge the step without waiting for the page to settle (a `loading` scope's skeleton is only there while it loads). */
  noSettle?: boolean;
}

export type Step = StepBase & (
  | { do: 'navigate'; url: string }
  | { do: 'click'; target: Target }
  | { do: 'press'; key: string; target?: Target }
  /** Type into a UI-local control (a search box, the palette, a filter, the command composer). In a read-only map every non-GET request it triggers is blocked and fails the step. */
  | { do: 'fill'; target: Target; value: string }
  /** Choose a value in a native select through its UI control. */
  | { do: 'select'; target: Target; value: string }
  | { do: 'back' }
  | { do: 'wait'; target: Target }
  /** Tab through the page from the top (the skill's focusWalk probe); proves keyboard reach. */
  | { do: 'tab-walk'; max?: number }
  /** Read-only forged chat/history/presence requests: all must be denied, with no channel data returned. */
  | { do: 'gateway-refusal'; channel: string }
  /** Send a bounded proof message to another fresh clone; requires the clone-dm realtime scenario. */
  | { do: 'gateway-send-dm'; recipient: string; message: string }
  /** Reload the page (a write read back after reload). */
  | { do: 'reload' }
  /** Resize the viewport mid-walk (the 1440/900 frames). */
  | { do: 'viewport'; width: number; height: number }
  /** Switch the colour theme the way Settings stores it (localStorage `theme` + html[data-theme]). */
  | { do: 'theme'; value: 'light' | 'dark' }
  /**
   * Move this context into a fresh request-scoped mock world (`withMockScope`): `empty`, `error`, `long-text`,
   * `many`, `loading`, or per fixture. With `url`, navigate there in the new world (the step is then a page step).
   */
  | { do: 'scope'; scope: ScopeRequest; url?: string }
  /**
   * An API call on the walker's session. A non-GET call in a read-only map must
   * be a refusal probe: `refusal` says why it cannot write even if the gate were
   * open (e.g. an invalid body the route rejects), and `expect.status` is 4xx.
   */
  | { do: 'api'; url: string; method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; body?: unknown; refusal?: string }
);

export interface Persona {
  /** Seed user id (u-rhea) — or the persona a clone is minted from once lane M's openAsClone lands. */
  user: string;
  /** Display name for the log's `user:` line. */
  name?: string;
  /** The tenant and role the walk is in; the runner asserts them on /api/session/me. */
  tenant: string;
  role: string;
  /** Switch into tenant/role after sign-in (an epoch bump — avoid unless the role is not the user's landing). */
  switchTenant?: boolean;
  switchRole?: boolean;
  /**
   * A PEER's identity (default `clone`). `persona` signs the peer in as the seed user itself (a plain login, no
   * switch): presence a clone cannot show — the portal draws presence only for ids in the people directory,
   * which holds no clone (EmbeddedSocial.tsx `validIds`). Needs the map's `identityReason`; such a map walks only
   * with --allow-persona, like a persona map.
   */
  identity?: 'clone' | 'persona';
  /** A presence-only peer may never write, even when the primary clone has a scoped write journey. */
  readOnly?: boolean;
}

/** A request-scoped mock world (lane M, `withMockScope`): a scenario for every fixture, or per fixture. Copy-on-write: writes stay in the scope. */
export type ScopeRequest = string | { scenario?: string; fixture?: string; fixtures?: Record<string, string> };

export interface JourneyMap {
  /** A console error every step of this map expects (one deliberate refusal the page shows), narrower than any step's own. */
  expectConsole?: RegExp;
  /** The family: docs/<family>-journeys holds its logs and PROTOCOL.md. */
  family: string;
  /** The log this map writes, relative to the family directory, without .md (requester/catalog). */
  log: string;
  /** The family profile's log kind (surface, isolation-inbound, isolation-outbound). */
  kind: string;
  persona: Persona;
  /** Additional clone identities kept open while the ordered steps switch between actors. */
  peers?: Record<string, Persona>;
  /** Signalling-only media for meeting UI walks; the separate E2 acceptance proves real media. */
  media?: 'meeting-fixture';
  /** What the persona is trying to do on this surface. */
  goal: string;
  /**
   * The data state the walk runs under. `shared` = the shared dev:mock as it
   * is, read-only (every non-GET the page sends is blocked). `{ scope }` = a
   * request-scoped mock scenario (lane M's withMockScope). `{ realtime: meeting }`
   * uses cloned peers on the gateway, with HTTP business writes blocked.
   * `clone-dm` posts only to a channel derived from two fresh clone ids; only
   * their receipts on that exact channel may write over HTTP.
   */
  scenario: 'shared' | { scope: ScopeRequest } | { realtime: 'meeting' | 'clone-dm' };
  /**
   * Who signs in. `clone` (the default once lane M's clones exist): a fresh
   * clone of the persona — same grants and person link, its own id and session
   * epoch — so the walk can run beside an audit or another walk. `persona`: the
   * seed user itself, needed when the surface shows records keyed by user id
   * (my requests, my inbox), which a clone does not own; such a map waits while
   * a ui-dom-audit run holds the seed identities.
   *
   * `demo`: the cookie-less demo identity (persona.user `demo-user`), no sign-in at all — the isolation logs'
   * demo row. It cannot be cloned or switched, so such a map is read-only and lands where demo-user lands.
   */
  identity?: 'clone' | 'persona' | 'demo';
  /** Why the map needs the seed persona (required with identity: 'persona'). */
  identityReason?: string;
  /** True when any step writes; requires a scoped or cloned meeting scenario. */
  writes?: boolean;
  /**
   * Non-GET requests a read-only walk lets through because the route writes
   * nothing (a preview computed by POST). Each needs its reason, citing the route.
   */
  readOnlyPosts?: Array<{ path: string; reason: string }>;
  /** Do not walk this map yet, and why (e.g. a write that would reach state no scope covers). The runner skips it; coverage lists it as pending. */
  hold?: string;
  viewport?: { width: number; height: number };
  /** Static log fields the walk does not measure: the surface name, the source files (`pages:`). */
  fields?: Record<string, string>;
  /** The value each claim field states when every step proving it passes (default `pass`); the proving steps' sentences follow it. */
  claims?: Record<Field, string>;
  steps: Step[];
}
