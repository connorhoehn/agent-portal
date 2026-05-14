import type { ReactNode } from 'react';

interface SettingRowProps {
  title: string;
  description?: string;
  control: ReactNode;
}

export function SettingRow({ title, description, control }: SettingRowProps) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 16,
        padding: '10px 0',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--color-text-primary)' }}>
          {title}
        </div>
        {description && (
          <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 2 }}>
            {description}
          </div>
        )}
      </div>
      <div style={{ flexShrink: 0 }}>{control}</div>
    </div>
  );
}
