// Piece I6.2: the export of what Milo showed (row I6.2; decisions 4, 8, 17). The export button sits on the Consents table
// of the profile's Activity tab, one per finished round, for the recruiter only.
//   I6.2a  the recruiter downloads Ingrid's coding round's export from the page: a JSON file with its sections by name,
//          the candidate by id and never by name
//   I6.2b  the route: an attachment, never cached; the hiring manager is not-found and has no button on the page
// Reads only.
export default async function run({ portal, record, signIn, api, SEED, fs }) {
  const ingrid = SEED.candidates.ingrid;
  const round = SEED.interviews.ingridCoding;
  const SECTIONS = ['milo-for-you', 'notices', 'panel-notices', 'recap', 'suggestions'];
  const openActivity = async (page) => {
    await page.goto(`${portal}/interviews/candidates/${ingrid}`, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('interviews-candidate-profile').waitFor({ timeout: 30_000 });
    await page.getByTestId('interviews-profile-tab-activity').click();
    await page.getByTestId('interviews-profile-consents').getByTestId('interviews-consent-round').first().waitFor({ timeout: 30_000 });
  };

  // ── I6.2a: the download from the page ──────────────────────────────────
  try {
    const context = await signIn(SEED.cast.recruiter);
    const page = await context.newPage();
    await openActivity(page);
    const buttons = page.getByTestId('interviews-milo-export');
    const count = await buttons.count();
    const label = await buttons.first().getAttribute('aria-label');
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 30_000 }), buttons.first().click()]);
    const file = await download.path();
    const text = file ? fs.readFileSync(file, 'utf8') : '';
    const doc = JSON.parse(text || '{}');
    const keys = Object.keys(doc.sections ?? {}).sort();
    const errorLine = await page.getByTestId('interviews-milo-export-error').count();
    const ok = count >= 1 && /^Export what Milo showed for /.test(label ?? '') && /\.json$/.test(download.suggestedFilename())
      && JSON.stringify(keys) === JSON.stringify(SECTIONS) && keys.every((k) => !doc.sections[k]?.error)
      && doc.interview?.candidateId === ingrid && typeof doc.exportedAt === 'string'
      && !/Ingrid|Solberg/.test(text) && errorLine === 0;
    record('I6.2a', ok, `recruiter: ${count} export buttons ("${label}"); downloaded ${download.suggestedFilename()}, ${text.length} bytes, sections [${keys.join(', ')}], candidate ${doc.interview?.candidateId === ingrid ? 'by id' : 'MISSING'}, name ${/Ingrid|Solberg/.test(text) ? 'PRESENT' : 'absent'}`);
    await context.close();
  } catch (e) { record('I6.2a', false, `stopped: ${String(e?.message ?? e).split('\n')[0]}`); }

  // ── I6.2b: the route's headers, and the hiring manager ─────────────────
  try {
    const greta = await signIn(SEED.cast.recruiter);
    const r = await api(greta, 'GET', `/api/interviews/interviews/${round}/milo-export`);
    await greta.close();
    const amara = await signIn(SEED.cast.hiringManager);
    const page = await amara.newPage();
    await openActivity(page);
    await page.waitForTimeout(500);
    const buttons = await page.getByTestId('interviews-milo-export').count();
    const hm = await api(amara, 'GET', `/api/interviews/interviews/${round}/milo-export`);
    await amara.close();
    const ok = r.status === 200 && r.headers['cache-control'] === 'no-store' && /^attachment; filename=".+\.json"$/.test(r.headers['content-disposition'] ?? '')
      && /application\/json/.test(r.headers['content-type'] ?? '') && buttons === 0 && hm.status === 404;
    record('I6.2b', ok, `recruiter's export ${r.status}, cache-control ${r.headers['cache-control']}, ${r.headers['content-disposition']}; hiring manager: ${buttons} buttons, the route ${hm.status}`);
  } catch (e) { record('I6.2b', false, `stopped: ${String(e?.message ?? e).split('\n')[0]}`); }
}
