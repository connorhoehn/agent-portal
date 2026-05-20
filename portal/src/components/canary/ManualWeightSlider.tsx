// ManualWeightSlider — debug-only override of the canary weight. Range 0-100
// step 5; debounced PUT to /api/observability/canary/weight. Optimistic
// local update; toast on failure.

import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { useToast } from '@connorhoehnslalom/ui-components/shared';
import { setWeight, useCanaryStore } from './canaryStore.js';

const DEBOUNCE_MS = 250;

export function ManualWeightSlider(): React.ReactElement {
  const storeWeightB = useCanaryStore((s) => s.weightB);
  const [local, setLocal] = useState<number>(storeWeightB);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { toast } = useToast();

  // If the store changes (e.g. controller pushes a new weight), reflect it
  // locally — unless the user is actively dragging.
  const draggingRef = useRef(false);
  useEffect(() => {
    if (!draggingRef.current) setLocal(storeWeightB);
  }, [storeWeightB]);

  function commit(value: number): void {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void putWeight(value);
    }, DEBOUNCE_MS);
  }

  async function putWeight(value: number): Promise<void> {
    const previous = storeWeightB;
    setWeight(value); // optimistic
    try {
      const res = await fetch('/api/observability/canary/weight', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ weight_b: value, source: 'manual' }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          message?: string;
          error?: string;
        };
        setWeight(previous);
        toast(
          `Weight update failed: ${body.message ?? body.error ?? res.statusText}`,
          { type: 'error' },
        );
      }
    } catch (e) {
      setWeight(previous);
      toast(`Weight update failed: ${(e as Error).message}`, { type: 'error' });
    }
  }

  return (
    <div style={wrapStyle}>
      <span style={labelStyle}>Manual B%</span>
      <input
        type="range"
        min={0}
        max={100}
        step={5}
        value={local}
        onPointerDown={() => {
          draggingRef.current = true;
        }}
        onPointerUp={() => {
          draggingRef.current = false;
        }}
        onChange={(e) => {
          const v = Number(e.target.value);
          setLocal(v);
          commit(v);
        }}
        style={rangeStyle}
        aria-label="Manual canary weight B"
      />
      <span style={valueStyle}>{local}%</span>
    </div>
  );
}

const wrapStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '4px 10px',
  border: '1px solid var(--color-border, #e2e8f0)',
  borderRadius: 4,
  background: 'var(--color-surface, #fff)',
};

const labelStyle: CSSProperties = {
  fontSize: 11,
  color: 'var(--color-text-tertiary, #94a3b8)',
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
};

const rangeStyle: CSSProperties = {
  width: 140,
};

const valueStyle: CSSProperties = {
  fontSize: 12,
  fontVariantNumeric: 'tabular-nums',
  color: 'var(--color-text-primary, #0f172a)',
  fontWeight: 600,
  minWidth: 32,
  textAlign: 'right',
};
