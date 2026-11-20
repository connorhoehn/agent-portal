// The meeting assistant's policy seam (docs/interviews-tenant-plan.md, row I3.1): every decision about Milo that can differ by the kind
// of call it is in, answered in one place.
//
// A call's lobby names its family: lobbies are `<tenant>:<family>:<id>` (`orgiq:initiative:p-auth`, `orgiq:dm:u-a:u-b`,
// `social:ch:general`, `assessment:team:TEAM-1`, `interviews:interview:iv-1`), so the family is the lobby's first two segments. A call's
// lobby comes from the call store (`CallChatRuntime.lobbyOf`) and is kept on the assistant's record (`AssistantRecord.lobby`), so
// everything after the invite reads it from the record. Each family may register one policy; a family with none registered gets
// DEFAULT_POLICY, which is today's behaviour, Work's, for every lobby Milo can be invited into.
//
// What stays outside the seam on purpose: the routes' tenant gate and the Cedar grant to invite (`requireAction('InviteMeetingAssistant')`)
// stay on the route declarations, where the voice inventory reads them; a policy narrows who may invite per call (`inviteRefusal`)
// after Cedar has said yes. The tenant gate lets a Work session through to Work's calls and an interviews session through to an
// interview's call only (routes/meeting-assistant.ts `staffTenantGate` and `callTenantAgrees`).
//
// Shape: a new family's rules are a new policy object registered here, never a new branch in the orchestrator or the routes.
import type { SpendSource } from '../../providers/spend-ledger.js';
import type { ResponsesFunctionTool } from '../voice/catalogue.js';
import { MEETING_EXCLUDED_TOOLS, meetingBackendInstructions, meetingFunctionTools, meetingTools } from './instructions.js';
import { assistantLimits, type AssistantLimits } from './limits.js';
import { assistantStore } from './store-select.js';
import type { AssistantRecord, MinutesRecord } from './types.js';
import type { Admission } from './handsfree/types.js';
import type { TurnPolicy } from './turn/types.js';

/** The call a decision is about. */
export interface PolicyCall {
  callId: string;
  /** The call's lobby name; null when nothing holds it any more (the call ended and no record names it). */
  lobby: string | null;
  /** The tenant of the call's record (the inviter's), or of the person inviting when there is no record yet. */
  tenant: string;
}

/** A person a decision is about. */
export interface PolicyPerson { userId: string; tenant: string }

/** What one person may read of a call's record. Each answer is all or nothing for that part; "no" is the same 404 as no record at all. */
export interface ReadAccess {
  /**
   * The call's record as someone who was there: its proposals (beyond the ones that name them or make them the executor), the lines
   * Milo heard for each, and, for a person who invited Milo, deleting the record.
   */
  record: boolean;
  /** The stored lines of what was said. */
  transcript: boolean;
  /** The minutes Milo wrote, and asking for them to be written again. */
  minutes: boolean;
}

/** Whose money a hold or a ledger row is: the person whose budget it counts against, the initiative it is charged to, and its source. */
export interface Payer { actorId: string; initiativeId: string | null; source: SpendSource }

/** What the live session is offered: its function tools, and the second model's instructions about them. */
export interface SessionTools { tools: readonly ResponsesFunctionTool[]; backendInstructions: string }

/**
 * A server tool's outcome that does not use up the request's one run (`runTool`): refused for something the model can put right
 * (the pad's language changed since it was told), with `note`, silent context for the model, so a call made again can succeed.
 */
export interface ServerToolRetry { line: string; retry: true; note?: string }

/**
 * The turn owner's tenant contract (turn/types.ts `TurnPolicy`) rides on the policy as optional members: a family that has adopted the
 * turn owner supplies all the required ones, and `turnPolicyOf` hands the complete contract to the turn (null otherwise).
 */
