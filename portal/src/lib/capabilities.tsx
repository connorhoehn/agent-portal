import { useEffect, useState, type ReactNode } from 'react';
import { useSession } from './auth';

/**
 * Portal-side mirror of the Cedar capability probe.
 *
 * GET /api/session/capabilities evaluates every portal action through the SAME
 * Cedar engine that gates the APIs and returns { role, tenant, degraded,
 * actions }. The UI renders an affordance iff the capability allows it OR
 * degraded === true (AVP outage: show controls, the server still decides
 * per-call). This hook is presentation only — the API gates remain the source
 * of truth.
 */

export type Action =
  | 'Search'
  | 'ViewOrgChart'
  | 'ViewLeaderboard'
  | 'ViewObservability'
  | 'ViewIdentityAdmin'
  | 'ManageUsers'
  | 'EditPolicy'
  | 'EditSchema'
  | 'EditGuardrail'
  | 'ManageDevbox'
  // The agent-code authorities split out of ManageDevbox (DE-42) — in
  // CAPABILITY_ACTIONS server-side. The probe answers for the sme permits'
  // conditions as if satisfied (on the initiative, owning the box, not the
  // author); the real route still refuses per instance (403 NOT_ON_INITIATIVE,
  // 409 self-approval), so a `true` here is "may ever", not "may this one".
  | 'OpenDevboxShell'
  | 'RunDevboxTask'
  // The lab's drive — start, rename, stop and remove a computer — split out of
  // ManageDevbox (11 Nov 2026) so a leader can drive the lab without configuring it.
  | 'OperateDevbox'
  | 'DecideAgentChange'
  | 'DeliverAgentChange'
  | 'ManageSdlcPolicies'
  | 'ManageBots'
  | 'DispatchAgentRun'
  | 'ManageIngest'
  | 'ManageKB'
  | 'ManageCanary'
  | 'LabelFeedback'
  | 'ApproveTransaction'
  | 'ManagePitches'
  | 'PublishArticle'
  | 'Masquerade'
  | 'ManageBudgets'
  | 'ManageSprints'
  | 'ConnectLocalCompute'
  // Runbooks — in CAPABILITY_ACTIONS server-side
  | 'ReviewRunbook'
  | 'DecideDecision'
  | 'ViewSessionBrief'
  // The voice navigator (docs/voice-navigator-spec.md §6) — in CAPABILITY_ACTIONS server-side
  | 'VoiceNavigate'
  // Assessment tenant (docs/assessment-tenant.md)
  | 'ViewAssessment'
  | 'ScoreAssessment'
  | 'ApproveException'
  | 'PublishReport'
  | 'ManageSubmissions'
  | 'RunAssessmentAgent'
  | 'ManageKnowledge'
  | 'ManageAssessmentConfig'
  // Social tenant (docs/social-tenant-design.md §4.1) — in CAPABILITY_ACTIONS server-side since S0
  | 'ViewSocial'
  | 'PostMessage'
  | 'StartCall'
  | 'ManageChannels'
  | 'ManageTeams'
  | 'ManageRecordings'
  | 'ManageSocialConfig'
  // Pipelines tenant (docs/pipelines-tenant-goal.md §Cedar) — in CAPABILITY_ACTIONS server-side
  | 'ViewPipelines'
  | 'AuthorDefinition'
  | 'RunPipeline'
  | 'ApproveStep'
  | 'CancelRun'
  | 'ManagePipelineConfig'
  // Access tenant (docs/access-tenant-goal.md §Cedar) — in CAPABILITY_ACTIONS server-side
  | 'ViewAccess'
  | 'RequestAccess'
  | 'DecideAccess'
  | 'ManageAccessCatalog'
  | 'ManageAccessPolicy'
  | 'ProvisionAccess';

interface CapabilitiesPayload {
  role: string;
  tenant: string;
  degraded: boolean;
  actions: Record<string, boolean>;
}

