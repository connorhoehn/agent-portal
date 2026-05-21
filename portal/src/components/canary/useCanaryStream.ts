// Subscribes to /api/observability/canary/events and feeds every server
// event into the canary store via dispatch(). Also seeds initial state on
// mount by fetching /api/observability/canary/prompts and
// /api/observability/canary/weight.
//
// Mirrors the EventSource pattern in components/ingest/useCrawlStream.ts.

import { useEffect } from 'react';
import { dispatch, setPromptTemplates, setJudgeArn } from './canaryStore.js';
import type { CanaryEvent } from './types.js';

interface PromptInfo {
  arn: string;
  label: string;
  template?: string;
}

interface PromptsResponse {
  subject_a: PromptInfo;
  subject_b: PromptInfo;
  judge: { arn: string };
}

interface WeightResponse {
  weight_b: number;
}

export function useCanaryStream(): void {
  useEffect(() => {
    let cancelled = false;

    // Seed initial state from REST snapshots before opening the SSE stream
    // — the snapshot endpoints are cheap and let the UI render meaningfully
    // before any live event arrives.
    fetch('/api/observability/canary/prompts', { credentials: 'include' })
      .then((r) => (r.ok ? (r.json() as Promise<PromptsResponse>) : null))
      .then((body) => {
        if (cancelled || !body) return;
        setPromptTemplates({
          promptATemplate: body.subject_a?.template,
          promptBTemplate: body.subject_b?.template,
          promptAVersionLabel: body.subject_a?.label,
          promptBVersionLabel: body.subject_b?.label,
        });
        if (body.judge?.arn) setJudgeArn(body.judge.arn);
      })
      .catch(() => {
        // Endpoint may not exist yet — silently fall back to defaults.
      });

    fetch('/api/observability/canary/weight', { credentials: 'include' })
      .then((r) => (r.ok ? (r.json() as Promise<WeightResponse>) : null))
      .then((body) => {
        if (cancelled || !body || typeof body.weight_b !== 'number') return;
        // Dispatch as a synthetic weight_changed event so the standard
        // reducer path stays the single source of truth.
        dispatch({
          type: 'weight_changed',
          weight_b: body.weight_b,
          source: 'controller',
          ts: new Date().toISOString(),
        });
      })
      .catch(() => {
        /* same — defaults are fine */
      });

    const es = new EventSource('/api/observability/canary/events');

    es.onmessage = (evt: MessageEvent) => {
      let msg: CanaryEvent;
      try {
        msg = JSON.parse(evt.data) as CanaryEvent;
      } catch {
        return;
      }
      dispatch(msg);
    };

    es.onerror = () => {
      // EventSource auto-reconnects by default — just log.
      // eslint-disable-next-line no-console
      console.warn('[canary] EventSource error — reconnecting…');
    };

    return () => {
      cancelled = true;
      es.close();
    };
  }, []);
}
