// The canned document edit `dev:mock` streams for an instruction sent from an
// assessment document's composer dock in Agent mode (parity goal, decision 8).
//
// The reply is the assessment drafter's own document-command envelope
// (`validate_document_output`, agents/assessment-drafter/document_commands.py):
// `{summary, content, format: "markdown", source_spans, draft, published}`,
// with every source span a verbatim quotation of `document.text`. These tests
// pin that shape, the replace/insert choice, the registered fixture's `empty`
// scenario, and that every other question still reaches the keyword table.

jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', mock: { aurora: true, agentcore: true, guardrails: true, cloudwatch: true } },
}));

import { documentAgentEdits, documentEditReply } from '../document-agent-edits.js';
import { selectMockResponse } from '../responses.js';
import { fixtureRegistry } from '../core/index.js';

const TEXT = 'Scope\nThe assessment covers practices.\nNext steps';

function command(selection: { from: number; to: number; text: string } | null, mode = 'suggest-confluence-content') {
  return JSON.stringify({
    mode,
    instruction: 'Tighten this',
    document: { id: 'page:100002', title: 'SDLC Assessment Program', text: TEXT, truncated: false, selection },
  });
}

afterEach(() => { fixtureRegistry.resetAll('default'); documentAgentEdits.reset(); });

describe('documentEditReply', () => {
  it('replaces a selection with the drafter envelope, quoting the selection verbatim', () => {
    const reply = JSON.parse(documentEditReply(command({ from: 8, to: 41, text: 'The assessment covers practices.' }))!);
    expect(Object.keys(reply).sort()).toEqual(['content', 'draft', 'format', 'published', 'source_spans', 'summary']);
    expect(reply).toMatchObject({ format: 'markdown', draft: true, published: false, summary: 'Tightens the selected passage' });
    expect(reply.content).toMatch(/SDLC practice/);
    expect(reply.source_spans).toEqual(['The assessment covers practices.']);
    for (const span of reply.source_spans) expect(TEXT.includes(span)).toBe(true);
  });

  it('inserts at the cursor when nothing is selected, quoting the first line', () => {
    const reply = JSON.parse(documentEditReply(command(null))!);
    expect(reply.summary).toBe('Adds a next step at the cursor');
    expect(reply.source_spans).toEqual(['Scope']);
  });

  it('is deterministic', () => {
    expect(documentEditReply(command(null))).toBe(documentEditReply(command(null)));
  });

  it('answers the drafter error envelope when the fixture is empty', () => {
    fixtureRegistry.resetAll('empty');
    expect(documentAgentEdits.rows()).toEqual([]);
    const reply = JSON.parse(documentEditReply(command(null))!);
    expect(reply).toEqual({ agent: 'assessment-drafter', error: expect.any(String) });
  });

  it('ignores anything that is not a document edit command', () => {
    expect(documentEditReply('Who knows auth best?')).toBeNull();
    expect(documentEditReply('{"mode":"story","document":{"text":"x"}}')).toBeNull();
    expect(documentEditReply('{"mode":"suggest-confluence-content"}')).toBeNull();
    expect(documentEditReply('{not json')).toBeNull();
  });
});

describe('selectMockResponse', () => {
  it('reads the command from the structured input, the message staying the instruction', () => {
    const m = selectMockResponse('Tighten this', JSON.parse(command(null)));
    expect(JSON.parse(m.response).summary).toBe('Adds a next step at the cursor');
    expect(selectMockResponse('Tighten this').response).not.toMatch(/"format"/);
  });

  it('routes a document command to the edit, with no tool calls', () => {
    const m = selectMockResponse(command(null));
    expect(m.toolCalls).toEqual([]);
    expect(JSON.parse(m.response).format).toBe('markdown');
  });

  it('keeps the keyword table for every other question', () => {
    expect(selectMockResponse('Find Kubernetes experts').response).toMatch(/Theo Chang/);
  });
});
