import { Inline, Stack } from '@connorhoehnslalom/ui-components/shared';

interface HistogramBarProps {
  /** 5-element array of counts for buckets 0-20, 20-40, 40-60, 60-80, 80-100 */
  buckets: [number, number, number, number, number];
  /** Fill colour for all bars */
  color: string;
  /** Total pixel height of the histogram area (default: 48) */
  height?: number;
}

const BUCKET_LABELS = ['0–20', '20–40', '40–60', '60–80', '80–100'];

export function HistogramBar({ buckets, color, height = 48 }: HistogramBarProps) {
  const max = Math.max(...buckets, 1);

  return (
    // `height` and the per-bar height/colour/opacity below are computed from
    // the data, so they stay inline — but the elements carrying them are
    // primitives.
    <Inline
      gap="none"
      align="end"
      className="gap-[3px]"
      style={{ height }}
      title={buckets.map((c, i) => `${BUCKET_LABELS[i]}: ${c}`).join(' | ')}
    >
      {buckets.map((count, i) => {
        const pct = count / max;
        const barH = Math.max(2, Math.round(pct * height));
        return (
          <Stack key={i} gap="none" align="center" justify="end" className="flex-1 h-full">
            <Inline
              gap="none"
              aria-hidden
              className="w-full rounded-t-[2px] transition-[height] duration-300 ease-in-out"
              style={{ height: barH, backgroundColor: color, opacity: 0.15 + 0.85 * pct }}
            />
          </Stack>
        );
      })}
    </Inline>
  );
}
