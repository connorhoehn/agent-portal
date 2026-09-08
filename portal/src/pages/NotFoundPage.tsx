import { useLocation } from 'react-router';
import { EmptyState } from '@connorhoehnslalom/ui-components/shared';
import { useSession } from '../lib/auth';

// Catch-all for unmatched paths. Before this existed, a typo'd URL or a link
// to a removed route rendered a blank document — indistinguishable from the
// app being broken. Renders inside Layout so the rail stays usable.

export default function NotFoundPage() {
  const { pathname } = useLocation();
  const { session } = useSession();
  const home = session?.tenant === 'assessment' ? '/assessment/teams' : '/iq/work';

  return (
    <EmptyState
      title="Page not found"
      description={
        <>
          Nothing lives at <code>{pathname}</code>. The link may be stale,
          or the page may have moved. Everything reachable is in the rail
          on the left, and <kbd>⌘K</kbd> jumps anywhere by name.
        </>
      }
      actions={[{ label: '← Back to home', href: home }]}
    />
  );
}
