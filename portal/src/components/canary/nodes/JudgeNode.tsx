// Canary JudgeNode — the LLM-as-judge scoring each variant's outputs, one mini
// horizontal bar per dimension (0–100 scale).
//
// THE ABSTENTION. A judge does not score every dimension of every answer: it
// ABSTAINS on one it cannot measure. `offline/lexical-answer-check` omits
// `tone` unless there is a refusal to report, so a real event reads
// `{helpfulness: 0.9, factuality: 0.167, conciseness: 0.925}` — four labels,
// three numbers. The server treats that correctly: `weightedComposite`
// renormalises over the keys present, so abstaining neither costs nor buys
// anything, where awarding an unmeasurable dimension full marks was worth 20%
// of the composite for free and could lift an answer covering 2 of 8 asked
// terms over its threshold.
//
// This node used to render `(s?.tone ?? 0) * 100`, which turns "not judged"
// into "judged zero" — a bar pinned at the floor, i.e. the worst possible score
// on that dimension, stated confidently about a dimension nobody looked at.
// Absent is now its own state: the label stays (so you can see WHICH dimension
// went unjudged) and the bar is replaced by "not judged".

import { memo, useEffect, useState, useCallback } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { useNavigate } from 'react-router';
import { Card, Chip, Inline, ProgressBar, Stack, T } from '@connorhoehn/ui-components/shared';
import type { JudgeNodeData } from '../types.js';
import { relativeTimeSeconds } from '../../../lib/relativeTime';

export type JudgeNodeType = Node<JudgeNodeData & Record<string, unknown>, 'judgeNode'>;

interface BarProps {
  label: string;
  /** `undefined` means the judge abstained — NOT zero. */
  value: number | undefined; // 0–100 when scored
  color: string;
}

/**
 * One scoring axis.
 *
 * The track is `ProgressBar` with no `label`, which renders the bar alone —
 * and unlike the hand-rolled pair of divs it came from, it carries
 * `role="progressbar"` with `aria-valuenow`/`min`/`max`, so a screen reader
 * gets the number instead of two anonymous boxes. The surrounding label and
 * readout stay here because ProgressBar's own `label` slot puts them above the
 * track, not on either side of it.
 */
function Bar({ label, value, color }: BarProps) {
  const judged = value !== undefined && Number.isFinite(value);
  const pct = judged ? Math.max(0, Math.min(100, value)) : 0;
  return (
    <Inline gap="xs" wrap={false}>
      <T size="xs" tone="tertiary" className="w-16 shrink-0">
        {label}
      </T>
      {judged ? (
        <>
          <ProgressBar value={pct} size="sm" color={color} aria-label={label} className="flex-1" />
          <Inline
            as="span"
            gap="none"
            justify="end"
            className="w-[26px] text-xs tabular-nums text-text-secondary"
          >
            {Math.round(pct)}
          </Inline>
        </>
      ) : (
        // No track at all: an empty rail still reads as a measurement at zero.
        // The words are the affordance, and the dash in the value column keeps
        // the row aligned with its scored siblings.
        <>
          <T size="xs" tone="tertiary" className="flex-1 italic" title={`The judge abstained on ${label} — it is not scored, not scored zero. The composite renormalises over the dimensions that were judged.`}>
            not judged
          </T>
          <Inline as="span" gap="none" justify="end" className="w-[26px] text-xs text-text-tertiary">
            —
          </Inline>
        </>
      )}
    </Inline>
  );
}

/** The dimensions this node names, in display order, with their bar colour.
 *  A dimension is listed here so its ABSENCE is visible; the judge may also
 *  return a dimension not on this list, which is appended after them. */
const DIMENSIONS: Array<[key: string, color: string]> = [
  ['helpfulness', '#6366f1'],
  ['factuality', '#16a34a'],
  ['tone', '#0891b2'],
  ['conciseness', '#f59e0b'],
];
const EXTRA_COLOR = '#64748b';

function formatRelative(iso: string | undefined): string {
  // relativeTimeSeconds, which is the shared helper written for exactly this:
  // "where 'just now' is too coarse to show that a poll is live". It reads
  // Date.now() itself, so the ticking state below still drives the refresh —
  // it just no longer has to be threaded through as an argument.
  if (!iso) return '—';
  return relativeTimeSeconds(iso) || '—';
}

function JudgeNodeImpl({ data }: NodeProps<JudgeNodeType>) {
  // A ticking counter so "Xs ago" stays fresh without re-rendering on every
  // event. The value itself is unused — re-rendering is the whole point, and
  // formatRelative reads the clock itself.
  const [, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const navigate = useNavigate();
  const handleClick = useCallback(() => {
    navigate('/iq/evaluations');
  }, [navigate]);

  const s = data.lastScores;
  // Named dimensions first so a missing one keeps its place in the list, then
  // anything else the judge returned. `pct` is `undefined` — not 0 — for a
  // dimension the judge did not score.
  const rows: Array<[key: string, color: string, pct: number | undefined]> = [
    ...DIMENSIONS.map(([key, color]) => {
      const raw = s?.[key];
      return [key, color, typeof raw === 'number' ? raw * 100 : undefined] as [string, string, number | undefined];
    }),
    ...Object.entries(s ?? {})
      .filter(([key]) => !DIMENSIONS.some(([k]) => k === key))
      .map(([key, v]) => [key, EXTRA_COLOR, v * 100] as [string, string, number | undefined]),
  ];
  return (
    <Card
      padding="sm"
      className="w-[240px] text-xs cursor-pointer"
      onClick={handleClick}
      title="Open Evaluations — configure judge + view scores"
    >
      <Inline gap="sm" justify="between" wrap={false} className="mb-2">
        <Inline gap="xs" wrap={false} className="min-w-0">
          <Chip tone="info" size="xs">LLM-as-judge</Chip>
          <T size="xs" tone="tertiary" className="font-mono overflow-hidden text-ellipsis whitespace-nowrap" title={data.judgeVersion}>
            {data.judgeVersion}
          </T>
        </Inline>
        <T size="xs" tone="tertiary">
          {formatRelative(data.lastJudgedAt)}
        </T>
      </Inline>

      <Stack gap="xs">
        {rows.map(([key, color, value]) => (
          <Bar key={key} label={key} value={value} color={color} />
        ))}
      </Stack>

      <Handle type="target" position={Position.Top} id="in" />
      <Handle type="source" position={Position.Bottom} id="out" />
    </Card>
  );
}

export const JudgeNode = memo(JudgeNodeImpl);
