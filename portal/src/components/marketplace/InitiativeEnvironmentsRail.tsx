// InitiativeEnvironmentsRail — where this initiative's code actually runs,
// and whether YOU can get in.
//
// The environments domain shipped complete on the backend — schema, provider,
// Cedar's EnterEnvironment with per-attribute conditions, the read-only
// workflow-runs feed — and nothing ever rendered it, so the whole thing was
// invisible: an SME "who has to get into a cluster and run commands" had no
// way to even see the clusters. This card is that surface, on the page where
// environments belong: the initiative that runs on them.
//
// Two ideas govern the shape:
//
//  - The access decision is Cedar's, per environment, per caller — so the
//    card ASKS (`GET /:id/access`) instead of guessing from the role, and
//    only when a row is expanded: reachability for every environment up
//    front would be N authorization calls to answer a question nobody asked
//    yet. A denied answer renders as the reason, not as a hidden row —
//    "you can see where it runs, not enter it" is the designed posture.
//
//  - Entering means a computer, not a browser. The grant is reachability;
//    getting in is `aws eks update-kubeconfig` (or SSM) from a microVM with
//    the environment's access role — so the expanded row hands you the
//    command and a link into the Lab, which is the bastion story the whole
//    domain was built for.

import { useEffect, useState } from 'react';

import { readDegraded } from '../../lib/degraded';
import { Link } from 'react-router';
import { Card, Chip, CodeBlock } from '@connorhoehnslalom/ui-components/shared';

interface Environment {
  id: string;
  orgProjectId: string;
  name: string;
  kind: string;
  status: string;
  rank: number;
  awsRegion: string | null;
  clusterName: string | null;
  namespace: string | null;
}

interface AccessDecision {
  allowed: boolean;
  reason?: string;
  accessRoleArn?: string | null;
  awsRegion?: string | null;
  clusterName?: string | null;
  namespace?: string | null;
}

interface WorkflowRun {
  id: number | string;
  name?: string;
  displayTitle?: string;
  status?: string;
  conclusion?: string | null;
  htmlUrl?: string;
  updatedAt?: string;
}

/** Status → tone, mirroring how the fleet paints its states. */
const STATUS_TONE: Record<string, 'success' | 'warning' | 'neutral' | 'danger'> = {
  active: 'success',
  provisioning: 'warning',
  degraded: 'danger',
  retired: 'neutral',
};

/**
 * The command an expanded row offers. eks gets kubeconfig; everything else
 * gets the assume-role, because that is the one step every kind shares.
 */
function entryCommand(env: Environment, access: AccessDecision): string {
  const role = access.accessRoleArn ?? '<access-role-arn>';
  if (env.kind === 'eks' && (access.clusterName ?? env.clusterName)) {
    const cluster = access.clusterName ?? env.clusterName;
    const region = access.awsRegion ?? env.awsRegion ?? 'us-east-1';
    const ns = access.namespace ?? env.namespace;
    return [
      `aws eks update-kubeconfig --name ${cluster} --region ${region} --role-arn ${role}`,
      ns ? `kubectl config set-context --current --namespace ${ns}` : null,
    ].filter(Boolean).join('\n');
  }
  return `aws sts assume-role --role-arn ${role} --role-session-name orgiq-env`;
}

