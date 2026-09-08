// A styled external hyperlink. No composite in ui-components covers this: the
// library's href-carrying props (EmptyStateAction, NavRail's renderLink
// override, ThumbnailCard's href) are each scoped to that composite's own
// chrome, not a free-standing styled `<a>` a caller can drop into an
// arbitrary cell. `bots/ExternalLinkFrame.tsx` composes the same shape, but
// that directory is owned by another agent, so it cannot be imported across
// the boundary — composed locally here for the initiative tile's repo link.
// Queued in docs/ui-components-queue.md.

import type { ReactNode } from 'react';

export interface ExternalLinkProps {
  href: string;
  children: ReactNode;
  className?: string;
  title?: string;
  onClick?: (e: React.MouseEvent) => void;
}

export function ExternalLink({ href, children, className, title, onClick }: ExternalLinkProps) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={title}
      onClick={onClick}
      className={className ?? 'text-primary no-underline hover:underline'}
    >
      {children}
    </a>
  );
}

export default ExternalLink;
