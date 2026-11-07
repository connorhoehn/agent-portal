// The local worker's prompt carries the frozen session brief INSIDE the
// non-interactive framing (lib/local-work.ts frameLocalPrompt): framing first,
// the brief's exact bytes between markers, the task last and verbatim. The
// The end-to-end contract snapshots lived under docs/journeys/contracts and were removed with that tree.
import { BRIEF_BEGIN, BRIEF_END, frameLocalPrompt } from '../local-work.js';

const brief = { id: 'brief-job-1', sha256: 'a'.repeat(64), markdown: '# Session brief — wi-1\n\n## Runbooks for this work\n\nNo runbooks matched this work.\n' };
const task = 'Write the tenant cutover runbook with rollback.';

describe('frameLocalPrompt with a brief', () => {
  it('puts the brief inside the framing: framing, then the brief bytes, then the task', () => {
    const out = frameLocalPrompt(task, true, brief);
    expect(out.startsWith('You are running non-interactively')).toBe(true);
    expect(out).toContain(`${BRIEF_BEGIN}\n${brief.markdown.replace(/\n$/, '')}\n${BRIEF_END}`);
    expect(out.indexOf('Never stop to ask.')).toBeLessThan(out.indexOf(BRIEF_BEGIN));
    expect(out.indexOf(BRIEF_END)).toBeLessThan(out.indexOf('The task:'));
    expect(out.endsWith(task)).toBe(true);
  });

  it('names the brief by id and sha, so the run can be matched to what a person reads', () => {
    expect(frameLocalPrompt(task, true, brief)).toContain(`(brief-job-1, sha256 ${'a'.repeat(64)})`);
  });

  it('tells the run there is no lab command here, and where the report lines go instead', () => {
    expect(frameLocalPrompt(task, false, brief)).toContain('This machine has no `lab` command');
  });

  it('without a brief the framing is exactly what it was', () => {
    expect(frameLocalPrompt(task, true, null)).toBe(frameLocalPrompt(task, true));
    expect(frameLocalPrompt(task, true)).not.toContain(BRIEF_BEGIN);
  });
});