function EnvironmentRow({ env }: { env: Environment }) {
  const [open, setOpen] = useState(false);
  const [access, setAccess] = useState<AccessDecision | null>(null);
  const [runs, setRuns] = useState<WorkflowRun[] | null>(null);
  // routes/environments.ts states this contract outright: `{ runs: [], repo,
  // degraded, error }` means "we could not ask GitHub", and is never to be
  // rendered as "this environment has no runs". Until now the rail did
  // exactly that — the Latest-runs block simply vanished.
  const [runsError, setRunsError] = useState<string | null>(null);
  const retired = env.status === 'retired';

  // Fetched on first expand, once — the answer does not change mid-visit, and
  // collapsing should not forget it.
  useEffect(() => {
    if (!open || access) return;
    let cancelled = false;
    fetch(`/api/environments/${env.id}/access`, { credentials: 'include' })
      .then(async (r) => {
        const body = (await r.json()) as AccessDecision & { error?: string };
        if (cancelled) return;
        if (r.ok) setAccess(body);
        else setAccess({ allowed: false, reason: body.error ?? `HTTP ${r.status}` });
      })
      .catch(() => { if (!cancelled) setAccess({ allowed: false, reason: 'could not reach the API' }); });
    fetch(`/api/environments/${env.id}/runs`, { credentials: 'include' })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as { runs?: WorkflowRun[] };
      })
      .then((body) => {
        if (cancelled) return;
        setRunsError(readDegraded(body));
        setRuns((body.runs ?? []).slice(0, 3));
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setRunsError(e instanceof Error ? e.message : 'could not reach the API');
        setRuns([]);
      });
    return () => { cancelled = true; };
  }, [open, access, env.id]);

  return (
    <div className="border-b border-border last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full text-left px-3 py-2 flex items-center gap-1.5 bg-transparent border-0 cursor-pointer hover:bg-surface-hover"
      >
        <Chip tone={STATUS_TONE[env.status] ?? 'neutral'} size="xs" dot={env.status === 'provisioning' ? 'pulse' : 'static'}>
          {env.status}
        </Chip>
        <span className="text-[12px] font-semibold text-text-primary">{env.name}</span>
        <Chip tone="neutral" size="xs" mono>{env.kind}</Chip>
        <div className="flex-1" />
        {env.clusterName && (
          <span className="text-[10.5px] text-text-tertiary font-mono truncate max-w-[140px]" title={env.clusterName}>
            {env.clusterName}
          </span>
        )}
        <span aria-hidden className="text-[10px] text-text-tertiary">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div className="px-3 pb-2.5 flex flex-col gap-2">
          {retired ? (
            // Recorded so a postmortem can ask where something used to run —
            // not so somebody can shell into it. Cedar forbids Enter here, so
            // the UI offers nothing it would only have to refuse.
            <div className="text-[11px] text-text-tertiary">
              Retired — kept for the record; no access.
            </div>
          ) : access === null ? (
            <div className="text-[11px] text-text-tertiary">Checking access…</div>
          ) : access.allowed ? (
            <>
              <div className="text-[11px] text-text-secondary">
                You can enter this environment. From a computer in the Lab:
              </div>
              <CodeBlock code={entryCommand(env, access)} language="bash" />
              <div>
                <Link
                  to="/admin/devbox"
                  className="text-primary no-underline hover:underline text-[11px]"
                  title="Open the Computer Lab — run the command from a microVM"
                >
                  open a computer →
                </Link>
              </div>
            </>
          ) : (
            <div className="text-[11px] text-text-tertiary">
              You can see where this runs, but not enter it{access.reason ? ` — ${access.reason}` : '.'}
            </div>
          )}

          {runsError && (
            <div className="text-[11px] text-danger leading-relaxed">
              Latest runs unknown — {runsError}. This environment may well be building.
            </div>
          )}

          {!runsError && runs && runs.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="text-[10px] font-semibold text-text-tertiary tracking-wide uppercase">Latest runs</span>
              {runs.map((r) => (
                <div key={r.id} className="flex items-center gap-1.5 min-w-0">
                  <Chip
                    tone={r.conclusion === 'success' ? 'success' : r.conclusion === 'failure' ? 'danger' : 'neutral'}
                    size="xs"
                  >
                    {r.conclusion ?? r.status ?? '—'}
                  </Chip>
                  {r.htmlUrl ? (
                    <a
                      href={r.htmlUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[11px] text-text-secondary no-underline hover:underline truncate"
                    >
                      {r.displayTitle ?? r.name ?? `run ${r.id}`}
                    </a>
                  ) : (
                    <span className="text-[11px] text-text-secondary truncate">{r.displayTitle ?? r.name ?? `run ${r.id}`}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function EnvironmentsRailCard({ initiativeId }: { initiativeId: string | undefined }) {
  const [envs, setEnvs] = useState<Environment[] | null>(null);

  useEffect(() => {
    if (!initiativeId) return;
    let cancelled = false;
    fetch(`/api/environments?projectId=${encodeURIComponent(initiativeId)}`, { credentials: 'include' })
      .then(async (r) => (r.ok ? ((await r.json()) as { environments?: Environment[] }) : { environments: [] }))
      .then((body) => {
        if (cancelled) return;
        setEnvs([...(body.environments ?? [])].sort((a, b) => a.rank - b.rank));
      })
      .catch(() => { if (!cancelled) setEnvs([]); });
    return () => { cancelled = true; };
  }, [initiativeId]);

  // Nothing registered → no card. An initiative without environments is a
  // normal state (planning-stage work), not an empty-state to apologise for.
  if (!envs || envs.length === 0) return null;

  return (
    <Card padding="none" className="overflow-hidden">
      <div className="px-3 py-2.5 border-b border-border flex items-center gap-2">
        <span className="text-xs font-semibold text-text-secondary tracking-wide select-none">ENVIRONMENTS</span>
        <div className="flex-1" />
        <Chip tone="neutral" size="xs" mono>{envs.length}</Chip>
      </div>
      {envs.map((env) => <EnvironmentRow key={env.id} env={env} />)}
    </Card>
  );
}
