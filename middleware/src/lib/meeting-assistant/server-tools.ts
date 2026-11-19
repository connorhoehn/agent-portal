// Milo's server tools: tools that run on the SERVER inside one call family's calls, never in a browser (no runner in the portal, no
// confirm card, no navigator), answered with a line the server holds. Nothing here names a family: a family registers its tools,
// and every trigger ends in the one runner below.
//
// A tool is one object (`ServerToolDef`): its schema for the background agent, the inventory's words, and the facts the generic code
// asks of it (`writes`, `slow`, `maxArgsBytes`, `repeatWindowMs`, `mayAsk`, `run`). A family (`ServerToolFamily`) is its lobby
// family, its tenants, its tools, and the few answers that are about the call rather than one tool (`context`, the background agent's
// instructions, the fallback sentence, the log of what Milo said). `registerServerTools` adds a family; `serverToolPolicy` derives the
// policy seam's tool answers from it (policy.ts `sessionTools`, `mayUseTool`, `runTool`, `maxToolArgsBytes`, `heldFallback`,
// `heldAcknowledgement`), so a family's policy spreads it in and writes no tool code of its own.
//
// The triggers: the live model's function call (the orchestrator's checks of a call, then the policy's `runTool`: via `model`), an
// exact phrase heard (`phraseTool`, then the runner: via `phrase`), a button on a page (via `button`), and later a typed request in
// the call chat (via `typed`). Each is `runServerTool`; nothing in it assumes a voice.
//
// Adding a tool: docs/interviews-tenant-plan.md, "Adding a Milo tool"; the smallest example is
// meeting-assistant/__tests__/server-tools.test.ts.
import type { JsonSchemaObject } from '../voice/catalogue.js';
import { responsesFunctionTools, voiceTool } from '../voice/catalogue.js';
import { familyOfLobby, type MeetingAssistantPolicy, type PolicyCall, type ServerToolRetry, type SessionTools } from './policy.js';
import { trace } from './trace.js';

/** What started a run: a phrase heard, the live model's function call, a button on a page, a typed request. */
export type ServerToolVia = 'phrase' | 'model' | 'button' | 'typed';

/** What a tool's run (or a refusal) has Milo say: the line, and the family's word for it in its own log. */
export interface ToolSaid<Kind extends string = string> {
  line: string;
  /** The family's kind for its log of what Milo said (interviews: the said log's `source`). */
  kind: Kind;
  /** Refused for something the model can put right: not the request's one run; `retryNote` is silent context for the model. */
  retryNote?: string;
  /** The tool logged the line itself (the family's log hook is not asked again). */
  logged?: boolean;
  /** The tool posted and said the line itself (a trigger with no call loop to say it, such as a button): how it went. */
  delivered?: string;
}

export interface ServerToolDef<Ctx, Kind extends string = string> {
  name: string;
  /** What the background agent reads. */
  description: string;
  parameters: JsonSchemaObject;
  /** What it does, and where, in the inventory's words (scripts/voice/inventory.mjs). */
  says: string;
  mapsTo: string;
  /**
   * It changes something. True: the call that runs it must be the asker's request beyond doubt (orchestrator.ts `clearlyAsked`:
   * one speaker, the name in the line, nobody between), and one writing tool runs at a time in a call (`ServerToolFamily.busy`).
   */
  writes: boolean;
  /** A slow tool: a request whose words match this gets the family's `acknowledgement` once the model has handed it over. */
  slow?: RegExp;
  /** The exact phrase that runs it with no model (argument-less tools only): true for an utterance that asks for it. */
  phrase?(text: string): boolean | Promise<boolean>;
  /** The largest arguments a call may carry. Absent: 4096 bytes. */
  maxArgsBytes?: number;
  /** The same asker's second run within this is not run (the phrase and the model's call heard for one request; a second phrase run is a re-ask and runs). Not for a button. */
  repeatWindowMs?: number;
  /** The family's spend part it may hold beyond the live session, or null. */
  spend: string | null;
  /** Offered to the live session of this call now? Absent: always. */
  offered?(ctx: Ctx): boolean;
  /** May this person have it run: yes; no, with the sentence they are told; or null, not one of this call's people (nothing said). */
  mayAsk(ctx: Ctx, askedBy: string): Promise<true | { refusal: string } | null>;
  /** Run it: what Milo says, or null for nothing. */
  run(ctx: Ctx, askedBy: string, args: unknown, via: ServerToolVia): Promise<ToolSaid<Kind> | null>;
}

