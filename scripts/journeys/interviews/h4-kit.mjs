// Helpers the "after the call" pieces share (I5.1 to I5.6-results; hardening lane H4). Not a piece: the runner loads only
// files that start with a capital letter or a digit, and lib.mjs (which this lane does not edit) stays as H0 left it.
//
// Everything here drives the pages the way a person does, or reads an answer through the same proxy a page uses. Nothing
// reaches for a test id that is not on a page today; the test ids are frozen from the UI rounds.

/** Text a person would read on the page, whitespace squeezed. */
export const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** Wait for a test id, or throw with its name (a step's catch reports the first line). */
export async function seen(page, testId, ms = 30_000) {
  await page.getByTestId(testId).first().waitFor({ timeout: ms });
}

/** The rating groups of the scorecard form, one per competency. */
export const ratingGroups = (page) => page.locator('[data-ui-control="rating"]');

/** Rate every competency on the open form: `values` is one number for all, or an array in the kit's order. → how many were rated. */
export async function rateAllUI(page, values) {
  const groups = ratingGroups(page);
  await groups.first().waitFor({ timeout: 30_000 });
  const n = await groups.count();
  for (let i = 0; i < n; i += 1) {
    const v = Array.isArray(values) ? values[i % values.length] : values;
    await groups.nth(i).getByRole('radio', { name: new RegExp(`^${v} `) }).click();
  }
  return n;
}

/** The ratings step's "Continue to the recap": one click, the prompt that records the ratings, then the recap step. */
export async function openRecapStep(page) {
  await page.getByTestId('interviews-scorecard-to-recap').click();
  await page.getByTestId('interviews-scorecard-ask-option-open').click();
  await seen(page, 'interviews-scorecard-recap-step');
}

/** From the recap step to the submitted scorecard: Continue, a recommendation, a summary, Submit, the prompt's Submit. */
export async function submitFromRecap(page, { recommendation = 'Yes', summary }) {
  await page.getByTestId('interviews-scorecard-to-decide').click();
  await seen(page, 'interviews-scorecard-decide-step');
  await page.getByTestId('interviews-scorecard-recommendation').locator('label').filter({ hasText: new RegExp(`^${recommendation}$`) }).click();
  if (summary !== undefined) await page.getByTestId('interviews-scorecard-summary').first().fill(summary);
  await page.getByTestId('interviews-scorecard-submit').click();
  await page.getByTestId('interviews-scorecard-ask-option-submit').click();
  await seen(page, 'interviews-scorecard-mine');
}

/** A complete scorecard body for the round's kit, read from the page's own route, as a person's page would send it. */
export async function scorecardBody(ctx, who, interviewId, over = {}) {
  const page = (await ctx.api(who, 'GET', `/api/interviews/interviews/${interviewId}/scorecard`)).body?.scorecard;
  if (!page) throw new Error(`no scorecard page for ${interviewId}`);
  return {
    ratings: page.competencies.map((c, n) => ({ competencyId: c.id, rating: (n % 3) + 2, note: '' })),
    recommendation: 'yes', summary: 'Clear examples throughout, in the candidate\'s own words.', basedOn: page.mine?.version ?? 0, ...over,
  };
}

/** The ratings an open takes, from the same page. */
export async function openBody(ctx, who, interviewId, rating = 3) {
  const page = (await ctx.api(who, 'GET', `/api/interviews/interviews/${interviewId}/scorecard`)).body?.scorecard;
  return { ratings: page.competencies.map((c) => ({ competencyId: c.id, rating })) };
}

/**
 * Milo never scores (decision 6): the page's words, with the library's fixed hint sentences taken out, hold no sentence in
 * which Milo rates, scores, ranks or recommends. → the offending snippet, or null.
 */
export function miloScoresIn(text) {
  const t = squash(text)
    .replace(/Milo does not rate or recommend\./g, ' ')
    // The owner's scorecard banner (docs/interviews-tenant-plan.md, "Milo's recommendation on the scorecard"): a fixed rule
    // over the people's ratings, not a model's judgement, so its own fixed words are taken out like the hints.
    .replace(/Milo recommends: (?:Advance|Hold|Don't advance)/g, ' ')
    .replace(/Milo's recommendation from the ratings and the transcript evidence\./g, ' ')
    .replace(/Milo finds what was said, and where; it does not judge the candidate\./g, ' ')
    .replace(/Milo can only find what was said[^.]*\./g, ' ');
  // Milo as the one who rates ("Milo rates", "Milo's rating", "recommended by Milo"), not the page's own words near its name.
  const m = /\bMilo\s+(?:rates|rated|scores|scored|ranks|ranked|recommends|recommended|gives|gave|thinks|believes)\b[^.]{0,40}|\bMilo(?:'s)?\s+(?:rating|score|ranking|recommendation|verdict|grade)\b[^.]{0,40}|\b(?:rated|scored|ranked|recommended|graded) by Milo\b/i.exec(t);
  return m ? m[0] : null;
}

/** The names of the checks that did not hold, for a step's detail line. */
export const failing = (checks) => Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k).join(', ') || 'none';

/** A consent answer anywhere on a page's words ("consent" itself, or what a declined answer would say). */
export const consentIn = (text) => /\bconsent/i.test(text);

/** Count and list the elements in a section that carry a tone (a Chip with a colour). */
export async function tonesIn(locator) {
  return locator.locator('[data-tone]').count();
}

/** The names that would give a guest id or a code source away, anywhere in a JSON value. */
export const leaks = (json) => {
  const text = JSON.stringify(json);
  return ['guest:', '"source"', 'consent'].filter((w) => text.includes(w));
};

/** `m:ss` or `h:mm:ss` as the code playback reads it ("3:20 / 58:20" → 200_000), floor seconds. */
export function msOfClock(text) {
  const m = /(\d+):(\d{2})(?::(\d{2}))?/.exec(text ?? '');
  if (!m) return null;
  const parts = [m[1], m[2], m[3]].filter((x) => x !== undefined).map(Number);
  return parts.length === 3 ? ((parts[0] * 60 + parts[1]) * 60 + parts[2]) * 1000 : (parts[0] * 60 + parts[1]) * 1000;
}

/** A short line for a failure: the first line of the message. */
export const why = (e) => `${e instanceof Error ? e.message : String(e)}`.split('\n')[0].slice(0, 220);
