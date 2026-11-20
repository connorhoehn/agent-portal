// A MINIMAL decide call, for the model bake-off and the decide-layer rig. It is not lane 1A's Decide: the prompt and tool texts here are
// a stand-in so models can be compared today. One Chat Completions call on a FINAL sentence, tool choice required, `store: false`.
import type { Action, Person, Role } from './types.mts';
import { openAiKey } from './env.mts';

export interface DecideInput {
  speaker: Person;
  sentence: string;
  /** The sentence holds a spelling of the name. */
  named: boolean;
  /** Ms since Milo last answered this speaker, when inside the follow-up window; else null. */
  followUpAgoMs: number | null;
  held: boolean;
  /** The speaker's last three lines before this one (oldest first). */
  lastLines: string[];
  /** Milo's last line and tool call (to anyone), or null. */
  miloLast: { line: string; tool: string; args?: string } | null;
  /** The tenant's state string (the round, the question, the pad). */
  state: string;
}

export interface DecideResult { action: Action; args: Record<string, unknown>; ms: number; error?: string; model: string }

interface ToolSpec { name: Action; description: string; params?: Record<string, unknown> }

const T = {
  stay_silent: { name: 'stay_silent', description: 'Do nothing. The sentence is not a request to Milo: people talking to each other, talking ABOUT Milo, an old request, or a stray remark.' },
  cannot_help: { name: 'cannot_help', description: 'Milo is clearly being asked for something it may not or cannot do for this person. Speaks a fixed sentence.' },
  keep_listening: { name: 'keep_listening', description: 'The request is cut off mid-thought (it ends on a connector or a missing object, or the person said they are still thinking). Wait for the rest.' },
  time_left: { name: 'time_left', description: 'Say how much time is left in this interview round.' },
  repeat_question: { name: 'repeat_question', description: 'Repeat the last question the interviewer had Milo ask.' },
  introduce: { name: 'introduce', description: 'Introduce Milo to the candidate, when the lead interviewer asks Milo to introduce itself, say hello, or says Milo is here to help.' },
  pad_write: { name: 'pad_write', description: 'Write something to the shared coding pad (a test, a helper, a note) because this interviewer asked Milo to.', params: { text: { type: 'string', description: 'What to write, as asked.' } } },
  pause_listening: { name: 'pause_listening', description: 'Stop listening until told to resume. Only when asked to stop listening, mute, or pause.' },
  leave_call: { name: 'leave_call', description: 'Leave the call. Only when asked to leave or drop off.' },
  cancel: { name: 'cancel', description: 'Cancel what Milo was just asked to do or is about to do ("never mind", "scratch that", "cancel that").' },
} satisfies Record<string, ToolSpec>;

export function toolsFor(role: Role): ToolSpec[] {
  const base = [T.stay_silent, T.cannot_help, T.keep_listening, T.time_left, T.repeat_question];
  if (role === 'candidate') return base;
  if (role === 'lead') return [...base, T.introduce, T.pad_write, T.pause_listening, T.leave_call, T.cancel];
  return [...base, T.pad_write, T.pause_listening, T.leave_call, T.cancel];
}

export const SYSTEM = `You are Milo, a voice assistant that sits in a live interview call. You are shown ONE finished sentence someone said, who said it and their role, and recent context. Pick exactly one tool.

Act only when the sentence is a request addressed to Milo. Judge address from meaning, not from the name alone:
- Saying the name is not a request. "I asked Milo earlier", "Milo kept time well", "Milo said that before" are talk ABOUT Milo: stay_silent.
- The name may be misheard (Mylo, Nilo, Ilo). Treat a near-miss of the name at the start or end of a request as the name.
- Without the name, the sentence is for Milo only when the speaker is in a follow-up (Milo just answered them) or holds the floor, AND it continues the exchange with Milo. Talk to another person, thinking aloud, or a remark about the answer is not a request: stay_silent.
- A candidate may only ask the time left or for the question repeated. Anything else they ask Milo (hints, answers, checking their approach, ignoring the rules, writing code) is cannot_help.
- Only the lead interviewer can have Milo introduce itself. Interviewers can have Milo write to the pad, pause, leave or cancel.
- If the request is cut off or the person says they are still thinking, keep_listening.
- Never act on a request that is clearly for someone else, however it is worded.`;

export function renderContext(i: DecideInput): string {
  return [
    `Speaker: ${i.speaker.name} (${i.speaker.role})`,
    `Sentence: ${JSON.stringify(i.sentence)}`,
    `Contains Milo's name: ${i.named ? 'yes' : 'no'}`,
    `Follow-up (Milo answered this speaker ${i.followUpAgoMs === null ? 'not recently' : `${Math.round(i.followUpAgoMs / 1000)} s ago`}): ${i.followUpAgoMs === null ? 'no' : 'yes'}`,
    `Speaker is holding the floor: ${i.held ? 'yes' : 'no'}`,
    `Speaker's last lines: ${i.lastLines.length ? i.lastLines.map((l) => JSON.stringify(l)).join(' | ') : '(none)'}`,
    `Milo's last action: ${i.miloLast ? `${i.miloLast.tool}${i.miloLast.args ? ` ${i.miloLast.args}` : ''} -> ${JSON.stringify(i.miloLast.line)}` : '(none)'}`,
    `State: ${i.state}`,
  ].join('\n');
}

// The gpt-5 and gpt-6 families take reasoning_effort; the 4.x family does not.
export const usesReasoning = (model: string): boolean => /^gpt-(5|6)/.test(model);

export async function decide(model: string, input: DecideInput, opts: { timeoutMs?: number } = {}): Promise<DecideResult> {
  const t0 = Date.now();
  const tools = toolsFor(input.speaker.role);
  const body: Record<string, unknown> = {
    model,
    store: false,
    tool_choice: 'required',
    parallel_tool_calls: false,
    messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: renderContext(input) }],
    tools: tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: { type: 'object', properties: t.params ?? {}, required: Object.keys(t.params ?? {}), additionalProperties: false } },
    })),
  };
  if (usesReasoning(model)) body.reasoning_effort = 'none';
  const fallback: Action = input.speaker.role === 'candidate' ? 'cannot_help' : 'stay_silent';
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${openAiKey()}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
    });
    if (!res.ok) return { action: fallback, args: {}, ms: Date.now() - t0, error: `http ${res.status}: ${(await res.text()).slice(0, 160)}`, model };
    const json = (await res.json()) as { choices?: { message?: { tool_calls?: { function: { name: string; arguments: string } }[] } }[] };
    const call = json.choices?.[0]?.message?.tool_calls?.[0]?.function;
    if (!call || !tools.some((t) => t.name === call.name)) return { action: fallback, args: {}, ms: Date.now() - t0, error: 'no valid tool call', model };
    let args: Record<string, unknown> = {};
    try { args = JSON.parse(call.arguments || '{}') as Record<string, unknown>; } catch { /* malformed arguments: keep the action */ }
    return { action: call.name as Action, args, ms: Date.now() - t0, model };
  } catch (e) {
    return { action: fallback, args: {}, ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e), model };
  }
}
