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
    <div
      className="flex items-end gap-[3px]"
      style={{ height }}
      title={buckets.map((c, i) => `${BUCKET_LABELS[i]}: ${c}`).join(' | ')}
    >
      {buckets.map((count, i) => {
        const pct = count / max;
        const barH = Math.max(2, Math.round(pct * height));
        return (
          <div key={i} className="flex flex-col items-center justify-end flex-1 h-full">
            <div
              className="w-full rounded-t-[2px] transition-[height] duration-300 ease-in-out"
              style={{ height: barH, backgroundColor: color, opacity: 0.15 + 0.85 * pct }}
            />
          </div>
        );
      })}
    </div>
  );
}
