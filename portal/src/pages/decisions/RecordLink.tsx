// A library `Link` that navigates client-side: a plain click goes through the
// router, a modified click (new tab) keeps the anchor's own behaviour.
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { Link } from '@connorhoehn/ui-components/shared';

export function RecordLink({ to, children, ...rest }: { to: string; children: ReactNode; className?: string; title?: string; 'data-testid'?: string }) {
  const navigate = useNavigate();
  return (
    <Link
      href={to}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        navigate(to);
      }}
      {...rest}
    >
      {children}
    </Link>
  );
}