export interface MeetingAssistantPolicy extends Partial<TurnPolicy> {
  /** A name for logs and tests. */
  readonly id: string;
  /**
   * Who may invite Milo into this call, turn its voice on and add to its time, beyond the Cedar grant the routes ask first: null when
   * this person may, else the plain sentence they are refused with (403).
   */
  inviteRefusal(person: PolicyPerson & { role: string }, call: PolicyCall): Promise<string | null>;
  /**
   * What this person may read of the call's record. `seated`: they hold a seat in the running call now. `role`: their role in their
   * session's tenant, when the reader has a session (a family whose readers are decided by role reads it; the default does not). A
   * policy that must look something up answers with a promise.
   */
  reads(viewer: PolicyPerson & { seated: boolean; role?: string }, record: AssistantRecord): ReadAccess | Promise<ReadAccess>;
  /**
   * Whose budget pays for a listening period, its extensions, its minutes and its decision checks. `inviterId` is the person who
   * invited Milo into that period; `initiativeId` is the call's initiative, when it has one.
   */
  payer(call: PolicyCall, period: { inviterId: string; initiativeId: string | null }): Payer;
  /**
   * The tools the live session of this call is offered, and what its background agent is told. An empty list offers none. Asked
   * when a session starts (a family that tells the agent about the call's state answers with a promise; a new session asks again).
   */
  sessionTools(call: PolicyCall): SessionTools | Promise<SessionTools>;
  /**
   * May Milo run `tool` for this asker (their roles in the call's tenant)? Never for anyone is "no tools"; never for one person is
   * "none for them". A family that decides from its own records (an interview: lead, panel, candidate) answers with a promise.
   */
  mayUseTool(call: PolicyCall, asker: { userId: string; roles: readonly string[] }, tool: string): boolean | Promise<boolean>;
  /**
   * Run one of the family's SERVER tools (server-tools.ts; `serverToolPolicy` derives this from a registered family) for this
   * asker, after every check the orchestrator makes of a call: no browser turn and no confirm card. The answer is the line to post with the approved mark and say as approved
   * words (logged by the family, unposted, as `answerFromHeldText` logs its own), or null for nothing to say. Absent: the family
   * has no server tools, and a call naming one is refused as unknown.
   */
  runTool?(call: PolicyCall, request: { askedBy: string; name: string; args: unknown }): Promise<string | ServerToolRetry | null>;
  /** The largest arguments, in bytes, a call to `tool` may carry in this family's calls. Absent: MAX_ARGS_BYTES (orchestrator.ts). */
  maxToolArgsBytes?(call: PolicyCall, tool: string): number;
  /**
   * A request `answerFromHeldText` did not answer goes to the live model, which may answer it with a tool call. When no call from
   * that asker arrives in time (`heldFallbackWait`: before any delegation, and once the model has handed the request to its
   * background agent), this is asked for the fixed line to post and say instead; null: nothing. Absent: nothing is said.
   */
  heldFallback?(call: PolicyCall, request: { askedBy: string; text: string }): Promise<string | null>;
  readonly heldFallbackWait?: { quietMs: number; delegatedMs: number };
  /**
   * While waiting for that call: once the model has handed the request to its background agent, a short line to say at once (a
   * slow tool's "On it."), logged by the family like its other held lines; null: nothing. Asked once a request. Absent: nothing.
   */
  heldAcknowledgement?(call: PolicyCall, request: { askedBy: string; text: string }): Promise<string | null>;
  /**
   * Where this person's acknowledgement that Milo transcribes them comes from: the notice in the call (they press it; the inviter
   * acknowledges by inviting), or somewhere else, which `acknowledgedElsewhere` answers. Until a person has acknowledged, nothing they
   * say is stored or heard.
   */
  acknowledgement(call: PolicyCall, userId: string): 'in-call-notice' | 'elsewhere';
  /** For people whose acknowledgement comes from elsewhere: which of `userIds` gave it. Absent: none did. */
  acknowledgedElsewhere?(call: PolicyCall, userIds: readonly string[]): Promise<string[]>;
  /**
   * Whose stored lines Milo's models may read: the live session's context when it opens, the minutes and the decision checks. A
   * predicate on a line's speaker (null: a line with no single speaker). Lines it refuses stay stored, and people still read them
   * under `reads`; only the models never see them. Absent: every line. (Interviews: a candidate who accepted the transcript and
   * declined Milo is transcribed, and Milo uses none of their lines.)
   */
  modelReadsSpeaker?(call: PolicyCall): Promise<(userId: string | null) => boolean>;
  /** Whether this person is told about the call outside it (the bell: private answers, proposals that need them, minutes ready). */
  rings(call: PolicyCall, userId: string): boolean;
  /**
   * The portal path of the page where this call's notes are read, for the bell's link ("Minutes are ready", a proposal that needs
   * someone). The notification service refuses a link outside the tenant's own paths, so a family whose pages are not Work's names
   * its own. Absent: Work's meeting page (`/iq/meetings/<callId>`).
   */
  meetingPath?(call: PolicyCall): string;
  /** Whether this meeting is in this person's Meetings list. */
  listsMeeting(minutes: MinutesRecord, userId: string): boolean;
  /** Whether what the live model says reaches the call: its voice through the relay, and its words posted in the call chat. */
  relaysLiveSpeech(call: PolicyCall): boolean;
  /**
   * Hands-free Milo (MEETING_ASSISTANT_HANDSFREE; handsfree/rules.ts): what this family adds to the hands-free rules of a call.
   * Asked only under the flag, after the rules' own checks (Milo listening, the person acknowledged). Absent: everyone the rules
   * admit is routed, nothing is answered from held text, and the session gets no family rules (Work, Social).
   */
  handsfree?(call: PolicyCall): HandsfreeFamily;
  /**
   * A request answered from text the server holds, never by a model: the sentence to post for it, or null when it is not one of
   * the policy's fixed requests (it then goes to the model as usual). An empty string: one of them, handled, with nothing to say.
   * Absent: there are none.
   */
  answerFromHeldText?(call: PolicyCall, request: { askedBy: string; text: string }): Promise<string | null>;
  /**
   * Are these words (what followed Milo's name on one heard line) a whole request the family knows by its words, such as one of
   * its fixed phrases? The request detector then closes the request at once instead of waiting for more words: a two-word
   * "introduce yourself" otherwise waits out the detector's long wait. Absent: none are known.
   */
  wholeRequest?(call: PolicyCall, request: string): Promise<boolean>;
  /**
   * After a held answer was posted (with the approved mark) and offered to the call's voice as approved words (orchestrator.ts
   * `sayHeldText`): whether it was relayed. For the family's own log. Absent: nothing is noted.
   */
  heldTextSaid?(call: PolicyCall, said: { askedBy: string; text: string; posted: boolean; spoken: boolean; partly?: string }): Promise<void>;
  /**
   * Before a posted held answer is offered to the call's voice: the family's money check for the speech. A release to call once
   * the say is over, or null to keep the answer in the chat only (a reached cap). Absent: said with no check.
   */
  holdHeldSpeech?(call: PolicyCall, said: { askedBy: string; text: string }): Promise<{ release: () => Promise<void> } | null>;
  /**
   * The one fixed sentence `answerFromHeldText` answers a request it will not serve with. The same sentence for the same asker is
   * posted (and said) once, and again only after Milo has answered that asker something else: a request heard again (audio that
   * loops, a repeat minutes later) is not refused twice.
   */
  readonly heldRefusal?: string;
  /** How Milo's chat names a person this family knows and the directory does not (an interview's candidate); null: the directory's name. */
  displayName?(call: PolicyCall, userId: string): Promise<string | null>;
  /**
   * The family keeps its calls' stored words for its own period and removes them itself (the interviews retention: media 90 days,
   * or a deletion request). True: the meeting assistant's age sweep leaves the call's lines, minutes, turns, actions, record and
   * chat alone; the abandoned-call ending and the proposals' expiry still apply. Absent or false: the sweep removes them (Work).
   */
  readonly keepsOwnRetention?: boolean;
  /**
   * How many minutes Milo may listen to this call at most: the first ceiling and the most it can be extended to, in place of the
   * meeting assistant's own (limits.ts). Absent: the defaults. A policy that cannot work it out answers its most restrictive figure.
   */
  listeningLimitMinutes?(call: PolicyCall): Promise<number>;
  /**
   * Whose notes Milo writes, in the notices' own sentences (the chat's join and rejoin notices and the in-call acknowledgement).
   * Absent: MINUTES_WORDING, "minutes for the people in the call". An interview's call holds the candidate, who never reads them.
   */
  readonly minutesWording?: MinutesWording;
}

