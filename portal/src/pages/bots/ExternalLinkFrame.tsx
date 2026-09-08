// A styled external hyperlink. No composite in ui-components covers this: the
// library's href-carrying props (EmptyStateAction, NavRail's renderLink
// override, ThumbnailCard's href) are each scoped to that composite's own
// chrome, not a free-standing styled `<a>` a caller can drop into an
// arbitrary cell — the exact gap NavRail's `renderLink` override exists to
// patch for its own rows. Composed once here for the runs table's PR link.
// Queued in docs/ui-components-queue.md.

import type { ReactNode } from 'react';

export interface ExternalLinkProps {
  href: string;
  children: ReactNode;
  className?: string;
}

export function ExternalLink({ href, children, className }: ExternalLinkProps) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={className ?? 'text-primary no-underline hover:underline'}
    >
      {children}
    </a>
  );
}

export default ExternalLink;
