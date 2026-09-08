// A styled external hyperlink. No composite in ui-components covers this: the
// library's href-carrying props (EmptyStateAction, NavRail's renderLink
// override, ThumbnailCard's href) are each scoped to that composite's own
// chrome, not a free-standing styled `<a>` a caller can drop into an
// arbitrary cell or PageSection actions slot. Same gap `bots/ExternalLinkFrame.tsx`
// composes for the bot detail page's runs table; composed again here rather
// than importing across a directory another agent owns. Queued in
// docs/ui-components-queue.md.

import type { ReactNode } from 'react';

export interface ExternalLinkProps {
  href: string;
  children: ReactNode;
  className?: string;
  title?: string;
}

export function ExternalLink({ href, children, className, title }: ExternalLinkProps) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={title}
      className={className ?? 'text-primary no-underline hover:underline'}
    >
      {children}
    </a>
  );
}

export default ExternalLink;
