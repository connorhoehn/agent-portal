import type { ReactNode } from 'react';

/**
 * The tiny uppercase caption that titles a block inside a panel — "Variables",
 * "Screenshot", "Inference settings", "Baseline — v3".
 *
 * BrowserPage and PromptsPage between them carried eleven copies of this exact
 * declaration (`fontSize: 10|11, fontWeight: 600|700, textTransform: uppercase,
 * letterSpacing: 0.05|0.06em, color: text-tertiary`), which is why the two
 * pages never quite agreed on caption size. One component, one size.
 *
 * WANTED IN ui-components: this is a design-system primitive, not a page
 * concern — `PageSection` has a title but there is nothing for a caption one
 * level down. Reported to the coordinator; local until it lands.
 */
export function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={`text-[10px] font-bold uppercase tracking-[0.06em] text-text-tertiary ${className ?? ''}`}>
      {children}
    </span>
  );
}
