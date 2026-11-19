// The record page's whiteboard (WHITEBOARD-PLAN step 1): the board's checkpoints from GET /interviews/:id/board/snapshots,
// the final board first on screen and a few timed ones to step back through, each read-only and zoomed to its content.
// Choosing a time also moves the page's clock there, so the transcript and the recording follow.
import { useEffect, useMemo, useState } from 'react';
import { LoadingState, SegmentedControl, Stack, T } from '@connorhoehn/ui-components/shared';
import { boardMoments, readBoardSnapshots, type BoardSnapshot } from '../../../lib/interviewsBoard';
import { BoardScene } from './BoardScene';

export interface BoardSnapshotsProps {
  interviewId: string;
  startedAt: string | null;
  /** Move the page's clock (ms from the interview's start). */
  onMoveTo?: (ms: number) => void;
}

export function BoardSnapshots({ interviewId, startedAt, onMoveTo }: BoardSnapshotsProps) {
  const [snapshots, setSnapshots] = useState<BoardSnapshot[] | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void readBoardSnapshots(interviewId).then((s) => { if (live) setSnapshots(s); });
    return () => { live = false; };
  }, [interviewId]);
  const moments = useMemo(() => boardMoments(snapshots ?? [], startedAt), [snapshots, startedAt]);
  const [chosen, setChosen] = useState<number | null>(null);
  const shown = moments.find((m) => m.seq === chosen) ?? moments.at(-1) ?? null;

  if (snapshots === undefined) return <LoadingState label="Opening the whiteboard…" />;
  if (snapshots === null) return <T size="sm" tone="secondary" wrap data-testid="interviews-record-board-line">The whiteboard could not be read just now.</T>;
  if (!shown) return <T size="sm" tone="secondary" wrap data-testid="interviews-record-board-line">Nothing was drawn on the whiteboard in this interview.</T>;
  return (
    <Stack gap="xs" className="h-full min-h-0 flex-1" data-testid="interviews-record-board">
      {moments.length > 1 && (
        <SegmentedControl size="sm" aria-label="The board at" value={String(shown.seq)}
          options={moments.map((m) => ({ value: String(m.seq), label: m.label }))}
          onChange={(v) => {
            const m = moments.find((x) => String(x.seq) === v);
            if (!m) return;
            setChosen(m.seq);
            onMoveTo?.(m.atMs);
          }} />
      )}
      <BoardScene sceneId={`snapshot-${interviewId}-${shown.seq}`} elements={shown.elements} data-testid="interviews-record-board-canvas"
        className="min-h-[320px] flex-1 overflow-hidden" />
    </Stack>
  );
}
