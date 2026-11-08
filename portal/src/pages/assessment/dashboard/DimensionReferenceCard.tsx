// A team Discussion message's dimension reference, drawn with the shared
// PageReferenceCard. The message stores `{kind: 'assessment-dimension', id}`
// only; this reader's own current authority resolves the title, trail and
// route (GET /api/page-references/resolve), so a reader who cannot see the
// team gets "Page unavailable", never the sender's words. Re-resolved when
// the reader's identity changes and when the tab regains focus.

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { Button } from '@connorhoehn/ui-components/shared';
import { PageReferenceCard } from '../../../components/chat/PageReferenceCard';
import { useSession } from '../../../lib/auth';
import {
  ASSESSMENT_DIMENSION_KIND, parseAssessmentDimensionId, resolveAssessmentDimensionReference, type AssessmentDimensionPageReference,
} from '../../../lib/assessmentPageReferences';

export function DimensionReferenceCard({ id }: { id: string }) {
  const navigate = useNavigate();
  const { session } = useSession();
  const identity = session ? JSON.stringify([session.sub, session.tenant, session.role, session.masquerading]) : '';
  const [state, setState] = useState<{ key: string; reference: AssessmentDimensionPageReference | null; loading: boolean; error: boolean }>(
    { key: '', reference: null, loading: false, error: false });
  const key = `${identity}\0${id}`;
  const abort = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    abort.current?.abort();
    const controller = new AbortController(); abort.current = controller;
    setState(previous => ({ key, reference: previous.key === key ? previous.reference : null, loading: true, error: false }));
    try {
      const reference = await resolveAssessmentDimensionReference(id, controller.signal);
      if (!controller.signal.aborted) setState({ key, reference, loading: false, error: false });
    } catch {
      if (!controller.signal.aborted) setState({ key, reference: null, loading: false, error: true });
    }
  }, [id, key]);
  useEffect(() => {
    if (!identity) return;
    void refresh();
    const again = () => { if (document.visibilityState === 'visible') void refresh(); };
    window.addEventListener('focus', again); document.addEventListener('visibilitychange', again);
    return () => { abort.current?.abort(); window.removeEventListener('focus', again); document.removeEventListener('visibilitychange', again); };
  }, [identity, refresh]);
  const current = state.key === key ? state : { reference: null, loading: true, error: false };
  return <PageReferenceCard reference={current.reference} loading={current.loading}
    onOpen={target => navigate(target.href)}
    openTestId="discussion-reference-open" unavailableTestId="discussion-reference-unavailable"
    action={current.error ? <Button variant="link" size="sm" className="text-xs" onClick={() => void refresh()}
      data-testid="discussion-reference-retry">Retry</Button> : undefined} />;
}

/** `renderMessageReferences` for a team Discussion: messages with a dimension reference draw its card. */
export function renderDimensionReference(message: { metadata?: Record<string, unknown> }): ReactNode {
  const value = message.metadata?.['pageReference'] as { kind?: unknown; id?: unknown } | undefined;
  if (value?.kind !== ASSESSMENT_DIMENSION_KIND || !parseAssessmentDimensionId(value.id)) return null;
  return <DimensionReferenceCard id={value.id as string} />;
}
