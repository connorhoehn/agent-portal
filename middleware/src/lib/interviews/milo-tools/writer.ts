// The pad writer: turns one pad request, in the asker's words ("a test for the empty list"), into ONE call of the pad tools that
// already exist (pad_add_tests, pad_add_import, pad_add_helper), or nothing.
//
// On the turn contract Decide only routes: it picks `pad_write` and hands over what was asked for. It never writes code, and it never
// sees the pad. The writer does, at the moment of writing: one text call, forced to one tool, told the round's questions (as the
// thing not to solve) and the pad as it is now, exactly what the old live session's background agent was told (context.ts). What it
// returns is checked by the chosen tool's own run (the language at the moment of writing, the solution check, the limits), so the
// writer's words are never trusted. A timeout, an error, a refused hold or an unusable reply all read as nothing.
//
// Money: a hold under the interview's `tools` part before the model is asked, settled with what it cost; booked to the lead.
// `INTERVIEWS_COACH_MODEL=scripted` (the tenant's one switch) answers from the scripted rules and costs nothing.
import { randomBytes } from 'node:crypto';
import { estimateUsageCost } from '../../pricing.js';
import { Fence } from '../../untrusted-text.js';
import { requestToolChoice, type TextToolReply, type TextToolRequest } from '../../voice/openai-text.js';
import { makeCoachModel } from '../coach/model.js';
import { releaseInterviewSpend, reserveInterviewSpend, settleInterviewSpend } from '../spend.js';
import type { Interview, KitQuestion, PadLanguage } from '../types.js';
import { interviewBackendInstructions } from './context.js';
import { PAD_ADD_HELPER } from './pad-add-helper.js';
import { PAD_ADD_IMPORT } from './pad-add-import.js';
import { PAD_ADD_TESTS } from './pad-add-tests.js';
import { PAD_TOOL_ARGS_BYTES } from './schema.js';
import { INTERVIEW_SCRIPT_RULES } from './scripted.js';

/** The pad tools a request can become, in the order the writer is offered them. */
export const PAD_TOOLS = [PAD_ADD_TESTS, PAD_ADD_IMPORT, PAD_ADD_HELPER] as const;
export type PadToolName = typeof PAD_TOOLS[number]['name'];

export interface PadWriterInput { text: string; questions: readonly KitQuestion[]; pad: { text: string; language: PadLanguage } | null }
export interface PadWriterChoice { name: PadToolName; args: Record<string, unknown> }

/** The writer's model: MILO_PAD_WRITER_MODEL, else the same model Decide runs on by default. */
export const DEFAULT_PAD_WRITER_MODEL = 'gpt-5.4-mini';
export const PAD_WRITER_TIMEOUT_MS = 20_000;
export const PAD_WRITER_MAX_OUTPUT_TOKENS = 3000;
export const SCRIPTED_PAD_WRITER_MODEL = 'scripted-pad-writer';
export function padWriterModel(): string { return (process.env['MILO_PAD_WRITER_MODEL'] ?? '').trim() || DEFAULT_PAD_WRITER_MODEL; }
/** Rehearsals may keep the proactive coach scripted while independently exercising the live pad writer. */
export function scriptedPadWriter(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['MILO_PAD_WRITER_LIVE'] !== '1' && makeCoachModel().kind === 'scripted';
}

const NOTHING = 'nothing';
const WRITER_RULE = `One person in the interview asked Milo to put something on the code pad. Their request follows as data. Call exactly one tool: the pad tool that does what they asked, with its arguments written by you for the pad as it is now; or ${NOTHING} when the request is not for test cases, an import or a helper (a note, a comment, the question's answer, anything else). For test cases, put every kind of case the request names in "requested" and write at least one case for each (its "covers" set to that kind), even one the question has no single answer for, such as an empty input.`;

