// Piece I6.4: the retention periods come from this deployment's settings and move the sweep (row I6.4; decision 17).
//   I6.4a  the periods the profile states (GET …/deletions → periods) are this deployment's settings: the stack's own
//          INTERVIEWS_MEDIA_RETENTION_DAYS, INTERVIEWS_RECORD_RETENTION_YEARS and INTERVIEWS_DELETION_WITHIN_DAYS when set,
//          else 90 days, 4 years and 30 days
//   I6.4b  the media period moves the sweep: Ingrid's coding round keeps its code log a day before it ends, loses it a day after
//   I6.4c  the record period moves the sweep: her consents stay a day before it ends and go a day after
//   I6.4d  the deletion period sets a request's due date: it is that many days after the request
// Every boundary is computed from the periods read and the round's endedAt as the API returns them, so the same piece holds
// on a stack started with other values (the walk runner hands its environment to the middleware).
const DAY = 86_400_000;
const addYears = (ms, years) => { const d = new Date(ms); d.setUTCFullYear(d.getUTCFullYear() + years); return d.getTime(); };
const setting = (name, fallback, min, max) => {
  const raw = (process.env[name] ?? '').trim();
  const n = Number(raw);
  return raw && /^\d+$/.test(raw) && n >= min && n <= max ? n : fallback;
};

export default async function run({ record, signIn, api, SEED, clock, resetMock }) {
  const ingrid = SEED.candidates.ingrid;
  const round = SEED.interviews.ingridCoding;
  await resetMock();
  let greta;
  try {
    greta = await signIn(SEED.cast.recruiter);
    const log = async () => (await api(greta, 'GET', `/api/interviews/candidates/${ingrid}/deletions`)).body;
    const sweepAt = async (ms) => { await clock.set(Math.round(ms - Date.now())); return (await clock.sweep('retention')).sweep; };
    const pad = async () => { const r = await api(greta, 'GET', `/api/interviews/interviews/${round}/pad/log?after=0`); return r.status === 200 ? r.body.events.length : -1; };
    const consent = async () => (await api(greta, 'GET', `/api/interviews/candidates/${ingrid}/consents`)).body?.items?.find((i) => i.interviewId === round)?.answered ?? null;

    // ── I6.4a ────────────────────────────────────────────────────────────
    const { periods } = await log();
    const want = {
      mediaDays: setting('INTERVIEWS_MEDIA_RETENTION_DAYS', 90, 1, 3650),
      recordYears: setting('INTERVIEWS_RECORD_RETENTION_YEARS', 4, 1, 50),
      deletionDays: setting('INTERVIEWS_DELETION_WITHIN_DAYS', 30, 1, 90),
    };
    const set = ['INTERVIEWS_MEDIA_RETENTION_DAYS', 'INTERVIEWS_RECORD_RETENTION_YEARS', 'INTERVIEWS_DELETION_WITHIN_DAYS'].filter((n) => process.env[n]);
    record('I6.4a', JSON.stringify(periods) === JSON.stringify(want), `the profile states ${JSON.stringify(periods)}; this stack's settings say ${JSON.stringify(want)} (${set.length ? `set: ${set.join(', ')}` : 'none set: the defaults'})`);

    // ── I6.4b: the media period ──────────────────────────────────────────
    const ended = Date.parse((await api(greta, 'GET', `/api/interviews/interviews/${round}/record`)).body.record.interview.endedAt);
    const pad0 = await pad();
    await sweepAt(ended + periods.mediaDays * DAY - DAY);
    const padUnder = await pad();
    const mediaUnder = (await log()).items.filter((r) => r.reason === 'media-period').length;
    await sweepAt(ended + periods.mediaDays * DAY + DAY);
    const padOver = await pad();
    const mediaOver = (await log()).items.filter((r) => r.reason === 'media-period').length;
    record('I6.4b', pad0 > 0 && padUnder === pad0 && mediaUnder === 0 && padOver === 0 && mediaOver >= 1,
      `${periods.mediaDays} days after ${new Date(ended).toISOString().slice(0, 10)}: a day under, ${padUnder}/${pad0} pad events and ${mediaUnder} media rows; a day over, ${padOver} pad events and ${mediaOver} media rows`);

    // ── I6.4c: the record period ─────────────────────────────────────────
    const due = addYears(ended, periods.recordYears);
    await sweepAt(due - DAY);
    const under = await consent();
    const recUnder = (await log()).items.filter((r) => r.reason === 'record-period').length;
    await sweepAt(due + DAY);
    const over = await consent();
    const recOver = (await log()).items.filter((r) => r.reason === 'record-period').length;
    record('I6.4c', under === true && recUnder === 0 && over === false && recOver >= 1,
      `${periods.recordYears} years after the end: a day under, consent answered ${under} and ${recUnder} record rows; a day over, answered ${over} and ${recOver} record rows`);

    // ── I6.4d: the deletion period ───────────────────────────────────────
    await clock.reset();
    const asked = await api(greta, 'POST', `/api/interviews/candidates/${ingrid}/deletion`, { confirm: true });
    const row = asked.body?.deletion;
    const days = row ? (Date.parse(row.dueBy) - Date.parse(row.requestedAt)) / DAY : null;
    record('I6.4d', asked.status === 200 && days === periods.deletionDays, `a request asked ${row?.requestedAt?.slice(0, 16)} is due by ${row?.dueBy?.slice(0, 16)}: ${days} days, the setting says ${periods.deletionDays}`);
  } catch (e) {
    record('I6.4a', false, `stopped: ${String(e?.message ?? e).split('\n')[0]}`);
  } finally {
    await greta?.close();
    await resetMock();
  }
}