/** A family's part of the hands-free rules (policy `handsfree`). Every promise here is bounded by the rules (a late answer is `deny` or `mention`). */
export interface HandsfreeFamily {
  /** Who may have their audio routed (`route`), get server lines only (`fixed-lines`) or nothing (`deny`), asked at every trigger. */
  admit(userId: string): Promise<Admission>;
  /**
   * An addressed request answered from words the server holds, never by the model: the line to say, '' for handled with nothing
   * to say, null when it is not one (a routed person's request then goes to the model). A `fixed-lines` person's request is
   * always one: null from here gives them `refusal`.
   */
  heldAnswer?(request: { askedBy: string; text: string; admission: Exclude<Admission, 'deny'> }): Promise<string | null>;
  /**
   * Pure and synchronous (the frame path): could `heldAnswer` answer these words (the request after Milo's name)? False lets a
   * routed person's answer be relayed at its first frame, before the final verdict (review 1, item 9); it must be a superset of
   * what `heldAnswer` takes. Absent while `heldAnswer` exists: always maybe (never released early).
   */
  mayBeHeld?(request: { text: string }): boolean;
  /** What a `fixed-lines` person gets for anything `heldAnswer` does not answer. Absent: nothing is said. */
  readonly refusal?: string;
  /** The family's own rules for the hands-free session's instructions (instructions.ts `handsfree.familyRules`); null: none. */
  instructions(): string | null;
}

