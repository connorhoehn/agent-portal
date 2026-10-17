// reviseWithAgent: the tenant's own mode is asked, a refusal falls back to the
// deterministic reviser, and under MOCK_AGENTCORE no agent is called.
jest.mock('../../../config.js', () => ({ config: { mock: { aurora: true, agentcore: true } } }));
import { config } from '../../../config.js';
import { agentcore } from '../../../providers/index.js';
import { reviseWithAgent } from '../service.js';
import { buildReviseInput } from '../narrative.js';
import type { DeckFacts } from '../plan.js';
import type { DeckSpec } from '@connorhoehn/realtime-modules/deck';

const spec: DeckSpec = { title: 'T', slides: [{ id: 's1', layout: 'bullets', title: 'Status', bullets: ['Progress is 62%.', 'Two items blocked.'] }] } as DeckSpec;
const facts = {
  teamId: 't', spec,
  slides: [{ slideId: 's1', kind: 'initiative-summary', facts: { progress: '62%' }, evidence: [{ id: 'e1', excerpt: 'Two items blocked.' }], prose: 'bullets', factBullets: [], maxProse: 3 }],
} as unknown as DeckFacts;
const input = buildReviseInput(spec, facts, 'make it shorter', 's1');

const TENANTS = [['orgiq', 'revise-initiative-status-deck'], ['pipelines', 'revise-pipeline-run-deck'], ['social', 'revise-social-deck'], ['assessment', 'revise-review-deck']] as const;
const setMock = (v: boolean) => { (config.mock as { agentcore: boolean }).agentcore = v; };

describe('reviseWithAgent', () => {
  const was = config.mock.agentcore;
  afterEach(() => { setMock(was); jest.restoreAllMocks(); });

  it.each(TENANTS)('%s asks its own mode with itself as the auth tenant', async (tenant, mode) => {
    setMock(false);
    const spy = jest.spyOn(agentcore, 'invokeAgent').mockResolvedValue({ text: JSON.stringify({ summary: 'ok', spec }) } as never);
    const out = await reviseWithAgent(tenant, input, facts, 'u1', 'orgiq-assessment-drafter');
    expect(out.engine).toBe('agent');
    expect(spy.mock.calls[0]?.[1]).toMatchObject({ structuredInput: { tenant, mode, auth: { tenant, sub: 'u1' }, instruction: 'make it shorter' } });
  });

  it('keeps the slide text, the instruction and the facts as separate context', async () => {
    setMock(false);
    const spy = jest.spyOn(agentcore, 'invokeAgent').mockResolvedValue({ text: '{}' } as never);
    await reviseWithAgent('social', input, facts, null, 'a');
    const sent = (spy.mock.calls[0]?.[1] as { structuredInput: Record<string, unknown> }).structuredInput;
    expect(sent['spec']).toEqual(spec);
    expect(sent['facts']).toEqual({ s1: { progress: '62%' } });
    expect(sent['instruction']).toBe('make it shorter');
  });

  it('falls back to the deterministic reviser on a refusal, an error or an empty answer', async () => {
    setMock(false);
    for (const impl of [async () => ({ text: '', raw: { error: 'forbidden' } }), async () => { throw new Error('down'); }, async () => ({ text: ' ' })]) {
      jest.spyOn(agentcore, 'invokeAgent').mockImplementation(impl as never);
      const out = await reviseWithAgent('orgiq', input, facts, 'u1', 'a');
      expect(out.engine).toBe('fallback');
      expect((out.answer as { changedSlideIds: string[] }).changedSlideIds).toEqual(['s1']);
    }
  });

  it('answers offline without calling the agent under MOCK_AGENTCORE, identically each time', async () => {
    setMock(true);
    const spy = jest.spyOn(agentcore, 'invokeAgent');
    const a = await reviseWithAgent('pipelines', input, facts, 'u1', 'a');
    const b = await reviseWithAgent('pipelines', input, facts, 'u1', 'a');
    expect(a.engine).toBe('offline');
    expect(a.answer).toEqual(b.answer);
    expect(spy).not.toHaveBeenCalled();
  });
});
