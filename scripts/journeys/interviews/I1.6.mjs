// Piece I1.6: the résumé, upload and the viewer (row I1.6). It writes, so it puts the mock world back to its seeds first and
// again at the end. Every file is built in this piece: a small PDF from bytes made here, a text file, a buffer of zeros under a
// PDF header. No file from this machine and no real document.
//   I1.6a  the recruiter uploads a résumé for a candidate who has none: the facts line and the viewer show
//   I1.6b  a replacement takes its place: one résumé, the new name
//   I1.6c  Remove asks in the page's prompt; Keep it leaves the file; Remove takes it out and the page says there is none
//   I1.6d  refusals in words: not a PDF, over 10 MB, a corrupt PDF opens to a plain line, and the storage-missing sentence (a stubbed 503)
//   I1.6e  the hiring manager and the interviewer see the viewer with no controls; seeded résumés open on Prepare; an out-of-scope interviewer finds nothing
/** A one-page PDF with a few lines of text, its byte offsets worked out here. */
function pdfOf(lines) {
  const text = lines.map((l, i) => `${i === 0 ? '' : 'T* '}(${l.replace(/[()\\]/g, '')}) Tj`).join('\n');
  const stream = `BT /F1 12 Tf 14 TL 72 720 Td\n${text}\nET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

export default async function run({ portal, SEED, record, signIn, shootPage, resetMock, api }) {
  await resetMock();
  const chloe = SEED.candidates.chloe;       // no résumé in the seeds, on the Backend opening
  const mateo = SEED.candidates.mateo;       // a seeded résumé; Hugo has rounds on him, Amara reads him, Wen does not
  const profile = (c) => `${portal}/interviews/candidates/${c}`;
  const greta = await signIn(SEED.cast.recruiter);
  const resumeOf = async (ctx, c) => api(ctx, 'GET', `/api/interviews/candidates/${c}/resume`);
  const openTab = async (page, c) => {
    await page.goto(profile(c), { waitUntil: 'domcontentloaded' });
    await page.getByTestId('interviews-profile-tab-resume').click();
    await page.getByTestId('interviews-profile-resume-section').waitFor({ timeout: 30_000 });
  };
  const choose = async (page, file) => page.getByTestId('interviews-resume-upload').locator('input[type="file"]').setInputFiles(file);
  const pdf = (name, lines) => ({ name, mimeType: 'application/pdf', buffer: pdfOf(lines) });
  const textOf = async (page, tid) => ((await page.getByTestId(tid).first().innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
  const page = await greta.newPage();

  // ── I1.6a ──
  try {
    await openTab(page, chloe);
    const none = await textOf(page, 'interviews-resume-none');
    await choose(page, pdf('chloe-resume.pdf', ['Fictional Person', 'Backend engineer', 'Six fictional years of fictional work.']));
    await page.getByTestId('interviews-resume-facts').waitFor({ timeout: 30_000 });
    const facts = await textOf(page, 'interviews-resume-facts');
    const viewer = await page.getByTestId('interviews-resume-viewer').count();
    const unreadable = await page.getByTestId('interviews-resume-unreadable').count();
    const api1 = await resumeOf(greta, chloe);
    const shots = await shootPage(page, 'resume-viewer');
    record('I1.6a', /No résumé/.test(none) && /by Greta Lindqvist/.test(facts) && viewer === 1 && unreadable === 0 && api1.status === 200 && api1.body.resume.fileName === 'chloe-resume.pdf' && !('storageKey' in api1.body.resume) && shots.every((s) => s.ok),
      `before: "${none}"; after the upload: "${facts}", viewer ${viewer ? 'shown' : 'missing'}${unreadable ? ' but unreadable' : ''}; the record names ${api1.body?.resume?.fileName}; ${shots.map((s) => `@${s.width}${s.horizontalScroll ? ' scrolls sideways' : ' fits'}`).join(', ')}`);
  } catch (e) { record('I1.6a', false, `upload: ${e.message.split('\n')[0]}`); }

  // ── I1.6b ──
  try {
    const before = (await resumeOf(greta, chloe)).body.resume;
    await choose(page, pdf('chloe-newer.pdf', ['Fictional Person', 'Backend engineer, newer version', 'A fictional update.']));
    await page.getByText(/chloe-newer\.pdf/).first().waitFor({ timeout: 30_000 });
    const after = (await resumeOf(greta, chloe)).body.resume;
    const viewer = await page.getByTestId('interviews-resume-viewer').count();
    record('I1.6b', after.id !== before.id && after.fileName === 'chloe-newer.pdf' && viewer === 1, `replaced: ${before.fileName} → ${after.fileName}; one record, viewer ${viewer ? 'shown' : 'missing'}`);
  } catch (e) { record('I1.6b', false, `replace: ${e.message.split('\n')[0]}`); }

  // ── I1.6c ──
  try {
    const deck = page.getByTestId('collection-command-composer-prompts');
    await page.getByTestId('interviews-resume-remove').click();
    await deck.getByText('Remove this résumé?').waitFor({ timeout: 15_000 });
    await deck.getByRole('button', { name: /Keep it/ }).click();
    await page.getByText('Kept. The résumé did not change.').first().waitFor({ timeout: 15_000 });
    await page.waitForTimeout(500);
    const kept = (await resumeOf(greta, chloe)).status;
    await page.getByTestId('interviews-resume-remove').click();
    await deck.getByText('Remove this résumé?').last().waitFor({ timeout: 15_000 });
    await deck.getByRole('button', { name: /Remove/ }).last().click();
    let gone = (await resumeOf(greta, chloe)).status;
    for (let i = 0; i < 20 && gone !== 404; i += 1) { await page.waitForTimeout(500); gone = (await resumeOf(greta, chloe)).status; }
    await page.getByTestId('interviews-resume-none').waitFor({ timeout: 8_000 });
    const line = await textOf(page, 'interviews-resume-none');
    const removeLeft = await page.getByTestId('interviews-resume-remove').count();
    record('I1.6c', kept === 200 && gone === 404 && /No résumé/.test(line) && removeLeft === 0,
      `Keep it left the file (${kept}); Remove took it out (${gone}) and the page says "${line}" without a reload${removeLeft ? ', but Remove is still offered' : ''}`);
  } catch (e) { record('I1.6c', false, `remove: ${e.message.split('\n')[0]}`); }

  // ── I1.6d ──
  try {
    const lines = {};
    await choose(page, { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('plain words, not a PDF') });
    await page.getByTestId('interviews-resume-problem').waitFor({ timeout: 15_000 });
    lines.notPdf = await textOf(page, 'interviews-resume-problem');
    const big = Buffer.alloc(10 * 1024 * 1024 + 1024, 0); Buffer.from('%PDF-1.4\n').copy(big);
    await choose(page, { name: 'big.pdf', mimeType: 'application/pdf', buffer: big });
    await page.waitForFunction((was) => (document.querySelector('[data-testid="interviews-resume-problem"]')?.textContent ?? '') !== was, lines.notPdf, { timeout: 15_000 });
    lines.big = await textOf(page, 'interviews-resume-problem');
    await choose(page, { name: 'broken.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\nthis is only a header that looks like a PDF, nothing inside is one') });
    await page.getByTestId('interviews-resume-unreadable').waitFor({ timeout: 30_000 });
    lines.corrupt = await textOf(page, 'interviews-resume-unreadable');
    // The storage-missing sentence is the server's own (503, covered by interviews-resume.test.ts); the mock world always has storage, so the answer is stubbed here to walk how the page shows it.
    await page.route('**/api/interviews/candidates/*/resume', async (route) => {
      if (route.request().method() !== 'PUT') { await route.fallback(); return; }
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Résumés cannot be stored here yet, so this file was not saved.' }) });
    });
    await choose(page, pdf('again.pdf', ['Fictional Person', 'Another fictional line.']));
    await page.waitForFunction(() => /cannot be stored here yet/.test(document.querySelector('[data-testid="interviews-resume-problem"]')?.textContent ?? ''), null, { timeout: 15_000 });
    lines.storage = await textOf(page, 'interviews-resume-problem');
    await page.unroute('**/api/interviews/candidates/*/resume');
    const ok = /unsupported file type/.test(lines.notPdf) && /exceeds the 10\.0 MB/.test(lines.big) && /could not be opened/.test(lines.corrupt) && /cannot be stored here yet/.test(lines.storage);
    record('I1.6d', ok, `not a PDF: "${lines.notPdf}"; over 10 MB: "${lines.big}"; corrupt PDF: "${lines.corrupt}"; storage missing (stubbed 503): "${lines.storage}"`);
  } catch (e) { record('I1.6d', false, `refusals: ${e.message.split('\n')[0]}`); }
  await page.close();

  // ── I1.6e ──
  try {
    const amara = await signIn(SEED.cast.hiringManager);
    const ap = await amara.newPage();
    await ap.goto(profile(mateo), { waitUntil: 'domcontentloaded' });
    await ap.getByTestId('interviews-profile-tab-resume').click();
    await ap.getByTestId('interviews-resume-viewer').waitFor({ timeout: 30_000 });
    const hmControls = (await ap.getByTestId('interviews-resume-upload').count()) + (await ap.getByTestId('interviews-resume-remove').count());
    const hmWrite = await api(amara, 'DELETE', `/api/interviews/candidates/${mateo}/resume`);
    await amara.close();

    const hugo = await signIn(SEED.cast.interviewer);
    const hp = await hugo.newPage();
    await hp.goto(`${portal}/interviews/rounds/${SEED.interviews.mateoDesign}/prepare`, { waitUntil: 'domcontentloaded' });
    await hp.getByTestId('interviews-prepare-resume').waitFor({ timeout: 30_000 });
    await hp.getByTestId('interviews-resume-viewer').waitFor({ timeout: 30_000 });
    const ivControls = (await hp.getByTestId('interviews-resume-upload').count()) + (await hp.getByTestId('interviews-resume-remove').count());
    const ivWrite = await api(hugo, 'PUT', `/api/interviews/candidates/${mateo}/resume`, {});
    const shots = await shootPage(hp, 'prepare-resume');
    await hugo.close();

    const wen = await signIn(SEED.cast.interviewer2);
    const wr = await resumeOf(wen, mateo);
    const wf = await api(wen, 'GET', `/api/interviews/candidates/${mateo}/resume/file`);
    await wen.close();
    record('I1.6e', hmControls === 0 && hmWrite.status === 403 && ivControls === 0 && ivWrite.status === 403 && wr.status === 404 && wf.status === 404 && shots.every((s) => s.ok),
      `hiring manager: viewer, ${hmControls} controls, a delete answers ${hmWrite.status}; the lead on Prepare: viewer beside the questions, ${ivControls} controls, an upload answers ${ivWrite.status}; an interviewer with no round on him: record ${wr.status}, file ${wf.status}; ${shots.map((s) => `@${s.width}${s.horizontalScroll ? ' scrolls sideways' : ' fits'}`).join(', ')}`);
  } catch (e) { record('I1.6e', false, `read only: ${e.message.split('\n')[0]}`); }

  await greta.close();
  await resetMock();
}
