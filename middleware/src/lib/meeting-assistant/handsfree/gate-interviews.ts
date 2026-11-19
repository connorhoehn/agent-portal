// The voice gate's interviews family (runtime.ts `startHandsfreeRun` with `family: 'interviews'`): the real interviews policy
// (interviews/milo-policy.ts) over one live interview held in memory. `hugo` is on the panel, any `cand*` speaker is the candidate
// (the policy knows candidates by their guest id, so `cand` is `guest:cand` to it), a lead nobody plays. Nothing is stored: the
// interview, its settings, consent and said log are memory, and the policy's deps are pointed at them for this process.
import type { HandsfreeFamily, MeetingAssistantPolicy, PolicyCall } from '../policy.js';

export const GATE_INTERVIEW_ID = 'iv-gate';
/** The round's one question, as if Milo had asked it (the repeat line says it). */
export const GATE_QUESTION = 'Write a function that returns the second largest number in a list.';

export interface GateInterviews {
  call: PolicyCall;
  policy: MeetingAssistantPolicy;
}

/** The candidate is a guest to the policy; everyone else keeps their id. */
export const policyIdOf = (userId: string): string => (userId.startsWith('cand') ? `guest:${userId}` : userId);

export async function gateInterviews(input: { callId: string; candidateMayAsk: boolean; nowMs?: () => number }): Promise<GateInterviews> {
  const [mp, tools, speak, store] = await Promise.all([
    import('../../interviews/milo-policy.js'), import('../../interviews/milo-tools/index.js'),
    import('../../interviews/speak/index.js'), import('../../interviews/speak/store.js'),
  ]);
  const now = input.nowMs ?? Date.now;
  const lobby = `interviews:interview:${GATE_INTERVIEW_ID}`;
  const call: PolicyCall = { callId: input.callId, lobby, tenant: 'interviews' };
  const started = now();
  const interview = {
    id: GATE_INTERVIEW_ID, leadId: 'gate-lead', panelIds: ['hugo'], state: 'live', type: 'technical', callId: input.callId, minutes: 45,
    scheduledAt: new Date(started - 15 * 60_000).toISOString(), questionIds: [], applicationId: 'app-gate',
  } as unknown as import('../../interviews/types.js').Interview;
  const said = new store.MemorySaidStore();
  await said.append({
    id: 'said-q1', interviewId: GATE_INTERVIEW_ID, callId: input.callId, kind: 'question', source: 'kit', questionId: 'q1', suggestionId: null,
    text: GATE_QUESTION, askedBy: 'gate-lead', saidAt: new Date(started - 10 * 60_000).toISOString(), posted: true, spoken: true,
  } as never);
  speak.setSaidStore(said);
  let ids = 0;
  speak.setSpeakDeps({ callOf: async () => input.callId, miloJoinedAt: async () => started - 15 * 60_000, newId: () => `said-${String(++ids).padStart(6, '0')}` });
  mp.setInterviewConsentSource(async () => ({ recording: true, transcription: true, milo: true }));
  tools.resetMiloTools();
  (await import('../../interviews/milo-tools/deps.js')).setMiloToolDeps({
    interview: async (id) => (id === GATE_INTERVIEW_ID ? interview : null),
    guestOf: async (u, id) => id === GATE_INTERVIEW_ID && u.startsWith('guest:cand'),
    settings: async () => ({ candidateMayAsk: input.candidateMayAsk, updatedBy: null, updatedAt: null }),
    questions: async () => [],
    surface: async () => null,
  });

  const base = mp.INTERVIEWS_MILO_POLICY;
  const fam = base.handsfree!(call) as HandsfreeFamily;
  const family: HandsfreeFamily = {
    ...fam,
    admit: (userId) => fam.admit(policyIdOf(userId)),
    ...(fam.heldAnswer ? { heldAnswer: (r: Parameters<NonNullable<HandsfreeFamily["heldAnswer"]>>[0]) => fam.heldAnswer!({ ...r, askedBy: policyIdOf(r.askedBy) }) } : {}),
  };
  const policy = Object.create(base, {
    handsfree: { value: () => family },
    acknowledgement: { value: () => 'in-call-notice' },
    ...(base.runTool ? { runTool: { value: (c: PolicyCall, r: { askedBy: string; name: string; args: unknown }) => base.runTool!(c, { ...r, askedBy: policyIdOf(r.askedBy) }) } } : {}),
  }) as MeetingAssistantPolicy;
  return { call, policy };
}
