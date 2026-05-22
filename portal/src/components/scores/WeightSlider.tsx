interface WeightSliderProps {
  value: number;
  onChange: (v: number) => void;
  label?: string;
}

export function WeightSlider({ value, onChange, label = 'Composite weighting: influence vs expertise' }: WeightSliderProps) {
  const infPct = Math.round(value * 100);
  const expPct = Math.round((1 - value) * 100);

  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{
        fontSize: 11,
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: '0.05em',
        color: 'var(--color-text-tertiary)',
        marginBottom: 6,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
      }}>
        Composite weighting
        <button
          onClick={() => onChange(0.55)}
          style={{
            fontSize: 11,
            fontWeight: 400,
            background: 'none',
            border: 'none',
            color: 'var(--color-primary, #6366f1)',
            cursor: 'pointer',
            padding: 0,
            textTransform: 'none',
            letterSpacing: 'normal',
          }}
        >
          Reset
        </button>
      </div>
      <input
        type="range"
        aria-label={label}
        min={0}
        max={100}
        value={infPct}
        onChange={e => onChange(Number(e.target.value) / 100)}
        style={{ width: '100%', accentColor: 'var(--color-primary, #6366f1)', cursor: 'pointer' }}
      />
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
        <span style={{ fontSize: 11, color: 'var(--color-primary, #6366f1)', fontWeight: 500 }}>
          Influence {infPct}%
        </span>
        <span style={{ fontSize: 11, color: 'var(--color-success)', fontWeight: 500 }}>
          Expertise {expPct}%
        </span>
      </div>
    </div>
  );
}
