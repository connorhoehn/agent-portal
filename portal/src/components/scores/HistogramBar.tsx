// Tiny pure-CSS stacked histogram — no chart library required.
// Renders 5 vertical bars side-by-side representing score buckets.

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
      style={{
        display: 'flex',
        alignItems: 'flex-end',
        gap: 3,
        height,
      }}
      title={buckets.map((c, i) => `${BUCKET_LABELS[i]}: ${c}`).join(' | ')}
    >
      {buckets.map((count, i) => {
        const pct = count / max;
        const barH = Math.max(2, Math.round(pct * height));
        return (
          <div
            key={i}
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'flex-end',
              height: '100%',
            }}
          >
            <div
              style={{
                width: '100%',
                height: barH,
                backgroundColor: color,
                opacity: 0.15 + 0.85 * pct,
                borderRadius: '2px 2px 0 0',
                transition: 'height 0.3s ease',
              }}
            />
          </div>
        );
      })}
    </div>
  );
}
