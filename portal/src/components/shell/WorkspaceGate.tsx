import { Suspense, lazy } from 'react';
import { useLocation } from 'react-router';
import { LoadingState } from '@connorhoehn/ui-components/shared';
import { useSession } from '../../lib/auth';
import { tenantEnabled } from '../../lib/features';
import { mayOpenOwnerShell, pathOwner } from '../../lib/workspaceOwner';
import { BareFrame } from './BareFrame';
import { Layout } from './Layout';

const OtherWorkspacePage = lazy(() => import('../../pages/NoAccessPage').then((m) => ({ default: m.OtherWorkspacePage })));

/**
 * The layout route's element. A URL another workspace owns, opened by a session outside it (or by nobody),
 * is refused here, above the shell, so the page is a standalone one with none of the session's own
 * header, rail, footer or polls. Everything else gets the shell. The tenant trees' RequireTenant
 * fallbacks stay as the second line of defence.
 */
export function WorkspaceGate() {
  const { session, isLoading } = useSession();
  const { pathname } = useLocation();
  const owner = pathOwner(pathname);
  if (isLoading) return <LoadingState label="Loading session…" />;
  if (owner && tenantEnabled(owner) && !mayOpenOwnerShell(session, owner)) {
    return (
      <BareFrame>
        <Suspense fallback={<LoadingState label="Loading page…" />}>
          <OtherWorkspacePage tenant={owner} />
        </Suspense>
      </BareFrame>
    );
  }
  return <Layout />;
}