/** The request the writer's model gets. Exported for tests (what is, and is not, in it). */
export function padWriterRequest(input: PadWriterInput, model = padWriterModel()): TextToolRequest {
  const fence = new Fence();
  return {
    model,
    instructions: `${interviewBackendInstructions(input.questions, input.pad, fence)}\n\n${WRITER_RULE}`,
    input: `The request:\n${fence.wrap(input.text, { source: 'request', maxChars: 400 })}`,
    tools: [
      ...PAD_TOOLS.map((t) => ({ type: 'function' as const, name: t.name, description: t.description, parameters: t.parameters })),
      { type: 'function' as const, name: NOTHING, description: 'The request is not for test cases, an import or a helper.', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } },
    ],
    toolChoice: 'required',
    maxOutputTokens: PAD_WRITER_MAX_OUTPUT_TOKENS,
  };
}

/** The reply as one pad tool's call, or null (no call, `nothing`, a tool that is not a pad tool, arguments too large or not an object). */
export function padWriterChoice(reply: Pick<TextToolReply, 'call'>): PadWriterChoice | null {
  const call = reply.call;
  const def = call && PAD_TOOLS.find((t) => t.name === call.name);
  if (!call || !def || Buffer.byteLength(call.arguments, 'utf8') > PAD_TOOL_ARGS_BYTES) return null;
  try {
    const args: unknown = JSON.parse(call.arguments || '{}');
    return args && typeof args === 'object' && !Array.isArray(args) ? { name: def.name, args: args as Record<string, unknown> } : null;
  } catch { return null; }
}

/** The scripted writer (no model): the scripted session's own interview rules, first match. */
export function scriptedPadWrite(text: string): PadWriterChoice | null {
  for (const rule of INTERVIEW_SCRIPT_RULES) {
    const m = text.match(rule.match);
    const call = m ? (rule.run(m) as { call?: { name: string; args: unknown } }).call : undefined;
    const def = call && PAD_TOOLS.find((t) => t.name === call.name);
    if (def && call) return { name: def.name, args: call.args as Record<string, unknown> };
  }
  return null;
}

let request: (req: TextToolRequest, opts: { timeoutMs: number }) => Promise<TextToolReply> = requestToolChoice;
/** Tests: replace the writer's model call; `null` puts the real one back. */
export function setPadWriterRequest(next: typeof request | null): void { request = next ?? requestToolChoice; }

/** One pad request written as one pad tool's call, held and settled under the interview's cap. Never throws. */
export async function writePadRequest(interview: Pick<Interview, 'id' | 'leadId'>, input: PadWriterInput): Promise<PadWriterChoice | null> {
  const scripted = scriptedPadWriter();
  const model = scripted ? SCRIPTED_PAD_WRITER_MODEL : padWriterModel();
  const req = padWriterRequest(input, model);
  const estimate = { inputTokens: Math.ceil((req.instructions.length + req.input.length) / 3), outputTokens: PAD_WRITER_MAX_OUTPUT_TOKENS };
  const held = await reserveInterviewSpend({
    interviewId: interview.id, part: 'tools', key: `pad-writer-${randomBytes(6).toString('hex')}`,
    estimateUsd: (scripted ? 0 : estimateUsageCost(model, estimate)) ?? 0.02, expiresInMs: 60_000,
  }).catch(() => ({ ok: false as const }));
  if (!held.ok) return null;
  if (scripted) {
    await settleInterviewSpend({ sourceId: held.sourceId, costUsd: 0, basis: 'estimated', model, actorId: interview.leadId, provider: 'local' }).catch(() => undefined);
    return scriptedPadWrite(input.text);
  }
  let reply: TextToolReply;
  try { reply = await request(req, { timeoutMs: PAD_WRITER_TIMEOUT_MS }); } catch {
    // Not answered (a timeout, an error): nothing is known to have been spent; the hold goes back.
    await releaseInterviewSpend([held.holdId]).catch(() => undefined);
    return null;
  }
  const usage = reply.usage ? { inputTokens: reply.usage.input, outputTokens: reply.usage.output } : null;
  const cost = usage ? estimateUsageCost(model, usage) : null;
  await settleInterviewSpend({
    sourceId: held.sourceId, costUsd: cost, basis: cost === null ? 'unknown' : 'estimated', model, actorId: interview.leadId, provider: 'openai',
    ...(usage ?? {}),
  }).catch(() => undefined);
  return padWriterChoice(reply);
}
