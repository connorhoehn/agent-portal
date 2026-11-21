// An explicit OpenAI recap backend, independent of the proactive coach's model selection.
// Uses the existing store:false transport and the same recap parser and source guards as Bedrock.
import { requestToolChoice, TextToolError, type TextToolRequest } from '../../voice/openai-text.js';
import { withDataRule } from '../../untrusted-text.js';
import type { CoachModelResult } from '../coach/model.js';
import type { RecapModel } from './model.js';
import { RECAP_SYSTEM_PROMPT, recapUserText, type RecapInput } from './prompt.js';

const TOOL = 'record_recap';
/** This backend selects source spans; it cannot invent a paraphrase that outruns its one cited line. */
export function extractedRecap(raw: string): string | null {
  try {
    const value: unknown = JSON.parse(raw);
    const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
    const keys = (v: Record<string, unknown>, wanted: string[]) => Object.keys(v).length === wanted.length && wanted.every((key) => key in v);
    if (!object(value) || !keys(value, ['competencies', 'notCovered']) || !Array.isArray(value['competencies'])
      || !Array.isArray(value['notCovered']) || !value['notCovered'].every((id) => typeof id === 'string')) return null;
    const competencies = [];
    for (const c of value['competencies']) {
      if (!object(c) || !keys(c, ['id', 'evidence']) || typeof c['id'] !== 'string' || !Array.isArray(c['evidence'])) return null;
      const evidence = [];
      for (const e of c['evidence']) {
        if (!object(e) || !keys(e, ['seq', 'quote']) || !Number.isInteger(e['seq']) || typeof e['quote'] !== 'string') return null;
        evidence.push({ text: 'The candidate said this.', seq: e['seq'], quote: e['quote'] });
      }
      competencies.push({ id: c['id'], evidence });
    }
    return JSON.stringify({ competencies, notCovered: value['notCovered'] });
  } catch { return null; }
}

export class OpenAIRecapModel implements RecapModel {
  readonly kind = 'openai' as const;
  readonly promptVersion = 'recap-extract-2026-11-20.1';
  readonly modelId: string;
  constructor(private readonly opts: { modelId?: string; request?: typeof requestToolChoice; timeoutMs?: number } = {}) {
    this.modelId = opts.modelId ?? (process.env['INTERVIEWS_RECAP_MODEL_ID']?.trim() || 'gpt-5.4-mini');
  }

  async write(input: RecapInput): Promise<CoachModelResult> {
    const req: TextToolRequest = {
      model: this.modelId,
      instructions: withDataRule(`${RECAP_SYSTEM_PROMPT}\nFor this extraction backend, the ${TOOL} schema replaces the JSON shape above: select only seq and quote for each evidence item. Do not write a summary or a text field. The application supplies a fixed neutral label beside the original quote. Each quote must be an exact span from ONE candidate line, at most 300 characters. Do not combine words across lines or repair transcription errors. Use the tool to return the selection.\nConsider every competency against the substantive answers, including explanations of implementation, tests and reasoning. A competency need not have its own tagged question: a technical explanation may bear on communication or code quality as well as problem solving. Leave a competency uncovered when there is no relevant answer. Courtesy, greetings, farewells and ANY line addressed to Milo are not competency evidence. Do not cite a time request or a request for Milo to write tests.`),
      input: recapUserText(input),
      toolChoice: 'required', maxOutputTokens: 3000,
      tools: [{ type: 'function', name: TOOL, description: 'Record only transcript-grounded candidate evidence.', parameters: {
        type: 'object', additionalProperties: false, required: ['competencies', 'notCovered'], properties: {
          competencies: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'evidence'], properties: {
            id: { type: 'string' }, evidence: { type: 'array', maxItems: 4, items: { type: 'object', additionalProperties: false, required: ['seq', 'quote'], properties: {
              seq: { type: 'integer' }, quote: { type: 'string', maxLength: 300 },
            } } },
          } } },
          notCovered: { type: 'array', items: { type: 'string' } },
        },
      } }],
    };
    try {
      const result = await (this.opts.request ?? requestToolChoice)(req, { timeoutMs: this.opts.timeoutMs ?? 30_000 });
      const raw = result.call?.name === TOOL ? extractedRecap(result.call.arguments) : null;
      return { raw, code: raw ? 'ok' : 'error', sent: true,
        usage: result.usage ? { inputTokens: result.usage.input, outputTokens: result.usage.output } : null };
    } catch (error) {
      return { raw: null, code: error instanceof TextToolError && error.kind === 'timeout' ? 'timeout' : 'error',
        sent: !(error instanceof TextToolError && error.kind === 'no-key'), usage: null };
    }
  }
}
