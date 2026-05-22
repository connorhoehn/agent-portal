import React from 'react';
// Re-export upstream primitives so callers importing from './ui' keep working.
export { EmptyState } from '@connorhoehnslalom/ui-components/shared';
export { Switch as Toggle } from '@connorhoehnslalom/ui-components/shared';
export { Button } from '@connorhoehnslalom/ui-components/shared';

// ── Small reusable bits shared across ingest sub-components ─────────────────

export function PulseDot({ active, color }: { active: boolean; color: string }) {
  return (
    <span
      style={{
        display: 'inline-block',
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: color,
        animation: active ? 'orgiq-pulse 1.5s ease-in-out infinite' : 'none',
      }}
    >
      <style>{`@keyframes orgiq-pulse{0%,100%{opacity:1}50%{opacity:0.3}}`}</style>
    </span>
  );
}

// ── Form field styles (still useful for inline form layouts) ────────────────

export const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 11,
  fontWeight: 500,
  color: 'var(--color-text-secondary)',
  marginBottom: 4,
};

export const inputStyle: React.CSSProperties = {
  fontSize: 12,
  padding: '5px 8px',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-sm)',
  width: '100%',
  boxSizing: 'border-box',
  background: 'var(--color-surface)',
};
