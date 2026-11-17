// Piece I1.8: behavioural rounds (docs/interviews-tenant-plan.md row I1.8). The Engineering Manager opening carries a
// behavioural kit: its Leadership round has no code pad, and its questions have follow-ups and no starter code.
//   I1.8a  Wen, who leads the Leadership rounds, reads the kit: Leadership has no code pad, System design has one;
//          the behavioural questions carry follow-ups and no starter code
//   I1.8b  in the recruiter's editor a behavioural question offers no starter code; the server refuses starter code on one
// Nothing is saved; the world is reset before and after all the same, as every writing piece does.
export default async function run({ portal, record, signIn, resetMock }) {
  await resetMock();

  // ── I1.8a: the interviewer reads the behavioural kit ────────────────────
  {
    const wen = await signIn('u-wen');
    const p = await wen.newPage();
    try {
      await p.goto(`${portal}/interviews/openings/op-em`, { waitUntil: 'domcontentloaded' });
      const rounds = p.getByTestId('interviews-kit-rounds');
      await rounds.getByText('Leadership', { exact: true }).waitFor({ timeout: 30_000 });
      const roundRows = await rounds.locator('tbody tr').allInnerTexts();
      const leadership = roundRows.find((r) => r.includes('Leadership')) ?? '';
      const design = roundRows.find((r) => r.includes('System design')) ?? '';
      const behavioural = p.getByTestId('interviews-kit-behavioural-questions');
      const questions = await behavioural.getByTestId('interviews-question-prompt').count();
      const rowsText = await behavioural.innerText();
      await behavioural.getByText(/two teams needed opposite things/).click();
      const detail = p.getByTestId('interviews-question-detail');
      await detail.waitFor({ timeout: 10_000 });
      const detailText = await detail.innerText();
      const ok = /No code pad/.test(leadership) && /Code pad/.test(design) && !/No code pad/.test(design) && questions === 5
        && !/Python|Swift|JavaScript|TypeScript|Java|Go\b|C\+\+/.test(rowsText) && /Follow-ups/.test(detailText) && /Who made the final call\?/.test(detailText)
        && !/starter code/i.test(detailText);
      record('I1.8a', ok, `Leadership "${leadership.replace(/\s+/g, ' ')}", System design "${design.replace(/\s+/g, ' ')}"; ${questions} behavioural questions, none with starter code; a question opens with its follow-ups`);
    } catch (e) {
      record('I1.8a', false, `behavioural kit: ${e.message.split('\n')[0]}`);
    }
    await wen.close();
  }

  // ── I1.8b: the editor and the server keep code off a behavioural question ─
  {
    const greta = await signIn('u-greta');
    const p = await greta.newPage();
    try {
      await p.goto(`${portal}/interviews/openings/op-em/edit`, { waitUntil: 'domcontentloaded' });
      const questions = p.getByTestId('interviews-kit-questions');
      await questions.getByText(/someone on your team who was struggling/).click();
      const form = p.getByTestId('interviews-kit-question-form');
      await form.waitFor({ timeout: 10_000 });
      const formText = await form.innerText();
      const addStarter = await form.getByTestId('interviews-kit-add-starter').count();
      const kit = (await (await greta.request.get(`${portal}/api/interviews/openings/op-em`)).json()).opening;
      const withCode = kit.questions.map((q, i) => (i === 0 ? { ...q, starter: { python: 'print("hello")\n' } } : q));
      const refused = await greta.request.put(`${portal}/api/interviews/openings/op-em/kit`, {
        data: { revision: kit.revision, kit: { rounds: kit.rounds, competencies: kit.competencies, questions: withCode } },
      });
      const body = await refused.json().catch(() => ({}));
      const sentence = (body.fields ?? []).map((f) => f.message).join(' ');
      const ok = /has no code pad, so this question carries no starter code/.test(formText) && addStarter === 0 && refused.status() === 400
        && /behavioural round, which has no code pad, so it cannot carry starter code/.test(sentence);
      record('I1.8b', ok, `editor on a behavioural question: no "Add starter code" (${addStarter}); the server answers ${refused.status()}: "${sentence}"`);
    } catch (e) {
      record('I1.8b', false, `behavioural editor: ${e.message.split('\n')[0]}`);
    }
    await greta.close();
  }

  await resetMock();
}
