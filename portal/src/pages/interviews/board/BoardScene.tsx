// A whiteboard scene on its own, off the gateway (WHITEBOARD-PLAN steps 1 and 2): the record page's checkpoints
// (read-only) and the kit editor's starting board (editable). The library's Excalidraw canvas over a Y.Doc of the
// page's own, seeded with the scene's elements; it opens zoomed to the content (useBoardFit). `onElements` hears the
// scene after each local change.
import { lazy, Suspense, useCallback, useEffect, useMemo } from 'react';
import * as Y from 'yjs';
import { LoadingState, Stack } from '@connorhoehn/ui-components/shared';
import { insertBoard, readBoardElements, type BoardOpening } from '../../../lib/interviewsBoard';
import { useBoardFit } from './useBoardFit';

const ExcalidrawCanvas = lazy(() => import('@connorhoehn/ui-components/diagram').then((m) => ({ default: m.CollaborativeExcalidraw })));

const VIEWER = { userId: 'board-scene', displayName: 'You', color: 'var(--color-primary)' };

export interface BoardSceneProps {
  /** Unique on the page: the fit finds the canvas by it, and a new id opens a new scene. */
  sceneId: string;
  elements: ReadonlyArray<Record<string, unknown>>;
  editable?: boolean;
  /** What it opens on: a master template's prompt (the default), or what was drawn (the record page). */
  opensOn?: BoardOpening;
  onElements?: (elements: Array<Record<string, unknown>>) => void;
  className?: string;
  'data-testid'?: string;
}

export function BoardScene({ sceneId, elements, editable = false, opensOn = 'prompt', onElements, className, 'data-testid': testId }: BoardSceneProps) {
  // The doc lives as long as the scene id: a later prop never replaces local strokes.
  const ydoc = useMemo(() => {
    const doc = new Y.Doc();
    insertBoard(doc, { name: sceneId, elements: [...elements] });
    return doc;
  }, [sceneId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => ydoc.destroy(), [ydoc]);
  useBoardFit(ydoc, `[data-board-scene="${sceneId}"]`, false, opensOn);
  const changed = useCallback(() => {
    if (onElements) onElements(readBoardElements(ydoc) as unknown as Array<Record<string, unknown>>);
  }, [onElements, ydoc]);
  return (
    <Stack gap="none" className={className ?? 'h-full min-h-[320px] flex-1 overflow-hidden'} data-board-scene={sceneId} data-testid={testId ?? 'interview-board-scene'}>
      <Suspense fallback={<LoadingState label="Loading the whiteboard…" />}>
        <ExcalidrawCanvas key={sceneId} ydoc={ydoc} awareness={null} user={VIEWER} editable={editable} onSceneChange={changed} className="h-full min-h-0 flex-1" />
      </Suspense>
    </Stack>
  );
}