interface CapabilitiesState {
  /** Server answer, or null while loading / when anonymous (401). */
  payload: CapabilitiesPayload | null;
  /** True once the fetch settled (success, 401, or error) for the current key. */
  ready: boolean;
}

export interface Capabilities {
  /** True iff the affordance should render: allowed, or authz degraded. */
  can: (action: Action) => boolean;
  /** AVP outage — controls show, the server decides per call (503s). */
  degraded: boolean;
  /** Fetch in flight for the current session. While true, can() is false —
   * render nothing (no flash) until `ready`. */
  loading: boolean;
  /** Settled: safe to base rendering decisions on can(). */
  ready: boolean;
}

// Module-level cache: one fetch per session identity, shared by every
// consumer. Key is sub|role|tenant — any of those changing (login, role
// switch, tenant switch, masquerade) invalidates it. Hard redirects on switch
// wipe module state anyway; the key handles same-page refreshes.
let cache: { key: string; state: CapabilitiesState } | null = null;
let inflight: { key: string; promise: Promise<CapabilitiesState> } | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

async function fetchCapabilities(key: string): Promise<CapabilitiesState> {
  try {
    const res = await fetch('/api/session/capabilities', { credentials: 'include' });
    if (res.status === 401) {
      // Anonymous with SSO required — the app is behind the sign-in gate
      // anyway; expose nothing.
      return { payload: null, ready: true };
    }
    if (!res.ok) throw new Error(`${res.status}`);
    const payload = (await res.json()) as CapabilitiesPayload;
    return { payload, ready: true };
  } catch {
    // The capability probe itself is unreachable (middleware blip). Treat it
    // like a degraded authorizer: show controls and let each API call decide —
    // hiding everything here would make an outage look like revoked access.
    return { payload: { role: 'unknown', tenant: 'unknown', degraded: true, actions: {} }, ready: true };
  }
}

function load(key: string): Promise<CapabilitiesState> {
  if (cache && cache.key === key) return Promise.resolve(cache.state);
  if (inflight && inflight.key === key) return inflight.promise;
  const promise = fetchCapabilities(key).then((state) => {
    cache = { key, state };
    if (inflight && inflight.key === key) inflight = null;
    notify();
    return state;
  });
  inflight = { key, promise };
  return promise;
}

const EMPTY: CapabilitiesState = { payload: null, ready: false };

/**
 * Capability lookup for gating action affordances.
 *
 * Usage: `const { can, ready } = useCapabilities();` then render the button
 * only when `can('ManageDevbox')`. While loading, can() returns false and
 * `ready` is false — prefer rendering nothing over flashing the control.
 */
export function useCapabilities(): Capabilities {
  const { session } = useSession();
  const key = session ? `${session.sub}|${session.role}|${session.tenant}` : null;

  const [state, setState] = useState<CapabilitiesState>(() =>
    key && cache && cache.key === key ? cache.state : EMPTY,
  );

  useEffect(() => {
    if (!key) {
      setState(EMPTY);
      return;
    }
    let alive = true;
    const sync = () => {
      if (!alive) return;
      if (cache && cache.key === key) setState(cache.state);
    };
    listeners.add(sync);
    void load(key).then(() => sync());
    return () => {
      alive = false;
      listeners.delete(sync);
    };
  }, [key]);

  const degraded = state.payload?.degraded === true;
  return {
    can: (action: Action) => degraded || state.payload?.actions?.[action] === true,
    degraded,
    loading: !state.ready,
    ready: state.ready,
  };
}

/**
 * Declarative gate: renders children only when the capability allows the
 * action (or authz is degraded). Renders nothing while loading — no flash.
 */
export function Can({ do: action, children, fallback = null }: {
  do: Action;
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const { can, ready } = useCapabilities();
  if (!ready) return null;
  if (!can(action)) return <>{fallback}</>;
  return <>{children}</>;
}
