// Shared helpers for the interviews walk (scripts/journeys/interviews.mjs and its pieces in this folder).
// createContext() launches the browser and returns what every piece receives.
//
// What a piece gets (the hardening pass's harness is the second half of this list):
//   record, signIn, namesIn, geometry, shoot, resetMock, homes      the first walk's helpers, unchanged
//   SEED                       every seeded id by what it is (nobody types an id in a piece); defined in seed.mjs
//   api(context, method, path, body)   one call through the portal's proxy → { status, body }
//   shootPage(page, name)      one screenshot at 1440 and 1280, with "no sideways scroll" judged
//   mintInvite(recruiter, interviewId)  the recruiter makes the candidate's link → { linkPath, token, status }
//   openGuest(linkPath)        a browser context with NO account that opens /join#<token> → { context, page }
//   answerConsents(page, answers) / guestConsents(context, answers)   the three answers, on the page or by the API
//   toWaiting(page, answers)   landing → consents → device check → the waiting room (the knock)
//   guestApi(context, method, path, body)   the candidate's own routes under /api/interview-invite
//   admit(lead, interviewId, admit)     the lead lets the candidate in (true) or not yet (false)
//   startInterview / endInterview(lead, interviewId)   the lead's two room writes, with the revision read first
//   setTime(recruiter, interviewId, iso)  the recruiter moves the time
//   clock.set(ms) / clock.advance(ms) / clock.sweep('soon' | 'retention') / clock.reset() / clock.minutesFromNow(n)   the mock clock
//   bells(page, /re/)          the lines in a person's bell that match
//   refusals(tablePath)        a judge table of "this route answers 404 to these principals" (see matrix below)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(path.join(root, 'portal/package.json'));
const playwright = await import(pathToFileURL(require.resolve('playwright')).href);
const chromium = playwright.chromium ?? playwright.default.chromium;

import { SEED, seedPath, parseRefusalTable } from './seed.mjs';

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

export { SEED, seedPath, parseRefusalTable };

