// The people of a meeting as faces: each person's portrait (initials only for someone without one), side by side with a small gap so
// two-letter initials never collide, at most `max` shown and the rest as "+N". Their names on hover or focus, and for screen readers.
import { Avatar, Inline, T, Tooltip, VisuallyHidden } from '@connorhoehn/ui-components/shared';
import type { Face } from './meetingsModel';

export function Faces({ faces, label, max = 4, size = 24, testId }: { faces: readonly Face[]; label?: string; max?: number; size?: number; testId?: string }) {
  if (!faces.length) return null;
  const words = label ?? faces.map((f) => f.name).join(', ');
  const more = faces.length - max;
  return (
    <Tooltip content={words} triggerClassName="inline-flex items-center">
      <Inline as="span" gap="xs" wrap={false} tabIndex={0} aria-label={words} {...(testId ? { 'data-testid': testId } : {})}>
        {faces.slice(0, max).map((f, i) => <Avatar key={`${f.name}-${i}`} name={f.name} size={size} showTitle={false} {...(f.src ? { src: f.src } : {})} />)}
        {more > 0 && <T size="sm" tone="secondary">{`+${more}`}</T>}
        <VisuallyHidden>{words}</VisuallyHidden>
      </Inline>
    </Tooltip>
  );
}

/** One person: their face, then their name. */
export function PersonName({ face, testId }: { face: Face; testId?: string }) {
  return (
    <Inline gap="xs" wrap={false} className="min-w-0" {...(testId ? { 'data-testid': testId } : {})}>
      <Avatar name={face.name} size={24} showTitle={false} {...(face.src ? { src: face.src } : {})} />
      <T size="sm" truncate className="min-w-0">{face.name}</T>
    </Inline>
  );
}
