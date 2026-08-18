// Subscribes to /api/observability/canary/events and feeds every server
// event into the canary store via dispatch(). Also seeds initial state on
// mount by fetching /api/observability/canary/prompts and
// /api/observability/canary/weight.
//
// Mirrors the EventSource pattern in components/ingest/useCrawlStream.ts.

import { useEffect } from 'react';
import {
  dispatch,
  setPromptTemplates,
  setJudgeArn,
  rehydrateExperiment,
} from './canaryStore.js';
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
  control?: { halted?: boolean };
}

export function useCanaryStream(): void {
  useEffect(() => {
    let cancelled = false;

    // Seed initial state from REST snapshots before opening the SSE stream
    // — the snapshot endpoints are cheap and let the UI render meaningfully
    // before any live event arrives.
    const promptsP = fetch('/api/observability/canary/prompts', { credentials: 'include' })
      .then((r) => (r.ok ? (r.json() as Promise<PromptsResponse>) : null))
      .then((body) => {
        if (cancelled || !body) return null;
        setPromptTemplates({
          promptATemplate: body.subject_a?.template,
          promptBTemplate: body.subject_b?.template,
          promptAVersionLabel: body.subject_a?.label,
          promptBVersionLabel: body.subject_b?.label,
        });
        if (body.judge?.arn) setJudgeArn(body.judge.arn);
        return body;
      })
      .catch(() => null); // Endpoint may not exist yet — defaults are fine.

    const weightP = fetch('/api/observability/canary/weight', { credentials: 'include' })
      .then((r) => (r.ok ? (r.json() as Promise<WeightResponse>) : null))
      .then((body) => {
        if (cancelled || !body || typeof body.weight_b !== 'number') return null;
        // Dispatch as a synthetic weight_changed event so the standard
        // reducer path stays the single source of truth.
        dispatch({
          type: 'weight_changed',
          weight_b: body.weight_b,
          source: 'controller',
          ts: new Date().toISOString(),
        });
        return body;
      })
      .catch(() => null);

    // Once both snapshots land, rehydrate a server-side experiment so a page
    // reload lands on the live view instead of the setup wizard.
    void Promise.all([promptsP, weightP]).then(([prompts, weight]) => {
      if (cancelled || !prompts || !weight) return;
      rehydrateExperiment({
        subjectAArn: prompts.subject_a?.arn ?? '',
        subjectBArn: prompts.subject_b?.arn ?? '',
        weightB: weight.weight_b,
        halted: weight.control?.halted === true,
      });
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
