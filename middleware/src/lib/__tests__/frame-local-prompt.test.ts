// A run that ends by asking a question has not done the work.
//
// The dispatch route builds a local job's prompt from the work item's title
// and description; the worker hands it to `claude -p`, which has no stdin to
// answer from. A real run ended in 2.5 seconds with "the tenant cutover order
// is still unresolved … Want me to draft the runbook with the sequencing left
// as a TODO? Or should I wait?" — parked in review, carrying a question the
// review screen cannot answer.

import { frameLocalPrompt } from '../local-work.js';

describe('frameLocalPrompt', () => {
  const task = 'Write the tenant cutover runbook with rollback.';

  it('says nobody is listening, so a question ends the run', () => {
    const out = frameLocalPrompt(task, true);
    expect(out).toContain('non-interactively');
    expect(out).toContain('nobody to answer a question');
  });

  it('tells the run what to do with an ambiguity instead of asking', () => {
    const out = frameLocalPrompt(task, true);
    expect(out).toContain('choose the most reasonable option');
    expect(out).toContain('Never stop to ask.');
  });

  it('keeps the original task verbatim, at the end', () => {
    const out = frameLocalPrompt(task, true);
    expect(out.endsWith(task)).toBe(true);
    // The framing precedes the task; the task is never edited into it.
    expect(out).toContain('The task:');
  });

  it('a reviewed run is told to surface its assumptions for the reader', () => {
    const out = frameLocalPrompt(task, true);
    expect(out).toContain('read the result afterwards');
    expect(out).not.toContain('Nobody will review');
  });

  it('an unreviewed run is told to take the conservative option', () => {
    const out = frameLocalPrompt(task, false);
    expect(out).toContain('Nobody will review this before it lands');
    expect(out).toContain('conservative option');
    // Either way it still has to finish: the instruction not to ask is not
    // conditional on anyone reviewing.
    expect(out).toContain('Never stop to ask.');
  });

  it('an empty task still produces a framed prompt rather than bare framing', () => {
    // Defensive: the route only frames when `prompt` is a string, but a string
    // can be empty and the result must not read as a task-free instruction.
    const out = frameLocalPrompt('', true);
    expect(out).toContain('The task:');
  });

  it('is pure — the same input twice gives the same string', () => {
    expect(frameLocalPrompt(task, true)).toBe(frameLocalPrompt(task, true));
    expect(frameLocalPrompt(task, true)).not.toBe(frameLocalPrompt(task, false));
  });
});
