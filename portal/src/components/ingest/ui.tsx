import React from 'react';

// ── Small reusable bits shared across ingest sub-components ─────────────────

export function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: 24,
        textAlign: 'center',
        color: 'var(--color-text-tertiary)',
        fontSize: 13,
      }}
    >
      {children}
    </div>
  );
}

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

export function Toggle({
  enabled,
  onChange,
}: {
  enabled: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      onClick={() => onChange(!enabled)}
      style={{
        width: 36,
        height: 20,
        borderRadius: 10,
        border: 'none',
        cursor: 'pointer',
        padding: 0,
        background: enabled ? 'var(--color-success)' : 'var(--color-border)',
        position: 'relative',
        transition: 'background 0.2s',
      }}
    >
      <span
        style={{
          display: 'block',
          width: 14,
          height: 14,
          borderRadius: '50%',
          background: '#fff',
          position: 'absolute',
          top: 3,
          left: enabled ? 19 : 3,
          transition: 'left 0.2s',
        }}
      />
    </button>
  );
}

// ── Modal scaffolding ───────────────────────────────────────────────────────

export function ModalBackdrop({
  onClose,
  children,
}: {
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(15, 23, 42, 0.4)',
        zIndex: 100,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div onClick={e => e.stopPropagation()} style={{ maxHeight: '90vh', overflow: 'hidden' }}>
        {children}
      </div>
    </div>
  );
}

// ── Button styles ───────────────────────────────────────────────────────────

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

export const secondaryBtnStyle: React.CSSProperties = {
  fontSize: 12,
  padding: '5px 12px',
  background: 'transparent',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-sm)',
  cursor: 'pointer',
};

export function primaryBtnStyle(disabled: boolean): React.CSSProperties {
  return {
    fontSize: 12,
    padding: '6px 16px',
    background: 'var(--color-primary)',
    color: '#fff',
    border: 'none',
    borderRadius: 'var(--radius-sm)',
    cursor: disabled ? 'wait' : 'pointer',
    opacity: disabled ? 0.6 : 1,
  };
}

export function dangerBtnStyle(disabled: boolean): React.CSSProperties {
  return {
    fontSize: 11,
    padding: '4px 10px',
    background: 'transparent',
    color: 'var(--color-danger)',
    border: '1px solid var(--color-danger)',
    borderRadius: 'var(--radius-sm)',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
  };
}

export function smallBtnStyle(disabled: boolean): React.CSSProperties {
  return {
    fontSize: 11,
    padding: '4px 10px',
    background: 'var(--color-surface-raised)',
    color: 'var(--color-text-primary)',
    border: '1px solid var(--color-border)',
    borderRadius: 'var(--radius-sm)',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
  };
}
