// journey:interviews — the interviews tenant's walk (docs/interviews-tenant-plan.md, ledger: it starts with
// I1.1 and gains a step with each row that names one). Headless, on the mock world, through
// run-demo-moments.mjs (its own middleware and portal):
//
//   cd portal && JOURNEY_MIDDLEWARE_PORT=<mw> JOURNEY_PORTAL_PORT=<portal> npm run journey:interviews [-- --out <dir>]
//
// Steps (one PASS or FAIL line each, named by the ledger row they judge):
//   I0.5a  the recruiter signs in and lands on Candidates: all twelve applications, every opening
//   I0.5b  an interviewer lands on My interviews: their own desk, none of the other interviewer's alone
//   I0.5c  the second interviewer's desk shows the scorecard that is due, and none of the first's alone
//   I0.5d  an interviewer cannot open another interviewer's interview by its address, and opens their own
//   I0.5e  an interviewer at the recruiter's front door goes on to their own desk; a hiring manager's page refuses them
//   I0.5f  the hiring manager lands on My openings: the candidates on her two openings, none of the third's
//   I0.5g  a Work-only persona at an interviews address gets the other-workspace page, the address kept
//   I1.1   the three homes at 1440 and 1280 px: a table above the fold, no horizontal scroll
// Screenshots of each home at both widths go to --out.
// Pieces: every scripts/journeys/interviews/[0-9A-Z]*.mjs (not lib.mjs) runs in name order; its default export
// receives the shared context from interviews/lib.mjs. A lane adds a step by adding a piece, not by editing this file.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createContext } from './interviews/lib.mjs';

const ctx = await createContext();
const dir = fileURLToPath(new URL('./interviews/', import.meta.url));
const pieces = fs.readdirSync(dir).filter((f) => /^[0-9A-Z].*\.mjs$/.test(f) && f !== 'lib.mjs').sort();
try {
  for (const piece of pieces) {
    const mod = await import(pathToFileURL(path.join(dir, piece)).href);
    await mod.default(ctx);
  }
} catch (err) {
  ctx.record('journey', false, `stopped: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  await ctx.browser.close();
  fs.writeFileSync(path.join(ctx.out, 'interviews.json'), JSON.stringify(ctx.results, null, 2));
}
const passed = ctx.results.filter((r) => r.ok).length;
console.log(`journey:interviews ${passed} passed; ${ctx.results.length - passed} failed (screenshots in ${ctx.out})`);
process.exitCode = ctx.results.length > 0 && ctx.results.every((r) => r.ok) ? 0 : 1;