/** What Milo writes and for whom, after its name: the first period's words, and a later period's. No full stop. */
export interface MinutesWording { writes: string; adds: string }
export const MINUTES_WORDING: MinutesWording = Object.freeze({
  writes: 'writes minutes for the people in the call',
  adds: 'adds what it hears to the minutes for the people in the call',
});
/** The wording a lobby's policy gives its notices. */
export const minutesWordingOf = (lobby: string | null | undefined): MinutesWording => policyForLobby(lobby).minutesWording ?? MINUTES_WORDING;

/** Today's behaviour, for every lobby Milo can be invited into. */
export const DEFAULT_POLICY: MeetingAssistantPolicy = Object.freeze<MeetingAssistantPolicy>({
  id: 'default',
  // Anyone whose role holds InviteMeetingAssistant (the routes ask Cedar first).
  inviteRefusal: async () => null,
  // THE attendee rule: everyone who held an active seat while Milo was in the call reads its words, in the record's tenant; admins
  // get no exception. Seated now also counts for the record (its proposals and what Milo heard for them).
  reads: (viewer, record) => {
    const sameTenant = record.tenant === viewer.tenant;
    const attendee = sameTenant && record.attendees.includes(viewer.userId);
    return { record: sameTenant && (viewer.seated || attendee), transcript: attendee, minutes: attendee };
  },
  // The person who invited Milo into the period, on the call's initiative when it has one, under the meeting assistant's source.
  payer: (_call, period) => ({ actorId: period.inviterId, initiativeId: period.initiativeId, source: 'meeting_assistant' }),
  sessionTools: (call) => ({ tools: meetingFunctionTools(call.tenant), backendInstructions: meetingBackendInstructions(call.tenant) }),
  // The voice catalogue of the asker's own tenant and role, less what a meeting never offers.
  mayUseTool: (call, asker, tool) => !MEETING_EXCLUDED_TOOLS.has(tool) && asker.roles.some((role) => meetingTools(call.tenant, role).some((t) => t.name === tool)),
  acknowledgement: () => 'in-call-notice',
  rings: () => true,
  listsMeeting: () => true,
  relaysLiveSpeech: () => true,
  keepsOwnRetention: false,
});

const FAMILY = /^([a-z][a-z0-9-]{0,31}):([a-z][a-z0-9-]{0,31})(?::|$)/;

/** A lobby's family, `<tenant>:<family>` (its first two segments), or null for a name that has none. */
export function familyOfLobby(lobby: string | null | undefined): string | null {
  const m = FAMILY.exec(lobby ?? '');
  return m ? `${m[1]}:${m[2]}` : null;
}

const policies = new Map<string, MeetingAssistantPolicy>();

/**
 * Register the policy of one lobby family (`interviews:interview`). One policy per family: a second registration is a mistake and
 * throws. Returns the unregistration (tests use it).
 */
export function registerMeetingAssistantPolicy(family: string, policy: MeetingAssistantPolicy): () => void {
  if (familyOfLobby(family) !== family) throw new Error(`not a lobby family: ${family}`);
  if (policies.has(family)) throw new Error(`a meeting assistant policy is already registered for ${family}`);
  policies.set(family, policy);
  return () => { if (policies.get(family) === policy) policies.delete(family); };
}

/** The families with a policy of their own. */
export function policyFamilies(): string[] { return [...policies.keys()].sort(); }

/** Is any family's policy registered? While none is, every call's policy is the default and nothing needs to be looked up. */
export function hasFamilyPolicies(): boolean { return policies.size > 0; }

/** The families whose policy keeps its own retention: the meeting assistant's age sweep leaves their calls alone (retention.ts). */
export function familiesKeepingOwnRetention(): string[] {
  return [...policies].filter(([, policy]) => policy.keepsOwnRetention === true).map(([family]) => family).sort();
}

