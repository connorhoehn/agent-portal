import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { CapabilityDeniedFallback, PageSection } from '@connorhoehn/ui-components/shared';
import type { EmptyStateAction } from '@connorhoehn/ui-components/shared';
import { useSession } from '../lib/auth';
import { useFetch } from '../hooks/useFetch';
import { accessNextStep, noAccessReason, otherWorkspaceRefusal, rolesPhrase, workspaceName } from '../lib/pageAccess';
import type { Tenant } from '../lib/tenants.generated';
import { PAGES } from '../components/shell/portalCommands';
import { QuickAccessForm } from './projects/BudgetAccess';
import { mineUrl, openStatusText, quickRequestState, requestHref } from './projects/budgetAccessModel';
import type { AccessRequest } from '../lib/accessRequests';

// A route this role may not open (App.tsx `Gate`, UX walk 9 November 2026,
// defect 1). It used to redirect to the tenant's front door — for a member or
// the demo persona, the empty "My initiatives" view — with no word about why.
// Now the URL stays and the page says what it is, which role opens it and the
// one next step that exists today (lib/pageAccess.ts): switch into a role the
// session already holds, request the role through the in-tenant quick request,
// or ask an org-leader. The server still gates every read behind it.

/** The palette row a path belongs to (the longest path prefix), for the page's name and what it is for. */
export function pageForPath(pathname: string): { label: string; hint: string } | null {
  const hits = PAGES.filter((p) => { const base = p.path.split('?')[0]!; return pathname === base || pathname.startsWith(`${base}/`); });
  const best = hits.sort((a, b) => b.path.length - a.path.length)[0];
  return best ? { label: best.label, hint: best.hint } : null;
}

export default function NoAccessPage({ roles }: { roles: readonly string[] }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { session, setRole } = useSession();
  const page = pageForPath(pathname);
  const label = page?.label ?? 'This page';
  const step = accessNextStep(session, roles);
  // Only a requestable role asks the quick request route what this viewer already filed (and whether they can file).
  const mine = useFetch<{ items: AccessRequest[]; requestable?: false; reason?: string }>(step?.kind === 'request' ? mineUrl(step.itemId) : null);
  const [formOpen, setFormOpen] = useState(false);
  const [switching, setSwitching] = useState(false);

  const effective = step?.kind === 'request' && mine.data?.requestable === false ? accessNextStep(session, roles, { canRequest: false }) : step;
  const request = effective?.kind === 'request' ? quickRequestState(mine.data?.items) : null;
  const actions: EmptyStateAction[] = [];
  let status: string | null = null;
  if (effective?.kind === 'switch') {
    actions.push({ label: switching ? 'Switching…' : effective.label, onClick: () => { setSwitching(true); void setRole(effective.role).finally(() => setSwitching(false)); } });
  } else if (effective?.kind === 'request' && request) {
    if (request.kind === 'none') actions.push({ label: effective.label, onClick: () => setFormOpen(true) });
    else {
      status = request.kind === 'open' ? openStatusText(request) : request.kind === 'approved' ? 'Approved — being provisioned' : 'Granted — switch role from the header once it arrives';
      const href = requestHref(request.request.id, session?.grants);
      if (href) actions.push({ label: 'View request', onClick: () => navigate(href) });
    }
  }
  actions.push({ label: 'Back to home', variant: 'link', onClick: () => navigate('/') });

  const reason = noAccessReason(label, session?.role ?? 'signed out', roles);
  const next = effective?.kind === 'ask' ? `${effective.label}.` : status ? `${status}.` : effective?.kind === 'switch' ? `You also hold ${effective.role} here.` : '';
  return (
    <PageSection title={label}>
      <CapabilityDeniedFallback
        title={`${label} needs ${rolesPhrase(roles)}`}
        description={[page?.hint ? `${page.hint}.` : null, reason, next].filter(Boolean).join(' ')}
        actions={actions}
        testId="no-access"
      />
      {effective?.kind === 'request' && (
        <QuickAccessForm
          open={formOpen}
          itemId={effective.itemId}
          title={`Request ${effective.role} access`}
          doneTitle={`${effective.role} access requested`}
          intro={`${label} opens for ${rolesPhrase(roles)}. Your manager, then the role's steward, decide it in Access; once it is granted, switch to ${effective.role} from the header.`}
          testId="role-access"
          onClose={() => setFormOpen(false)}
          onFiled={() => { mine.refresh(); setFormOpen(false); }}
        />
      )}
    </PageSection>
  );
}

/**
 * A URL another workspace owns (App.tsx `RequireTenant` fallbacks). The URL stays, the page names the
 * workspace (never the page or its data), and "Switch workspace" appears only when the session holds a
 * grant there; switching lands back on this same URL (lib/pageAccess.ts `otherWorkspaceRefusal`).
 */
export function OtherWorkspacePage({ tenant }: { tenant: Tenant }) {
  const { pathname, search, hash } = useLocation();
  const navigate = useNavigate();
  const { session, enterContext } = useSession();
  const [switching, setSwitching] = useState(false);
  const refusal = otherWorkspaceRefusal(session, tenant);
  const actions: EmptyStateAction[] = [];
  if (refusal.canSwitch) {
    actions.push({
      label: switching ? 'Switching…' : 'Switch workspace',
      onClick: () => { setSwitching(true); void enterContext(tenant, undefined, `${pathname}${search}${hash}`).finally(() => setSwitching(false)); },
    });
  }
  actions.push({ label: 'Back to home', variant: 'link', onClick: () => navigate('/') });
  return (
    <PageSection title={`${workspaceName(tenant)} workspace`}>
      <CapabilityDeniedFallback title={refusal.title} description={refusal.description} actions={actions} testId="other-workspace" />
    </PageSection>
  );
}