export interface ServerToolFamily<Ctx, Kind extends string = string> {
  /** The lobby family (`<tenant>:<family>`, policy.ts `familyOfLobby`), e.g. `interviews:interview`. */
  family: string;
  /** The tenants whose calls are offered the tools. */
  tenants: readonly string[];
  tools: readonly ServerToolDef<Ctx, Kind>[];
  /** What the tools of this call work on (an interview), or null: no tools in this call now. */
  context(call: PolicyCall): Promise<Ctx | null>;
  /** What the live session's background agent is told about the tools in this call. */
  backendInstructions(ctx: Ctx): string | Promise<string>;
  /** The sentence for a request nothing answered: what this asker may ask, or null for nothing. */
  whatICanDo(ctx: Ctx, askedBy: string): Promise<string | null>;
  /** The family's log of what Milo is about to say (posted and said after it by whoever triggered the run). */
  log(ctx: Ctx, askedBy: string, said: ToolSaid<Kind>, via: ServerToolVia | 'held'): Promise<void>;
  /** Said when a writing tool is asked for while another is still running in the call. Absent: nothing. */
  busy?: string;
  /** Said when a writing tool fails. Absent: the failure is the caller's. */
  failed?: string;
  /** Said at once for a slow tool's request (`ServerToolDef.slow`), logged with the kind `ack`. Absent: nothing. */
  acknowledgement?: string;
  /** The family's clock (the repeat window). Absent: Date.now. */
  now?(): number;
}

/** A tool as registered: its definition, and the family it is in. */
export type RegisteredServerTool = ServerToolDef<unknown> & { kind: 'server'; family: string; tenants: readonly string[] };

/** The default cap of a tool's arguments, in bytes (orchestrator.ts MAX_ARGS_BYTES). */
export const DEFAULT_TOOL_ARGS_BYTES = 4096;

const families = new Map<string, ServerToolFamily<unknown>>();
const byName = new Map<string, RegisteredServerTool>();

/**
 * Register one family's server tools. One registration per family, and a tool's name is unique across every family (the live model
 * and the trace see only the name). Returns the unregistration (tests use it).
 */
export function registerServerTools<Ctx, Kind extends string>(f: ServerToolFamily<Ctx, Kind>): () => void {
  if (familyOfLobby(f.family) !== f.family) throw new Error(`not a lobby family: ${f.family}`);
  if (families.has(f.family)) throw new Error(`server tools are already registered for ${f.family}`);
  for (const t of f.tools) {
    if (voiceTool(t.name)) throw new Error(`a server tool cannot be named like a browser voice tool: ${t.name}`);
    if (t.phrase && t.writes) throw new Error(`a server tool with a phrase cannot write (the phrase path runs without a confirmation): ${t.name}`);
  }
  for (const t of f.tools) if (byName.has(t.name) || f.tools.filter((x) => x.name === t.name).length > 1) throw new Error(`a server tool is already named ${t.name}`);
  const family = f as unknown as ServerToolFamily<unknown>;
  families.set(f.family, family);
  for (const t of family.tools) byName.set(t.name, Object.freeze({ ...t, kind: 'server' as const, family: f.family, tenants: f.tenants }));
  return () => {
    if (families.get(f.family) !== family) return;
    families.delete(f.family);
    for (const t of family.tools) byName.delete(t.name);
  };
}

/** A family's registration, or null. */
export function serverToolsOf(family: string): ServerToolFamily<unknown> | null { return families.get(family) ?? null; }

/** A family's tools as registered, in its order (empty when it has none). */
export function registeredServerTools(family: string): RegisteredServerTool[] {
  return (families.get(family)?.tools ?? []).map((t) => byName.get(t.name)!).filter(Boolean);
}

/** A server tool by name, in whichever family registered it: what the orchestrator asks of a call (`writes`, `maxArgsBytes`). */
export function serverToolDef(name: string): RegisteredServerTool | undefined { return byName.get(name); }

const familyOfCall = (call: PolicyCall): ServerToolFamily<unknown> | null => {
  const family = familyOfLobby(call.lobby);
  return (family && families.get(family)) || null;
};