/** The turn contract of a policy when it supplies every required member (turn/types.ts `TurnPolicy`), else null. */
export function turnPolicyOf(policy: MeetingAssistantPolicy): TurnPolicy | null {
  const p = policy;
  if (!p.roleOf || !p.toolsFor || !p.answersFreely || !p.instructions || !p.cannotHelp || !p.context || !p.mayHold || !p.logSpoken) return null;
  return p as MeetingAssistantPolicy & TurnPolicy;
}

/** The policy of a lobby: its family's, or the default. */
export function policyForLobby(lobby: string | null | undefined): MeetingAssistantPolicy {
  if (!policies.size) return DEFAULT_POLICY;
  const family = familyOfLobby(lobby);
  return (family && policies.get(family)) || DEFAULT_POLICY;
}

/**
 * The policy of a call by its id, and the call as it sees it, from the call's record (`tenant` stands in when there is none). With no
 * family registered it is the default, and nothing is read.
 */
export async function policyOfCall(callId: string, tenant: string): Promise<{ policy: MeetingAssistantPolicy; call: PolicyCall }> {
  if (!policies.size) return { policy: DEFAULT_POLICY, call: { callId, lobby: null, tenant } };
  const record = await assistantStore().get(callId).catch(() => null);
  return { policy: policyForLobby(record?.lobby), call: record ? policyCallOf(record) : { callId, lobby: null, tenant } };
}

/** Work's meeting page (`/iq/meetings/:callId`): where a call's notes are read unless its policy says otherwise. */
export const meetingPagePath = (callId: string): string => `/iq/meetings/${encodeURIComponent(callId)}`;
/** Where the bell sends someone for this call's notes: its policy's page, else Work's meeting page. */
export const meetingPathOf = (policy: MeetingAssistantPolicy, call: PolicyCall): string => policy.meetingPath?.(call) ?? meetingPagePath(call.callId);

/** The lines Milo's models may read of this call (`modelReadsSpeaker`): all of them by default; none when the policy cannot answer. */
export async function linesForModels<L extends { userId: string | null; speakers?: readonly string[] }>(
  record: Pick<AssistantRecord, 'callId' | 'lobby' | 'tenant'>, lines: readonly L[],
): Promise<L[]> {
  const policy = policyForLobby(record.lobby);
  if (!policy.modelReadsSpeaker) return [...lines];
  const may = await policy.modelReadsSpeaker(policyCallOf(record)).catch(() => null);
  if (!may) return [];
  return lines.filter((l) => may(l.userId) && (l.speakers ?? []).every((u) => may(u)));
}

/** The call a record is about, as the policy sees it. */
export const policyCallOf = (record: Pick<AssistantRecord, 'callId' | 'lobby' | 'tenant'>): PolicyCall =>
  ({ callId: record.callId, lobby: record.lobby, tenant: record.tenant });

/** Who pays for a period of this record's call that `inviterId` invited Milo into (the record's own inviter when absent). */
export function payerOf(record: Pick<AssistantRecord, 'callId' | 'lobby' | 'tenant' | 'initiativeId' | 'invitedBy'>, inviterId: string = record.invitedBy): Payer {
  return policyForLobby(record.lobby).payer(policyCallOf(record), { inviterId, initiativeId: record.initiativeId });
}

/** The payer as the spend calls take it: `inviterId` is the person whose budget it is, `source` the ledger's source. */
export function payerFields(record: Pick<AssistantRecord, 'callId' | 'lobby' | 'tenant' | 'initiativeId' | 'invitedBy'>, inviterId?: string): { inviterId: string; initiativeId: string | null; source: SpendSource } {
  const payer = payerOf(record, inviterId);
  return { inviterId: payer.actorId, initiativeId: payer.initiativeId, source: payer.source };
}

/** The limits that apply to this call: the meeting assistant's own, or, when the call's policy sets a listening limit, that limit as both the first ceiling and the most. */
export async function limitsOfCall(call: PolicyCall): Promise<AssistantLimits> {
  const base = assistantLimits();
  const policy = policyForLobby(call.lobby);
  if (!policy.listeningLimitMinutes) return base;
  const minutes = await policy.listeningLimitMinutes(call).catch(() => null);
  if (minutes === null || !Number.isFinite(minutes) || minutes <= 0) return base;
  const seconds = Math.round(minutes * 60);
  return { ...base, maxSeconds: seconds, hardMaxSeconds: seconds };
}

/** Does this call's policy fix its listening limit (so that the limit is the call's end, not a default)? */
export const hasFixedListeningLimit = (lobby: string | null | undefined): boolean => policyForLobby(lobby).listeningLimitMinutes !== undefined;
