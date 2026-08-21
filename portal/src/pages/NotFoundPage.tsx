import { Link, useLocation } from 'react-router';
import { useSession } from '../lib/auth';

// Catch-all for unmatched paths. Before this existed, a typo'd URL or a link
// to a removed route rendered a blank document — indistinguishable from the
// app being broken. Renders inside Layout so the rail stays usable.

export default function NotFoundPage() {
  const { pathname } = useLocation();
  const { session } = useSession();
  const home = session?.tenant === 'newsroom' ? '/newsroom/home' : '/iq/work';

  return (
    <div style={{ padding: '48px 32px', maxWidth: 560 }}>
      <div style={{ fontSize: 13, fontWeight: 600, letterSpacing: '0.08em', color: 'var(--color-text-tertiary)', textTransform: 'uppercase', marginBottom: 8 }}>
        Page not found
      </div>
      <h1 style={{ fontSize: 20, fontWeight: 700, margin: '0 0 12px', color: 'var(--color-text-primary)' }}>
        Nothing lives at <code style={{ fontSize: 16 }}>{pathname}</code>
      </h1>
      <p style={{ fontSize: 13.5, lineHeight: 1.6, color: 'var(--color-text-secondary)', margin: '0 0 20px' }}>
        The link may be stale, or the page may have moved. Everything reachable
        is in the rail on the left, and <kbd>⌘K</kbd> jumps anywhere by name.
      </p>
      <Link
        to={home}
        style={{
          display: 'inline-block', fontSize: 13, fontWeight: 600,
          color: 'var(--color-primary)', textDecoration: 'none',
        }}
      >
        ← Back to home
      </Link>
    </div>
  );
}