/** The argument-less tool of this family an utterance asks for, word for word (the first in the family's order); null when none. */
export async function phraseTool(family: string, text: string): Promise<RegisteredServerTool | null> {
  for (const t of families.get(family)?.tools ?? []) if (t.phrase && (await t.phrase(text))) return byName.get(t.name) ?? null;
  return null;
}

// ── The one runner ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** Per asker and tool: the last run that said something, and how it was asked. */
const recent = new Map<string, { at: number; via: ServerToolVia }>();
const writing = new Set<string>();
const scopeOf = (call: PolicyCall): string => call.lobby ?? call.callId;

/** Is one of the family's writing tools running in this call now? */
export const serverToolBusy = (call: PolicyCall): boolean => writing.has(scopeOf(call));

/** What a run comes to: the line to post and say (the trigger posts and says it), and whether it used up the request's run. */
export interface ServerToolRun { line: string; retry: boolean; note?: string; delivered?: string }

/**
 * Run tool `name` for `askedBy` in this call: the family's tool, its context, who may ask, the repeat window, one writing tool at a
 * time, the run, and the line logged by the family (unposted: the trigger posts and says it). Null: nothing to say (not one of this
 * family's tools, no tools in this call now, not one of its people, the same request heard twice).
 */
export async function runServerTool(call: PolicyCall, askedBy: string, name: string, args: unknown, via: ServerToolVia, opts?: { heardOnce?: boolean }): Promise<ServerToolRun | null> {
  const f = familyOfCall(call);
  const def = f?.tools.find((t) => t.name === name);
  if (!f || !def) return null;
  // The lobby names the family, but only the family's own tenants run its tools (a foreign tenant naming the lobby gets nothing).
  if (!f.tenants.includes(call.tenant)) return null;
  const note = (outcome: string): void => trace('server.tool', { family: f.family, name, via, outcome });
  const ctx = await f.context(call);
  if (ctx === null) { note('no-context'); return null; }
  const said = async (s: ToolSaid): Promise<ServerToolRun> => {
    if (!s.logged) await f.log(ctx, askedBy, s, via);
    return { line: s.line, retry: s.retryNote !== undefined, ...(s.retryNote !== undefined ? { note: s.retryNote } : {}), ...(s.delivered !== undefined ? { delivered: s.delivered } : {}) };
  };
  const may = await def.mayAsk(ctx, askedBy);
  if (may === null) { note('not-theirs'); return null; }
  if (may !== true) { note('refused'); return said({ line: may.refusal, kind: 'refusal' }); }
  const scope = scopeOf(call);
  if (def.repeatWindowMs !== undefined && via !== 'button') {
    const key = `${f.family}|${scope}|${askedBy}|${name}`;
    const now = f.now?.() ?? Date.now();
    // One request heard twice (the phrase and the model's call for it) runs once. Two phrase runs are two utterances: a re-ask
    // ("how much time is left?" again 15 s later) is answered (hands-free gate, 19 November: it got silence).
    const last = recent.get(key);
    // `heardOnce`: the caller hears each request once (hands-free judges a sentence once, and the model's call for a sentence it
    // answered is refused as unasked), so nothing it runs is the same request again.
    if (!opts?.heardOnce && last && now - last.at < def.repeatWindowMs && !(via === 'phrase' && last.via === 'phrase')) { note('repeat'); return null; }
  }
  // The repeat window is used up only by a run that said something.
  const used = (): void => {
    if (def.repeatWindowMs === undefined || via === 'button') return;
    recent.set(`${f.family}|${scope}|${askedBy}|${name}`, { at: f.now?.() ?? Date.now(), via });
    if (recent.size > 500) recent.delete(recent.keys().next().value as string);
  };
  if (!def.writes) {
    const out = await def.run(ctx, askedBy, args, via);
    note(out ? 'ran' : 'nothing');
    if (out) used();
    return out ? said(out) : null;
  }
  if (writing.has(scope)) { note('busy'); return f.busy !== undefined ? said({ line: f.busy, kind: 'refusal' }) : null; }
  writing.add(scope);
  try {
    const out = await def.run(ctx, askedBy, args, via);
    note(out ? 'ran' : 'nothing');
    if (out) used();
    return out ? await said(out) : null;
  } catch (e) {
    console.warn('[meeting-assistant] server tool failed', f.family, name, (e as Error)?.name ?? 'error');
    note('failed');
    if (f.failed === undefined) throw e;
    const failed = f.failed;
    return said({ line: failed, kind: 'refusal' }).catch(() => ({ line: failed, retry: false }));
  } finally {
    writing.delete(scope);
  }
}

