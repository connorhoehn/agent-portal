// Journey maps — the pure half of the runner (docs/journeys.md "Journey maps").
// Loading and validating maps, composing a family's journey log from a walk's
// result, and the route × role × state coverage map. No browser here: the
// walk is scripts/journeys/walk.mjs, the CLI scripts/journeys/run-maps.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const MAPS_DIR = path.join(ROOT, 'docs/journeys/maps');

/** Words that stop a log counting (every family's PROTOCOL): a map must never put them in a log. */
export const BANNED = /\b(TODO|unverified|placeholder)\b/i;

// ── Profiles: each family's log kinds, as its PROTOCOL.md writes them ───────
//
// A kind is the ordered list of the log's fields. Built-in fields are filled by
// the runner (BUILTIN); every other field is a CLAIM the map must prove with at
// least one step (`proves`), stated as the map's `claims[field]` (default `pass`)
// followed by the proving steps' sentences — or `fail — …` when one failed.
const SURFACE = ['surface', 'role', 'user', 'url', 'map', 'pages', 'audited', 'session', 'screenshot', 'verdict', 'console errors', 'layout', 'keyboard', 'empty-state', 'role-gating', 'dom-audit', 'notes'];
export const PROFILES = {
  access: {
    surface: SURFACE,
    'isolation-inbound': ['role', 'user', 'url', 'map', 'pages', 'audited', 'session', 'access-tile-visible', 'access-nav-visible', 'direct-route-result', 'api-status', 'write-status', 'nothing-written', 'console errors', 'dom-audit', 'screenshot', 'verdict', 'notes'],
    'isolation-outbound': ['role', 'user', 'url', 'map', 'pages', 'audited', 'session', 'other-nav-visible', 'iq-route-result', 'iq-api-status', 'assessment-route-result', 'assessment-api-status', 'social-route-result', 'social-api-status', 'pipelines-route-result', 'pipelines-api-status', 'console errors', 'dom-audit', 'screenshot', 'verdict', 'notes'],
  },
  // docs/assessment-journeys/PROTOCOL.md and scripts/validate-assessment-tenant.sh: a role × surface log carries
  // keyboard, empty-state and role-gating; an inbound isolation log (an orgiq role meeting the assessment tenant)
  // the tile / nav / direct-route / API fields; an outbound one (an assessment role meeting orgiq) the orgiq ones.
  assessment: {
    surface: SURFACE,
    'isolation-inbound': ['role', 'user', 'url', 'map', 'pages', 'audited', 'session', 'assessment-tile-visible', 'assessment-nav-visible', 'direct-route-result', 'api-status', 'console errors', 'dom-audit', 'screenshot', 'verdict', 'notes'],
    'isolation-outbound': ['role', 'user', 'url', 'map', 'pages', 'audited', 'session', 'orgiq-nav-visible', 'orgiq-route-result', 'orgiq-api-status', 'console errors', 'dom-audit', 'screenshot', 'verdict', 'notes'],
  },
  pipelines: {
    surface: SURFACE,
    'isolation-inbound': ['role', 'user', 'url', 'map', 'pages', 'audited', 'session', 'pipelines-tile-visible', 'pipelines-nav-visible', 'direct-route-result', 'api-status', 'events-status', 'console errors', 'dom-audit', 'screenshot', 'verdict', 'notes'],
    'isolation-outbound': ['role', 'user', 'url', 'map', 'pages', 'audited', 'session', 'other-nav-visible', 'iq-route-result', 'iq-api-status', 'assessment-route-result', 'assessment-api-status', 'social-route-result', 'social-api-status', 'console errors', 'dom-audit', 'screenshot', 'verdict', 'notes'],
    // PROTOCOL "Plus one cross-tenant slice log": slice/bot-detail.md, an orgiq page rendering the bot's firing as
    // Run → Steps → Artifact → Events; validate-pipelines-tenant.sh reads its four extra fields.
    slice: ['surface', 'role', 'user', 'url', 'map', 'pages', 'audited', 'session', 'screenshot', 'run-rendered', 'steps-rendered', 'artifact-rendered', 'events-streamed', 'verdict', 'console errors', 'layout', 'keyboard', 'empty-state', 'role-gating', 'dom-audit', 'notes'],
  },
  // docs/social-journeys/PROTOCOL.md and scripts/validate-social-tenant.sh: a role × surface log adds `realtime`
  // (pass, or n/a for a surface with nothing live) to keyboard / empty-state / role-gating; an inbound isolation
  // log (another tenant's role reaching for Social) the grant / tile / nav / route / API / bell fields; an
  // outbound one (a social role reaching for orgiq and assessment) the six orgiq-* and assessment-* fields.
  social: {
    surface: ['surface', 'role', 'user', 'url', 'map', 'pages', 'audited', 'session', 'screenshot', 'verdict', 'console errors', 'layout', 'keyboard', 'empty-state', 'realtime', 'role-gating', 'dom-audit', 'notes'],
    'isolation-inbound': ['role', 'user', 'url', 'map', 'pages', 'audited', 'session', 'social-grant', 'social-tile-visible', 'social-nav-visible', 'direct-route-result', 'api-status', 'activity-leak', 'forged-subscribe', 'console errors', 'dom-audit', 'screenshot', 'verdict', 'notes'],
    'isolation-outbound': ['role', 'user', 'url', 'map', 'pages', 'audited', 'session', 'orgiq-nav-visible', 'orgiq-route-result', 'orgiq-api-status', 'assessment-nav-visible', 'assessment-route-result', 'assessment-api-status', 'console errors', 'dom-audit', 'screenshot', 'verdict', 'notes'],
  },
  // docs/demo-journeys/PROTOCOL.md (docs/demo-content-goal.md): one story per tenant a peer follows in five
  // minutes; each step asserts a fact of the story is on screen (story-facts) and that the records it names
  // lead to each other (cross-links).
  demo: { story: ['surface', 'role', 'user', 'url', 'map', 'pages', 'audited', 'session', 'screenshot', 'verdict', 'console errors', 'layout', 'story-facts', 'cross-links', 'dom-audit', 'notes'] },
  // docs/runbooks-journeys/PROTOCOL.md (docs/distillation-runbooks-goal.md R6): one map per step of the runbook
  // loop for a role (author, reviewer, consumer) and one API map for the box. A `journey` log states what the
  // page or route shows (`shows`) and what the role may or may not do there (`gating`).
  runbooks: { journey: ['surface', 'role', 'user', 'url', 'map', 'pages', 'audited', 'session', 'screenshot', 'verdict', 'console errors', 'layout', 'shows', 'gating', 'dom-audit', 'notes'] },
  // docs/user-search-journeys/PROTOCOL.md (docs/user-search-goal.md judge 5): one map per top intent per tenant;
  // the person asks the catalog's question where they would, the answer is on screen (answers-question) and
  // the record it names opens in at most two clicks (record-open).
  'user-search': { intent: ['surface', 'role', 'user', 'url', 'map', 'pages', 'audited', 'session', 'screenshot', 'verdict', 'console errors', 'layout', 'answers-question', 'record-open', 'dom-audit', 'notes'] },
  // docs/work-journeys/PROTOCOL.md (docs/work-journeys-goal.md): the Work tenant (orgiq) walked per role. A
  // `surface` log carries the orgiq-audit fields (keyboard, empty-state, role-gating — validate-orgiq-audit.sh
  // reads them) plus `story-facts` (names instead of ids, numbers that agree) and `tab-stability` (every tab
  // clicked, the header and panes did not move). A `refusals` log is the role's rail and palette and every
  // route and API it must not reach (the old RAIL.md fields). A `frames` log is the role's core pages at 1440
  // and 900, light and dark.
  work: {
    surface: ['surface', 'role', 'user', 'url', 'map', 'pages', 'audited', 'session', 'screenshot', 'verdict', 'console errors', 'layout', 'keyboard', 'empty-state', 'role-gating', 'story-facts', 'tab-stability', 'dom-audit', 'notes'],
    refusals: ['surface', 'role', 'user', 'url', 'map', 'pages', 'audited', 'session', 'screenshot', 'verdict', 'console errors', 'layout', 'rail-items', 'hidden-surfaces-direct-route', 'palette-entries', 'quick-switch', 'api-refused', 'dom-audit', 'notes'],
    frames: ['surface', 'role', 'user', 'url', 'map', 'pages', 'audited', 'session', 'screenshot', 'verdict', 'console errors', 'layout', 'widths', 'themes', 'story-facts', 'dom-audit', 'notes'],
  },
};
export const BUILTIN = new Set(['surface', 'role', 'user', 'url', 'map', 'pages', 'audited', 'session', 'screenshot', 'verdict', 'console errors', 'layout', 'dom-audit', 'notes']);
/** Built-ins a map supplies itself (static facts the walk does not measure). */
const STATIC = new Set(['surface', 'pages']);

