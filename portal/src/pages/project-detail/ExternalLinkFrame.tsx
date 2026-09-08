// A styled external hyperlink — target="_blank" + rel="noopener noreferrer".
// No composite in ui-components covers this: the library's href-carrying
// props (EmptyStateAction, NavRail's renderLink override, ThumbnailCard's
// href) are each scoped to that composite's own chrome, not a free-standing
// styled `<a>` a caller can drop into an arbitrary cell — the same gap
// bots/ExternalLinkFrame.tsx composes for the runs table's PR link. Composed
// again here, locally, for the initiative header's repo link and each work
// item's PR badge. Queued in docs/ui-components-queue.md.

import type { MouseEvent, ReactNode } from 'react';

export function ExternalLink({
  href,
  children,
  className,
  title,
  onClick,
}: {
  href: string;
  children: ReactNode;
  className?: string;
  title?: string;
  onClick?: (e: MouseEvent) => void;
}) {
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
