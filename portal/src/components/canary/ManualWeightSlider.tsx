// ManualWeightSlider — debug-only override of the canary weight. Range 0-100
// step 5; debounced PUT to /api/observability/canary/weight. Optimistic
// local update; toast on failure.

import { useEffect, useRef, useState } from 'react';
import { Inline, SectionLabel, Slider, useToast } from '@connorhoehnslalom/ui-components/shared';
import { setWeight, useCanaryStore } from './canaryStore.js';
import { writeJson } from '../../lib/writeJson';

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

  // Clear any pending debounced putWeight on unmount so we don't fire a
  // network call (and setWeight) after the component is gone.
  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, []);

  function commit(value: number): void {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void putWeight(value);
    }, DEBOUNCE_MS);
  }

  async function putWeight(value: number): Promise<void> {
    const previous = storeWeightB;
    setWeight(value); // optimistic
    const res = await writeJson<{ message?: string; error?: string }>(
      '/api/observability/canary/weight', 'PUT', { weight_b: value, source: 'manual' },
    );
    if (!res.ok) {
      setWeight(previous);
      toast(`Weight update failed: ${res.data?.message ?? res.error}`, { type: 'error' });
    }
  }

  return (
    // The pointer handlers sit on the wrapper, not the Slider: SliderProps is a
    // fixed set and takes no DOM events, so a drag-in-flight flag has to catch
    // them as they bubble. Filed in ui-components-queue.md.
    <Inline
      gap="sm"
      wrap={false}
      className="px-2.5 py-1 border border-border rounded bg-surface"
      onPointerDown={() => { draggingRef.current = true; }}
      onPointerUp={() => { draggingRef.current = false; }}
    >
      <SectionLabel>Manual B%</SectionLabel>
      <Slider
        min={0}
        max={100}
        step={5}
        value={local}
        onChange={(v) => {
          setLocal(v);
          commit(v);
        }}
        className="w-[140px]"
        aria-label="Manual canary weight B"
      />
      <Inline as="span" gap="none" className="text-[12px] tabular-nums text-text-primary font-semibold min-w-8 text-right">{local}%</Inline>
    </Inline>
  );
}