export const familyDir = (family) => `docs/${family}-journeys`;
export const claimFields = (family, kind) => (PROFILES[family]?.[kind] ?? []).filter((f) => !BUILTIN.has(f));
const asList = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const textOf = (t) => (t instanceof RegExp ? `/${t.source}/` : String(t));

/** Every string a map would write into a log (for the banned-word check). */
function mapStrings(map) {
  const out = [map.goal, map.identityReason, map.hold, ...(map.readOnlyPosts ?? []).map((r) => r.reason), ...Object.values(map.fields ?? {}), ...Object.values(map.claims ?? {})];
  for (const s of map.steps ?? []) out.push(s.name, s.auditReason ?? '', s.refusal ?? '');
  return out.filter(Boolean);
}

/** Problems with a map, as sentences; [] when it may be walked. */
export function validateMap(map, file = '(map)') {
  const p = [];
  const at = (m) => p.push(`${file}: ${m}`);
  if (!map || typeof map !== 'object') return [`${file}: does not default-export a map`];
  if (!PROFILES[map.family]) at(`unknown family ${map.family} (known: ${Object.keys(PROFILES).join(', ')})`);
  else if (!PROFILES[map.family][map.kind]) at(`family ${map.family} has no log kind ${map.kind} (known: ${Object.keys(PROFILES[map.family]).join(', ')})`);
  if (!/^[\w-]+\/[\w-]+$/.test(map.log ?? '')) at(`log must be <dir>/<name> (got ${map.log})`);
  if (!map.persona?.user || !map.persona?.tenant || !map.persona?.role) at('persona needs user, tenant and role');
  if (!map.goal) at('goal is required');
  if (map.scenario !== 'shared' && !['meeting', 'clone-dm'].includes(map.scenario?.realtime) && !(map.scenario && map.scenario.scope && ['string', 'object'].includes(typeof map.scenario.scope))) at("scenario is 'shared', { scope }, or { realtime: 'meeting' | 'clone-dm' }");
  if (map.identity && !['clone', 'persona', 'demo'].includes(map.identity)) at("identity is 'clone', 'persona' or 'demo'");
  // The cookie-less demo identity: no sign-in at all, so it can be neither switched nor cloned, and it never writes.
  if (map.identity === 'demo' && (map.persona?.user !== 'demo-user' || map.persona?.switchTenant || map.persona?.switchRole || map.writes || map.peers)) at("identity: 'demo' walks the cookie-less demo-user as it lands (persona.user demo-user, no switch, no writes, no peers)");
  if (map.identity === 'persona' && !map.identityReason) at("identity: 'persona' needs an identityReason (why a clone cannot walk it)");
  if (map.scenario?.realtime === 'meeting' && (map.identity !== 'clone' || !Object.keys(map.peers ?? {}).length || map.media !== 'meeting-fixture' || !map.writes)) at('meeting scenarios require clone peers, writes and the meeting media fixture');
  if (map.scenario?.realtime === 'clone-dm' && (map.family !== 'social' || map.identity !== 'clone' || map.persona?.tenant !== 'social' || map.media || map.readOnlyPosts?.length || !map.writes || !Object.keys(map.peers ?? {}).length || Object.values(map.peers ?? {}).some(p => p.identity === 'persona' || p.readOnly || p.tenant !== 'social'))) at('clone-dm scenarios require writable Social clones for every actor');
  if (map.media && map.media !== 'meeting-fixture') at('unknown media fixture');
  // Peers are clones. A peer that only looks (presence: a second identity opening a page) may walk the shared mock
  // read-only — every actor's non-GET is blocked like the walker's; a peer walk that writes needs a scope.
  if (map.peers && (map.identity === 'persona' || map.identity === 'demo' || (map.writes && map.scenario === 'shared'))) at('peer walks require clone identities, and a scoped scenario when they write');
  for (const [name, persona] of Object.entries(map.peers ?? {})) {
    if (!/^[a-z][a-z0-9-]*$/.test(name) || name === 'main') at('peer names must be lowercase identifiers other than main');
    if (!persona?.user || !persona?.tenant || !persona?.role) at(`peer ${name} needs user, tenant and role`);
    if (persona?.identity && !['clone', 'persona'].includes(persona.identity)) at(`peer ${name}: identity is 'clone' or 'persona'`);
    if (persona?.identity === 'persona' && (!map.identityReason || (map.writes && persona.readOnly !== true))) at(`peer ${name} signs in as the seed persona: the map needs an identityReason and the peer must not write (readOnly: true on a scoped write journey)`);
    if (persona?.readOnly !== undefined && typeof persona.readOnly !== 'boolean') at(`peer ${name}: readOnly must be boolean`);
  }
  const steps = map.steps ?? [];
  if (!steps.length) at('no steps');
  else if (steps[0].do !== 'navigate') at('the first step must navigate');
  const writes = steps.filter((s) => s.writes);
  if (writes.length && !map.writes) at(`step(s) ${writes.map((s) => steps.indexOf(s) + 1).join(', ')} write but the map does not declare writes: true`);
  if (map.writes && map.scenario === 'shared') at('a map that writes must run under a scoped scenario ({ scope }), never the shared mock');
  for (const r of map.readOnlyPosts ?? []) if (!/^\/api\//.test(r.path ?? '') || !r.reason) at('readOnlyPosts entries need an /api/ path and a reason');
  if (steps.filter((s) => s.screenshot === 'log').length > 1) at('only one step may be the log screenshot');
  const kindFields = new Set(PROFILES[map.family]?.[map.kind] ?? []);
  const proven = new Set();
  steps.forEach((s, i) => {
    const n = `step ${i + 1}`;
    if (!s.name) at(`${n} has no name`);
    if (s.actor && !Object.hasOwn(map.peers ?? {}, s.actor)) at(`${n}: unknown peer ${s.actor}`);
    if (s.actor && map.peers?.[s.actor]?.readOnly && s.writes) at(`${n}: a readOnly peer cannot write`);
    if (!['navigate', 'click', 'press', 'fill', 'select', 'back', 'wait', 'tab-walk', 'api', 'gateway-refusal', 'gateway-send-dm', 'reload', 'viewport', 'theme', 'scope'].includes(s.do)) at(`${n}: unknown action ${s.do}`);
    if (s.do === 'viewport' && !(s.width > 0 && s.height > 0)) at(`${n}: viewport needs width and height`);
    if (s.do === 'theme' && !['light', 'dark'].includes(s.value)) at(`${n}: theme is light or dark`);
    if (s.do === 'scope' && !(typeof s.scope === 'string' || (s.scope && typeof s.scope === 'object'))) at(`${n}: scope needs a scope request (a scenario name or { scenario, fixture, fixtures })`);
    if (s.do === 'scope' && s.url != null && !/^\//.test(s.url)) at(`${n}: scope's url must be a same-origin path`);
    if (s.stable != null && !(Array.isArray(s.stable) && s.stable.length)) at(`${n}: stable lists the targets whose boxes must not move`);
    if (s.do === 'navigate' && !/^\//.test(s.url ?? '')) at(`${n}: navigate needs a same-origin path`);
    if (['click', 'fill', 'select', 'wait'].includes(s.do) && !s.target) at(`${n}: ${s.do} needs a target`);
    if (['fill', 'select'].includes(s.do) && typeof s.value !== 'string') at(`${n}: ${s.do} needs a value`);
    if (s.do === 'press' && !s.key) at(`${n}: press needs a key`);
    if (s.audit === false && !s.auditReason) at(`${n}: audit: false needs an auditReason`);
    if (s.do === 'gateway-refusal' && !/^[a-z][a-z0-9-]*:[^\s]+$/.test(s.channel ?? '')) at(`${n}: gateway-refusal needs a channel`);
    if (s.do === 'gateway-send-dm' && (map.scenario?.realtime !== 'clone-dm' || !s.writes || !s.actor || s.recipient === s.actor || !(s.recipient === 'main' || Object.hasOwn(map.peers ?? {}, s.recipient)) || typeof s.message !== 'string' || !s.message.trim() || s.message.length > 200)) at(`${n}: gateway-send-dm requires the clone-dm scenario, writes, a sending peer, another actor and a message of 1–200 characters`);
    if (s.do === 'api') {
      const method = s.method ?? 'GET';
      if (!/^\/api\//.test(s.url ?? '')) at(`${n}: api needs an /api/ path`);
      if (method !== 'GET' && !s.writes) {
        const st = asList(s.expect?.status);
        if (!s.refusal) at(`${n}: a non-GET call in a read-only map is a refusal probe and must say why it cannot write (refusal)`);
        if (!st.length || st.some((x) => x < 400 || x > 499)) at(`${n}: a refusal probe must expect a 4xx status`);
      }
    }
    for (const f of asList(s.proves)) {
      if (!kindFields.has(f)) at(`${n} proves ${f}, which ${map.kind} logs do not carry`);
      else if (BUILTIN.has(f)) at(`${n} proves ${f}, which the runner fills itself`);
      proven.add(f);
    }
  });
  for (const f of claimFields(map.family, map.kind)) if (!proven.has(f)) at(`no step proves ${f}`);
  for (const f of Object.keys(map.claims ?? {})) if (!kindFields.has(f) || BUILTIN.has(f)) at(`claims.${f} is not a claim field of ${map.kind}`);
  for (const f of Object.keys(map.fields ?? {})) if (!STATIC.has(f)) at(`fields.${f}: only ${[...STATIC].join(', ')} are static`);
  for (const s of mapStrings(map)) if (BANNED.test(s)) at(`would write a banned word into the log: "${s.slice(0, 60)}"`);
  return p;
}

/** Map files under docs/journeys/maps[/<family>] (shared fragments start with `_`). */
export function mapFiles(family) {
  const base = family ? path.join(MAPS_DIR, family) : MAPS_DIR;
  if (!fs.existsSync(base)) return [];
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : /\.(ts|mjs)$/.test(e.name) && !e.name.startsWith('_') ? [path.join(d, e.name)] : []);
  return walk(base).sort();
}

/** Import and validate maps. Returns { maps: [{ file, map }], problems }. */
export async function loadMaps(files) {
  const maps = []; const problems = [];
  for (const file of files) {
    let map;
    try { map = (await import(pathToFileURL(path.resolve(file)).href)).default; } catch (e) { problems.push(`${rel(file)}: ${e.message.split('\n')[0]}`); continue; }
    const p = validateMap(map, rel(file));
    if (p.length) problems.push(...p); else maps.push({ file: rel(file), map });
  }
  const seen = new Map();
  for (const { file, map } of maps) {
    const key = `${map.family}/${map.log}`;
    if (seen.has(key)) problems.push(`${file}: writes the same log as ${seen.get(key)}`); else seen.set(key, file);
  }
  return { maps, problems };
}
export const rel = (p) => path.relative(ROOT, path.resolve(ROOT, p));

// ── The log ────────────────────────────────────────────────────────────────

const failureOf = (s) => s.failures?.[0] ?? (s.unexpectedConsole?.length ? `console error: ${s.unexpectedConsole[0]}` : s.audit?.findings ? `${s.audit.findings} DOM-audit finding(s): ${Object.keys(s.audit.rules ?? {}).join(', ')}` : s.status);
/** The sentence a step contributes to a field: its name plus what it observed. */
export function stepSentence(s) {
  const extra = [];
  if (s.dm) extra.push(`${s.dm.channel}: gateway acknowledged message ${s.dm.messageId} from ${s.dm.sender}`);
  if (s.gateway) extra.push(`${s.gateway.channel}: ${s.gateway.denied.map(d => d === 'chat/not-a-member' ? 'chat join: not-a-member' : `${d}: AUTHZ_CHANNEL_DENIED`).join(', ')}; ${s.gateway.leaked} disclosed frames`);
  if (s.api) extra.push(`${s.api.method} ${s.api.url} → ${s.api.status}`);
  if (s.keyboard) extra.push(`Tab visited ${s.keyboard.visited} distinct visible controls of ${s.keyboard.total} focusable${s.keyboard.lost ? `, focus lost ${s.keyboard.lost}×` : ''}${s.keyboard.invisible ? `, ${s.keyboard.invisible} invisible stop(s)` : ''}`);
  if (s.do === 'navigate' && s.landed && s.landed !== s.url) extra.push(`${s.url} → ${s.landed}`);
  if (s.viewport) extra.push(`viewport ${s.viewport.width}x${s.viewport.height}`);
  if (s.theme) extra.push(`theme ${s.theme}`);
  if (s.scope) extra.push(`mock scope ${s.scope}`);
  if (s.stable) extra.push(`${s.stable.length} box(es) held still`);
  return `${s.name.replace(/[.\s]+$/, '')}${extra.length ? ` (${extra.join('; ')})` : ''}`;
}

/** A layout line: the audit's verdict over every audited step, then the facts at the log's screenshot step. */
export function layoutLine(result) {
  const audited = result.steps.filter((s) => s.audit);
  const findings = audited.reduce((n, s) => n + s.audit.findings, 0);
  const rules = {};
  for (const s of audited) for (const [r, c] of Object.entries(s.audit.rules ?? {})) rules[r] = (rules[r] ?? 0) + c;
  const shot = result.steps.find((s) => s.index === result.screenshotStep) ?? result.steps[0];
  const f = shot?.facts;
  const facts = f ? [
    `${f.scrollWidth <= f.innerWidth ? 'no horizontal scroll' : 'HORIZONTAL SCROLL'} (${f.scrollWidth}/${f.innerWidth})`,
    f.h1 ? `${f.h1Count} h1 "${f.h1.text}" ${f.h1.size}/${f.h1.weight} at ${f.h1.left}/${f.h1.top}` : `${f.h1Count} h1`,
    f.trail ? `trail at ${f.trail.left}/${f.trail.top}` : null,
    f.rows ? `table body rows ${f.rows.heights.join('/')}px ×${f.rows.count}` : null,
    f.firstRowTop != null ? `first-row-top: ${f.firstRowTop}px` : null,
    f.composer ? `composer at y ${f.composer.top}–${f.composer.bottom} of ${f.innerHeight}` : null,
  ].filter(Boolean).join(', ') : '';
  const hscroll = result.steps.filter((s) => s.facts && s.facts.scrollWidth > s.facts.innerWidth);
  const ok = findings === 0 && !hscroll.length && audited.length > 0;
  const head = !audited.length ? 'fail — no step was measured'
    : ok ? `pass — ui-dom-audit 0 failing findings at ${audited.length} measured step(s)${audited.some((s) => s.audit.recorded) ? ' (burn-down findings are listed under dom-audit:)' : ''}`
      : `fail — ${findings} ui-dom-audit finding(s) at ${audited.filter((s) => s.audit.findings).length} of ${audited.length} measured step(s) (${Object.entries(rules).map(([r, c]) => `${r} ×${c}`).join(', ')})${hscroll.length ? `; horizontal scroll at step(s) ${hscroll.map((s) => s.index).join(', ')}` : ''}`;
  return { ok, text: facts ? `${head}; at ${shot.landed ?? shot.url}: ${facts}` : head };
}

/** Findings the audit burn-down (docs/journeys/audit-burndown.tsv) owns: shown in every log, never hidden. */
function recordedLine(audited) {
  const rules = {};
  for (const s of audited) for (const [r, c] of Object.entries(s.audit.recordedRules ?? {})) rules[r] = (rules[r] ?? 0) + c;
  const n = Object.values(rules).reduce((a, b) => a + b, 0);
  return n ? `; ${n} more owed by docs/journeys/audit-burndown.tsv (${Object.entries(rules).map(([r, c]) => `${r} ×${c}`).join(', ')})` : '';
}
const hhmm = (iso) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const day = (iso) => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/**
 * Compose the journey log for one walk. `result` is what walk.mjs returns
 * (with the map's static parts copied in). Returns { text, verdict }.
 */
export function composeLog(result) {
  const map = result.map;
  const fields = PROFILES[map.family][map.kind];
  const steps = result.steps;
  const failed = steps.filter((s) => s.status !== 'pass');
  const layout = layoutLine(result);
  const unexpected = steps.flatMap((s) => s.unexpectedConsole ?? []);
  const expected = steps.flatMap((s) => s.expectedConsole ?? []);
  const verdictPass = !failed.length && !unexpected.length && layout.ok && !result.error;
  const verdict = verdictPass ? 'pass'
    : `fail — ${result.error ? result.error : failed.length ? `${failed.length} of ${steps.length} steps failed; step ${failed[0].index} (${failed[0].name.replace(/[.\s]+$/, '')}): ${failureOf(failed[0])}` : !layout.ok ? 'the DOM audit found layout defects (layout:)' : 'unexpected console errors'}`;
  const urls = [...new Set(steps.flatMap((s) => [s.do === 'navigate' ? s.url : null, s.landed]).filter((u) => u && /^\/(iq|assessment|social|pipelines|access|admin|settings)(\/|\?|$)/.test(u)))];
  const audited = steps.filter((s) => s.audit);
  const auditFindings = audited.reduce((n, s) => n + s.audit.findings, 0);
  const v = {
    surface: map.fields?.surface,
    role: map.persona.role,
    user: `${map.persona.user}${map.persona.name ? ` (${map.persona.name})` : ''}`,
    url: urls.join('; '),
    map: result.mapFile,
    pages: map.fields?.pages,
    audited: `${day(result.startedAt)} ${hhmm(result.startedAt)}–${hhmm(result.endedAt)} local, Chromium ${result.browser ?? ''} ${result.viewport.width}x${result.viewport.height} (scripts/journeys/run-maps.mjs: Playwright headless, ${map.identity === 'demo' ? 'a fresh context as the cookie-less demo identity, no sign-in' : `a fresh context signed in through portal/e2e/realSession.ts${result.clone ? ` as clone ${result.clone}` : ''}`}), ${result.scenario}, ${result.stack ?? ''}`.replace(/\s+,/g, ','),
    session: result.session ? `/api/session/me sub ${result.session.sub}, tenant ${result.session.tenant}, role ${result.session.role}, grants ${JSON.stringify(result.session.grants ?? {})}` : 'not read',
    screenshot: result.screenshot ?? '(none)',
    verdict,
    'console errors': `${unexpected.length}${unexpected.length ? ` — ${unexpected.slice(0, 2).join(' | ').slice(0, 200)}` : ''}${expected.length ? ` unexpected; ${expected.length} expected by the map (${[...new Set(expected.map((e) => e.replace(/\s+/g, ' ').slice(0, 80)))].slice(0, 2).join(' | ')})` : ''}`,
    layout: layout.text,
    'dom-audit': `${auditFindings} failing finding(s) at ${audited.length} measured step(s)${recordedLine(audited)} — ui-dom-audit measureDOM, contract ${result.contract ?? '?'}${steps.some((s) => s.audit?.unclassified) ? `; composer policy unclassified at step(s) ${steps.filter((s) => s.audit?.unclassified).map((s) => s.index).join(', ')}` : ''}`,
    notes: `${map.goal.replace(/[.\s]+$/, '')}.${result.retried ? ` ${result.retried}.` : ''} Generated by the runner from the map; every field above was observed in this run (steps below; per-step screenshots in ${result.outDir ?? 'the run directory'}).${result.blockedWrites?.length ? ` Writes the page attempted and the read-only walk blocked: ${[...new Set(result.blockedWrites)].join(', ')}.` : ''}`,
  };
  for (const f of fields) {
    if (BUILTIN.has(f)) continue;
    const provers = steps.filter((s) => asList(s.proves).includes(f));
    const bad = provers.filter((s) => s.status !== 'pass');
    v[f] = bad.length
      ? `fail — ${bad.map((s) => `step ${s.index} (${s.name.replace(/[.\s]+$/, '')}): ${failureOf(s)}`).join('; ')}`
      : `${map.claims?.[f] ?? 'pass'} — ${provers.map(stepSentence).join('; ')}`;
  }
  const lines = fields.filter((f) => v[f] != null && v[f] !== '').map((f) => `${f}: ${String(v[f]).replace(/\s*\n\s*/g, ' ')}`);
  const table = ['', '## Steps', '', '| # | step | state | result | audit | evidence |', '|---|---|---|---|---|---|',
    ...steps.map((s) => `| ${s.index} | ${stepSentence(s).replace(/\|/g, '\\|')} | ${s.state ?? ''} | ${s.status === 'pass' ? 'pass' : `fail: ${String(failureOf(s)).replace(/\|/g, '\\|').slice(0, 160)}`} | ${s.audit ? `${s.audit.findings} finding(s)` : s.auditReason ? `not measured: ${s.auditReason}` : '—'} | ${s.landed ?? s.url ?? ''} |`)];
  return { text: `${lines.join('\n')}\n${table.join('\n')}\n`, verdict: verdictPass ? 'pass' : 'fail' };
}

// ── Coverage ───────────────────────────────────────────────────────────────

/** States a route of each kind should be shown in, for the "states never shown" gap list. */
export const EXPECTED_STATES = {
  list: ['default', 'filtered-empty', 'row-open'],
  record: ['default', 'not-found'],
  landing: ['default'],
  editor: ['default'],
  chat: ['default'],
  page: ['default'],
};

/** Where each UI step stands, statically: its expected url, else the last navigate's. */
export function stepRoutes(map, routeKey) {
  let at = null; const out = [];
  for (const s of map.steps) {
    if (s.do === 'navigate' || (s.do === 'scope' && s.url)) at = s.url;
    if (typeof s.expect?.url === 'string') at = s.expect.url;
    if (s.do === 'api' || s.do === 'gateway-refusal' || s.do === 'gateway-send-dm' || s.do === 'tab-walk' || (s.do === 'scope' && !s.url)) continue;
    const key = at ? routeKey(at) : null;
    if (!key) continue;
    const refused = s.expect?.urlNot && s.expect.urlNot.test(at);
    const state = refused ? 'refused' : s.state ?? (s.do === 'navigate' || s.do === 'scope' ? 'default' : null);
    if (state) out.push({ key, state });
  }
  return out;
}

/**
 * The coverage model: route × role × state over every map, and the gaps.
 * `inventory` is [{ key, tenant, kind }], `rolesByTenant` { tenant: [roles] }.
 */
export function coverageModel(maps, { inventory, rolesByTenant, routeKey }) {
  const cells = new Map(); // key -> Map(role -> Set(state))
  const walkedRoles = new Map(); // tenant -> Set(role)
  for (const { map } of maps) {
    const role = `${map.persona.tenant}:${map.persona.role}`;
    if (!walkedRoles.has(map.persona.tenant)) walkedRoles.set(map.persona.tenant, new Set());
    walkedRoles.get(map.persona.tenant).add(map.persona.role);
    for (const { key, state } of stepRoutes(map, routeKey)) {
      if (!cells.has(key)) cells.set(key, new Map());
      const byRole = cells.get(key);
      if (!byRole.has(role)) byRole.set(role, new Set());
      byRole.get(role).add(state);
    }
  }
  const known = new Map(inventory.map((r) => [r.key, r]));
  const unvisited = inventory.filter((r) => !cells.has(r.key));
  const rolesNever = Object.entries(rolesByTenant).map(([t, roles]) => ({ tenant: t, roles: roles.filter((r) => !walkedRoles.get(t)?.has(r)) })).filter((x) => x.roles.length);
  const statesNever = [];
  for (const [key, byRole] of cells) {
    const kind = known.get(key)?.kind ?? 'page';
    const shown = new Set([...byRole.values()].flatMap((s) => [...s]));
    const missing = (EXPECTED_STATES[kind] ?? ['default']).filter((s) => !shown.has(s));
    if (missing.length) statesNever.push({ key, kind, missing });
  }
  const states = new Set([...cells.values()].flatMap((m) => [...m.values()].flatMap((s) => [...s])));
  return {
    cells, unvisited, rolesNever, statesNever,
    totals: {
      maps: maps.length, routes: inventory.length, visited: inventory.length - unvisited.length,
      offInventory: [...cells.keys()].filter((k) => !known.has(k)).length,
      roleCells: [...cells.values()].reduce((n, m) => n + m.size, 0),
      stateCells: [...cells.values()].reduce((n, m) => n + [...m.values()].reduce((k, s) => k + s.size, 0), 0),
      distinctStates: states.size,
      roles: Object.values(rolesByTenant).flat().length, rolesWalked: [...walkedRoles.values()].reduce((n, s) => n + s.size, 0),
    },
  };
}

/** docs/journeys/coverage.md, from the model. Deterministic: no timestamps, sorted. */
export function coverageMarkdown(model, { families, pending = [] }) {
  const t = model.totals;
  const tenants = [...new Set(model.unvisited.map((r) => r.tenant))].sort();
  const roleCols = [...new Set([...model.cells.values()].flatMap((m) => [...m.keys()]))].sort();
  const out = [
    '# Journey coverage — route × role × state',
    '',
    'Generated by `node scripts/journeys/run-maps.mjs coverage` from the maps under',
    '`docs/journeys/maps/` and the route inventory (`portal/e2e/route-inventory.ts`); do not edit',
    'by hand. A cell lists the UI states a map shows that route in, for that tenant:role. Only maps',
    'count — a hand-walked log is not a map. See docs/journeys.md "Journey maps".',
    'This is static map coverage, not a count of executed or passing walks.',
    '',
    `- **${t.maps} maps** (families: ${families.join(', ') || 'none'})`,
    `- **routes:** ${t.visited} of ${t.routes} inventoried routes visited by a map (${t.routes ? Math.round((100 * t.visited) / t.routes) : 0}%)${t.offInventory ? `; ${t.offInventory} visited route(s) are not in the inventory` : ''}`,
    `- **roles:** ${t.rolesWalked} of ${t.roles} tenant roles mapped (including cross-tenant roles in each tenant)`,
    `- **cells:** ${t.roleCells} route × role cells, ${t.stateCells} route × role × state cells, ${t.distinctStates} distinct states`,
    '',
    '## Covered',
    '',
    `| route | ${roleCols.join(' | ')} |`,
    `|---|${roleCols.map(() => '---').join('|')}|`,
    ...[...model.cells.keys()].sort().map((k) => `| \`${k}\` | ${roleCols.map((r) => [...(model.cells.get(k).get(r) ?? [])].sort().join(', ')).join(' | ')} |`),
    '',
    '## Gaps',
    '',
    '### Roles never walked',
    '',
    ...(model.rolesNever.length ? model.rolesNever.map((x) => `- ${x.tenant}: ${x.roles.join(', ')}`) : ['- none']),
    '',
    '### States never shown (on routes a map visits)',
    '',
    'Expected per route kind: ' + Object.entries(EXPECTED_STATES).map(([k, s]) => `${k} → ${s.join(', ')}`).join('; ') + '.',
    '',
    ...(model.statesNever.length ? model.statesNever.sort((a, b) => a.key.localeCompare(b.key)).map((x) => `- \`${x.key}\` (${x.kind}): ${x.missing.join(', ')}`) : ['- none']),
    '',
    '### Routes no map visits',
    '',
    ...tenants.flatMap((tn) => {
      const rs = model.unvisited.filter((r) => r.tenant === tn).map((r) => `\`${r.key}\``).sort();
      return [`- **${tn}** (${rs.length}): ${rs.join(', ')}`];
    }),
    '',
    '### Maps not walked yet (not counted above)',
    '',
    ...(pending.length ? pending.map((p) => `- \`${p.file}\` → ${p.log}: ${p.goal}. Held: ${p.why}.`) : ['- none']),
    '',
  ];
  return out.join('\n');
}
