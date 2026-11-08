import { useLocation, useNavigate } from 'react-router';
import { Button, CommandPaletteHint, Inline, PageSection, T } from '@connorhoehn/ui-components/shared';
import { useSession } from '../lib/auth';
import { resolveHome } from '../lib/tenantHome';

// Catch-all for unmatched paths. Before this existed, a typo'd URL or a link
// to a removed route rendered a blank document — indistinguishable from the
// app being broken. Renders inside Layout so the rail stays usable.

export default function NotFoundPage() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { session } = useSession();
  // Wherever `/` would send them — one home resolution, not a local guess.
  const home = resolveHome(session);

  return (
    <PageSection title="Page not found">
      <T size="sm">
        Nothing lives at {pathname}. The link may be stale, or the page may
        have moved. Use the rail or search to find a page by name.
      </T>
      <Inline gap="sm">
        <Button onClick={() => navigate(home)}>← Back to home</Button>
        <CommandPaletteHint />
      </Inline>
    </PageSection>
  );
}