/** A run as the policy seam's `runTool` answers it: the line, a retry, or null. */
export const policyAnswer = (out: ServerToolRun | null): string | ServerToolRetry | null =>
  (out === null ? null : out.retry ? { line: out.line, retry: true, ...(out.note !== undefined ? { note: out.note } : {}) } : out.line);

/** Tests: forget the repeat window and the writing tools in flight. */
export function resetServerTools(): void { recent.clear(); writing.clear(); }

// ── The policy seam's tool answers, from the registered family ──────────────────────────────────────────────────────────

const NO_TOOLS: SessionTools = Object.freeze({ tools: [], backendInstructions: '' });

/**
 * The six tool answers of the policy seam for one family, derived from its registration. `load`: imports the module that registers
 * the family (a policy that loads its tools lazily); asked before every answer but the synchronous `maxToolArgsBytes`, which is
 * only asked once a session that was offered the tools makes a call.
 */
export function serverToolPolicy(family: string, load?: () => Promise<unknown>): Pick<MeetingAssistantPolicy,
  'sessionTools' | 'mayUseTool' | 'runTool' | 'maxToolArgsBytes' | 'heldFallback' | 'heldAcknowledgement' | 'wholeRequest'> {
  const fam = async (): Promise<ServerToolFamily<unknown> | null> => { await load?.(); return families.get(family) ?? null; };
  const ofCall = async (call: PolicyCall): Promise<ServerToolFamily<unknown> | null> => (familyOfLobby(call.lobby) === family ? fam() : null);
  return {
    sessionTools: async (call) => {
      const f = await ofCall(call).catch(() => null);
      if (!f || !f.tenants.includes(call.tenant)) return NO_TOOLS;
      try {
        const ctx = await f.context(call);
        if (ctx === null) return NO_TOOLS;
        const tools = f.tools.filter((t) => t.offered?.(ctx) ?? true);
        return { tools: responsesFunctionTools(tools), backendInstructions: await f.backendInstructions(ctx) };
      } catch { return NO_TOOLS; }
    },
    mayUseTool: async (call, asker, tool) => {
      try {
        const f = await ofCall(call);
        const def = f?.tools.find((t) => t.name === tool);
        if (!f || !def || !f.tenants.includes(call.tenant)) return false;
        const ctx = await f.context(call);
        return ctx !== null && (await def.mayAsk(ctx, asker.userId)) !== null;
      } catch { return false; }
    },
    runTool: async (call, request) => {
      await ofCall(call);
      return policyAnswer(await runServerTool(call, request.askedBy, request.name, request.args, 'model'));
    },
    // A tool's phrase is a whole request (it matches the utterance word for word): heard, it needs no wait for more words.
    wholeRequest: async (call, request) => {
      try { return (await ofCall(call)) !== null && (await phraseTool(family, request)) !== null; } catch { return false; }
    },
    maxToolArgsBytes: (_call, tool) => families.get(family)?.tools.find((t) => t.name === tool)?.maxArgsBytes ?? DEFAULT_TOOL_ARGS_BYTES,
    heldFallback: async (call, request) => {
      try {
        const f = await ofCall(call);
        const ctx = f && f.tenants.includes(call.tenant) ? await f.context(call) : null;
        if (!f || ctx === null) return null;
        const line = await f.whatICanDo(ctx, request.askedBy);
        if (line === null) return null;
        await f.log(ctx, request.askedBy, { line, kind: 'refusal' }, 'held');
        return line;
      } catch { return null; }
    },
    heldAcknowledgement: async (call, request) => {
      try {
        const f = await ofCall(call);
        const slow = (f?.tools ?? []).filter((t) => t.slow?.test(request.text));
        if (!f || !f.tenants.includes(call.tenant) || f.acknowledgement === undefined || !slow.length) return null;
        const ctx = await f.context(call);
        if (ctx === null || serverToolBusy(call)) return null;
        for (const t of slow) {
          if ((await t.mayAsk(ctx, request.askedBy)) !== true) continue;
          await f.log(ctx, request.askedBy, { line: f.acknowledgement, kind: 'ack' }, 'held');
          return f.acknowledgement;
        }
        return null;
      } catch { return null; }
    },
  };
}