export async function createContext() {
  const portal = process.env.PORTAL_URL;
  assert.ok(portal, 'run through run-demo-moments.mjs --journey interviews');
  const middleware = process.env.MIDDLEWARE_URL;
  const outAt = process.argv.indexOf('--out');
  const out = process.argv[outAt + 1];
  assert.ok(outAt >= 0 && out, '--out is required');
  fs.mkdirSync(out, { recursive: true });

  const results = [];
  function record(step, ok, detail) {
    results.push({ step, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'} ${step}: ${detail}`);
  }

  // The fake camera and microphone let a candidate's device check and a call's tiles run headless; nothing is captured.
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });

  /** A fresh browser context signed in as `userId` (the picker login the mock offers). */
  async function signIn(userId, width = 1440) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const res = await context.request.post(`${portal}/api/session/login`, { data: { userId } });
    assert.equal(res.status(), 200, `sign in as ${userId}: ${res.status()}`);
    return context;
  }

  /** The names in a table's candidate cells, once the rows have loaded. */
  async function namesIn(page, tableId, cellId, expectOne) {
    const table = page.getByTestId(tableId);
    await table.getByText(expectOne, { exact: true }).first().waitFor({ timeout: 30_000 });
    // A person cell is the avatar (initials until a portrait lands) above the name: keep the name.
    return (await table.getByTestId(cellId).allInnerTexts()).map((s) => s.trim().split('\n').pop().trim());
  }

  /** The geometry a dense home must keep: a table row above the fold and no sideways scroll. */
  async function geometry(page, tableId) {
    return page.evaluate((id) => {
      const table = document.querySelector(`[data-testid="${id}"]`);
      const row = table?.querySelector('tbody tr');
      return {
        firstRowTop: row ? Math.round(row.getBoundingClientRect().top) : null,
        viewport: innerHeight,
        horizontalScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      };
    }, tableId);
  }

  async function shoot(page, name, tableId) {
    const shots = [];
    for (const width of [1440, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(300);
      const g = await geometry(page, tableId);
      const file = path.join(out, `interviews-${name}-${width}.png`);
      await page.screenshot({ path: file });
      shots.push({ width, ...g, ok: g.firstRowTop !== null && g.firstRowTop < g.viewport && !g.horizontalScroll });
    }
    return shots;
  }

  /**
   * A page with no table to judge (a form, the room, the candidate's steps): one screenshot at each width, ok when
   * the page does not scroll sideways. Files are interviews-<name>-<width>.png in --out.
   */
  async function shootPage(page, name) {
    const shots = [];
    for (const width of [1440, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(300);
      const horizontalScroll = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
      const file = path.join(out, `interviews-${name}-${width}.png`);
      await page.screenshot({ path: file });
      shots.push({ width, file, horizontalScroll, ok: !horizontalScroll });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    return shots;
  }

  /** One API call as the context's person, through the portal's proxy. The body is parsed when it is JSON. */
  async function call(context, method, url, body) {
    const res = await context.request.fetch(url, { method, ...(body === undefined ? {} : { data: body }), failOnStatusCode: false });
    let parsed = null;
    try { parsed = await res.json(); } catch { /* no JSON body */ }
    return { status: res.status(), body: parsed, headers: res.headers() };
  }
  const api = (context, method, apiPath, body) => call(context, method, `${portal}${apiPath}`, body);
  /** The candidate's own routes: guestApi(guest.context, 'GET', '/admission'). */
  const guestApi = (context, method, guestPath, body) => call(context, method, `${portal}/api/interview-invite${guestPath}`, body);

  // ── the mock clock (POST /api/__mock/interviews/clock, mock world only) ──────────────────────────────────
  // The offset moves the time the interviews code reads (lib/interviews/clock.ts): link expiry, the guest's session,
  // "starting soon", retention periods, what is stamped on a write. It does NOT move staff sessions, spend-hold
  // expiry, Milo's listening limit or the seed's own dates (those are stamped from the wall clock when the world
  // is reset). resetMock puts the clock back.
  async function clockCall(body) {
    assert.ok(middleware, 'MIDDLEWARE_URL is not set');
    const r = await fetch(`${middleware}/api/__mock/interviews/clock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(r.status, 200, `POST /api/__mock/interviews/clock answered ${r.status}`);
    return r.json();
  }
  const clock = {
    MINUTE_MS, DAY_MS,
    /** The interviews clock runs `offsetMs` ahead of the wall clock (0 puts it back). */
    set: (offsetMs) => clockCall({ offsetMs }),
    /** Move on by `ms` from wherever the clock is now. */
    advance: async (ms) => clockCall({ offsetMs: (await clockCall({})).offsetMs + ms }),
    /** Run one sweep now, at the clock's time: 'soon' (the starting-soon bells) or 'retention' (periods and open deletions). */
    sweep: (which) => clockCall({ sweep: which }),
    reset: () => clockCall({ offsetMs: 0 }),
    /** An ISO time `minutes` from the clock's now, on a whole minute (a time is refused otherwise), rounded up. */
    minutesFromNow: async (minutes) => new Date(Math.ceil((new Date((await clockCall({})).now).getTime() + minutes * MINUTE_MS) / MINUTE_MS) * MINUTE_MS).toISOString(),
    /** The clock's time now, as the server reads it. */
    now: async () => new Date((await clockCall({})).now),
  };

  /**
   * Put the mock world back to its seeds (POST /api/__mock/reset on the walk's own middleware, the route the
   * other journeys use), the interviews clock included. A piece that writes calls this first so it starts from
   * the seeds whatever ran before.
   */
  async function resetMock() {
    assert.ok(middleware, 'MIDDLEWARE_URL is not set');
    const r = await fetch(`${middleware}/api/__mock/reset`, { method: 'POST' });
    assert.equal(r.status, 200, `POST /api/__mock/reset answered ${r.status}`);
  }

  // ── the candidate (rows I2.x): a person with no account ──────────────────────────────────────────────────
  /**
   * The recruiter makes the candidate's link for an interview. → { status, linkPath, token, invite }.
   * linkPath is "/join#<token>"; the token is only ever in the fragment.
   */
  async function mintInvite(recruiter, interviewId = SEED.guestInterview) {
    const r = await api(recruiter, 'POST', `/api/interviews/interviews/${interviewId}/invite`, {});
    const linkPath = r.body?.linkPath ?? null;
    return { status: r.status, linkPath, token: linkPath ? linkPath.split('#')[1] : null, invite: r.body?.invite ?? null, error: r.body?.error ?? null };
  }
  const revokeInvite = (recruiter, interviewId = SEED.guestInterview) => api(recruiter, 'DELETE', `/api/interviews/interviews/${interviewId}/invite`);

  /**
   * A browser context with no session at all, opened on the candidate's link. Resolves once the page has settled
   * on a step (the landing card), the dead-link page, or the room. → { context, page, landed } where landed is
   * 'interview' | 'dead' | 'room' | null. Close the context when done: a second openGuest of the same link is the
   * "second opening ends the first session" case.
   */
  async function openGuest(linkPath, { width = 1440 } = {}) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, permissions: ['camera', 'microphone'] });
    const page = await context.newPage();
    await page.goto(`${portal}${linkPath}`, { waitUntil: 'domcontentloaded' });
    const seen = async (id) => page.getByTestId(id).first().waitFor({ timeout: 30_000 }).then(() => id);
    const first = await Promise.any([seen('join-interview'), seen('join-dead'), seen('join-room'), seen('join-consents'), seen('join-waiting')]).catch(() => null);
    const landed = first === 'join-interview' ? 'interview' : first === 'join-dead' ? 'dead' : first === 'join-room' ? 'room' : first;
    return { context, page, landed };
  }

  /**
   * A candidate's session without a page: the token exchanged by the API in a context with no account. For API
   * tables and sweeps. → { context, status }.
   */
  async function guestSession(token) {
    const context = await browser.newContext();
    const r = await guestApi(context, 'POST', '/exchange', { token });
    return { context, status: r.status };
  }

  const ALL_YES = Object.freeze({ recording: true, transcription: true, milo: true });
  /** The three answers by the API (the notice version is read first, as the page does). → { status, body }. */
  async function guestConsents(context, answers = ALL_YES) {
    const before = await guestApi(context, 'GET', '/consents');
    if (before.status !== 200) return before;
    return guestApi(context, 'PUT', '/consents', { noticeVersion: before.body.notice.version, ...answers });
  }

  /**
   * The three answers on the page, then Continue. `answers` is { recording, transcription, milo } of booleans; with
   * the transcript declined Milo's question is locked off and is not clicked. Leaves the page on the next step
   * (the device check, or the held page when a required part was declined).
   */
  async function answerConsents(page, answers = ALL_YES) {
    await page.getByTestId('join-consents').waitFor({ timeout: 30_000 });
    for (const part of ['recording', 'transcription', 'milo']) {
      if (part === 'milo' && answers.transcription === false) continue;
      // The library's radio is a visually hidden input under its label: click the label, as a person does.
      await page.getByTestId(`join-consent-${part}-choice`).locator('label').filter({ hasText: answers[part] ? /^Yes$/ : /^No$/ }).click();
    }
    await page.getByTestId('join-consents-continue').click();
  }

  /**
   * From the landing card to the waiting room: Continue, the three answers, the device check's Continue. The
   * waiting step knocks by itself. → the step the page ended on: 'waiting' | 'held' | 'room' | null.
   */
  async function toWaiting(page, answers = ALL_YES) {
    if (await page.getByTestId('join-continue').count()) await page.getByTestId('join-continue').click();
    await answerConsents(page, answers);
    const seen = async (id) => page.getByTestId(id).first().waitFor({ timeout: 30_000 }).then(() => id);
    const next = await Promise.any([seen('join-devices'), seen('join-held')]).catch(() => null);
    if (next === 'join-held') return 'held';
    if (next !== 'join-devices') return null;
    await page.getByTestId('join-devices-continue').click();
    const end = await Promise.any([seen('join-waiting'), seen('join-room'), seen('join-held')]).catch(() => null);
    return end ? end.replace('join-', '') : null;
  }

  // ── the panel's side of the door and the room ────────────────────────────────────────────────────────────
  const readInterview = async (context, interviewId) => (await api(context, 'GET', `/api/interviews/interviews/${interviewId}`)).body?.interview ?? null;
  /** The candidate's admission as the lead (or a panel member) reads it. */
  const waiting = async (context, interviewId) => (await api(context, 'GET', `/api/interviews/interviews/${interviewId}/waiting`)).body?.admission ?? null;
  /** The lead lets the candidate in (true) or answers "not yet" (false). → { status, body }. */
  const admit = (lead, interviewId, letIn = true) => api(lead, 'POST', `/api/interviews/interviews/${interviewId}/admit`, { admit: letIn });
  async function roomWrite(lead, interviewId, what) {
    const interview = await readInterview(lead, interviewId);
    assert.ok(interview, `${what}: the lead cannot read ${interviewId}`);
    return api(lead, 'POST', `/api/interviews/interviews/${interviewId}/${what}`, { revision: interview.revision });
  }
  /** The lead joins: accepted or ready → live. */
  const startInterview = (lead, interviewId) => roomWrite(lead, interviewId, 'start');
  /** The lead ends it: live → ended (the scorecard-due bells ring). An ended interview is start then end. */
  const endInterview = (lead, interviewId) => roomWrite(lead, interviewId, 'end');
  /** The recruiter sets or moves the time (ISO), or clears it with null. */
  async function setTime(recruiter, interviewId, scheduledAt) {
    const interview = await readInterview(recruiter, interviewId);
    assert.ok(interview, `setTime: the recruiter cannot read ${interviewId}`);
    return api(recruiter, 'PUT', `/api/interviews/interviews/${interviewId}/time`, { revision: interview.revision, scheduledAt });
  }

  // ── bells ────────────────────────────────────────────────────────────────────────────────────────────────
  /**
   * The lines in a person's bell that match `re`, read from the open page's bell (the page must be signed in and
   * past its first render). Polls up to `ms`: a bell arrives over the socket. → { lines, panel }; lines is [] when
   * none arrived. With `absent: true` it reads once after `ms` and returns what is there (for "no second bell").
   */
  async function bells(page, re, { ms = 20_000, absent = false } = {}) {
    const BELL = '[data-testid="activity-bell"]';
    const read = async () => {
      await page.locator(BELL).first().click();
      const panel = page.locator('[role="dialog"]').last();
      await panel.waitFor({ state: 'visible', timeout: 5000 }).catch(() => undefined);
      const all = panel.getByRole('tab', { name: /^All/ });
      if (await all.count()) await all.first().click().catch(() => undefined);
      const lines = (await panel.innerText().catch(() => '')).split('\n').filter((l) => re.test(l));
      return { panel, lines };
    };
    if (absent) {
      await page.waitForTimeout(ms);
      const got = await read();
      await page.keyboard.press('Escape');
      return got;
    }
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const got = await read();
      if (got.lines.length > 0) return got;
      await page.keyboard.press('Escape');
      await page.waitForTimeout(1000);
    }
    return { panel: null, lines: [] };
  }

  // ── the 404 matrix (scripts/validate-interviews.d/<row>.404, format at parseRefusalTable) ────────────────
  /**
   * Run one row's table from the seeds and say which lines held. Each principal is one context, made once and
   * shared by the table's lines; a guest's link is minted by the recruiter for the interview it names.
   * → { ok, checked, failures: ["line 3 GET /…: interviewer2 got 200, want 404", …] }.
   */
  async function refusals(tablePath) {
    const rows = parseRefusalTable(fs.readFileSync(tablePath, 'utf8'));
    await resetMock();
    const contexts = new Map();
    const contextFor = async (who) => {
      if (contexts.has(who)) return contexts.get(who);
      let context;
      if (who === 'anon') context = await browser.newContext();
      else if (who === 'guest' || who.startsWith('guest:')) {
        const name = who.split(':')[1];
        const interviewId = name ? SEED.interviews[name] : SEED.guestInterview;
        assert.ok(interviewId, `no seeded interview "${name}" for ${who}`);
        const recruiter = await contextFor('recruiter');
        const invite = await mintInvite(recruiter, interviewId);
        assert.equal(invite.status, 201, `${who}: the link was not made (${invite.status} ${invite.error ?? ''})`);
        const session = await guestSession(invite.token);
        assert.equal(session.status, 200, `${who}: the link did not open (${session.status})`);
        context = session.context;
      } else {
        assert.ok(SEED.cast[who], `unknown principal "${who}" (cast names, anon, guest, guest:<interview>)`);
        context = await signIn(SEED.cast[who]);
      }
      contexts.set(who, context);
      return context;
    };
    const failures = [];
    let checked = 0;
    try {
      for (const row of rows) {
        for (const p of row.refused) {
          const r = await call(await contextFor(p.who), row.method, `${portal}${row.path}`, row.body);
          checked += 1;
          if (r.status !== p.want) failures.push(`line ${row.line} ${row.method} ${row.path}: ${p.who} got ${r.status}, want ${p.want}`);
        }
        for (const p of row.allowed) {
          const r = await call(await contextFor(p.who), row.method, `${portal}${row.path}`, row.body);
          checked += 1;
          const refused = p.want === null ? [401, 403, 404].includes(r.status) : r.status !== p.want;
          if (refused) failures.push(`line ${row.line} ${row.method} ${row.path}: ${p.who} got ${r.status}, want ${p.want ?? 'not refused'}`);
        }
      }
    } catch (e) {
      failures.push(`stopped: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
    } finally {
      for (const c of contexts.values()) await c.close().catch(() => undefined);
      await resetMock();
    }
    return { ok: failures.length === 0 && checked > 0, checked, failures };
  }

  // Each piece may leave screenshots' geometry here for a later piece to judge (the homes the first piece shot).
  const homes = [];
  return {
    assert, fs, path, portal, middleware, out, browser, results, record, signIn, namesIn, geometry, shoot, resetMock, homes,
    SEED, api, guestApi, shootPage, clock,
    mintInvite, revokeInvite, openGuest, guestSession, guestConsents, answerConsents, toWaiting, ALL_YES,
    readInterview, waiting, admit, startInterview, endInterview, setTime,
    bells, refusals,
  };
}
