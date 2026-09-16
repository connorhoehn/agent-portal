// Hooks and async helpers for the Bedrock Prompt Library API.
//
// Hooks use useState + useEffect (no external fetch library). Each hook
// re-fetches when its key deps change; refresh() bumps a counter to force
// a re-fetch on demand.

import { useState, useEffect, useCallback } from 'react';
import type { PromptLibraryEntry, PromptVersionDetail } from './types.js';
import { startExperiment, resetExperiment } from './canaryStore.js';

// ── List all prompts ──────────────────────────────────────────────────────────

export function usePromptList(): {
  prompts: PromptLibraryEntry[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
} {
  const [prompts, setPrompts] = useState<PromptLibraryEntry[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetch('/api/observability/canary/library', { credentials: 'include' })
      .then(async (res) => {
        if (!res.ok) {
          const msg = await res.text().catch(() => res.statusText);
          throw new Error(msg || `HTTP ${res.status}`);
        }
        return res.json() as Promise<PromptLibraryEntry[] | { prompts: PromptLibraryEntry[] }>;
      })
      .then((data) => {
        if (!cancelled) {
          setPrompts(Array.isArray(data) ? data : (data as { prompts: PromptLibraryEntry[] }).prompts ?? []);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [tick]);

  return { prompts, loading, error, refresh };
}

// ── List versions for a specific prompt ──────────────────────────────────────

export function usePromptVersions(promptId: string | null): {
  versions: PromptLibraryEntry[];
  loading: boolean;
  error: string | null;
} {
  const [versions, setVersions] = useState<PromptLibraryEntry[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!promptId) {
      setVersions([]);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    fetch(`/api/observability/canary/library/${encodeURIComponent(promptId)}/versions`, { credentials: 'include' })
      .then(async (res) => {
        if (!res.ok) {
          const msg = await res.text().catch(() => res.statusText);
          throw new Error(msg || `HTTP ${res.status}`);
        }
        return res.json() as Promise<PromptLibraryEntry[] | { versions: PromptLibraryEntry[] }>;
      })
      .then((data) => {
        if (!cancelled) {
          setVersions(Array.isArray(data) ? data : (data as { versions: PromptLibraryEntry[] }).versions ?? []);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [promptId]);

  return { versions, loading, error };
}

// ── Get full version detail (template text) ───────────────────────────────────

export function usePromptVersionDetail(
  promptId: string | null,
  version: string | null,
): {
  detail: PromptVersionDetail | null;
  loading: boolean;
  error: string | null;
} {
  const [detail, setDetail] = useState<PromptVersionDetail | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!promptId || !version) {
      setDetail(null);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    const url = `/api/observability/canary/library/${encodeURIComponent(promptId)}/version/${encodeURIComponent(version)}`;
    fetch(url, { credentials: 'include' })
      .then(async (res) => {
        if (!res.ok) {
          const msg = await res.text().catch(() => res.statusText);
          throw new Error(msg || `HTTP ${res.status}`);
        }
        return res.json() as Promise<PromptVersionDetail>;
      })
      .then((data) => {
        if (!cancelled) {
          setDetail(data);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [promptId, version]);

  return { detail, loading, error };
}

// ── Async helpers ─────────────────────────────────────────────────────────────

export async function createPrompt(opts: {
  name: string;
  templateText: string;
  modelId?: string;
  inferenceConfig?: { temperature?: number; maxTokens?: number };
  description?: string;
}): Promise<{ id: string; arn: string; name: string }> {
  const res = await fetch('/api/observability/canary/library', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: opts.name,
      template_text: opts.templateText,
      model_id: opts.modelId,
      inference_config: opts.inferenceConfig,
      description: opts.description,
    }),
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(msg || `HTTP ${res.status}`);
  }
  return res.json() as Promise<{ id: string; arn: string; name: string }>;
}

export async function saveDraft(
  promptId: string,
  name: string,
  templateText: string,
  modelId?: string,
  inferenceConfig?: { temperature?: number; maxTokens?: number; topP?: number },
): Promise<void> {
  const res = await fetch(
    `/api/observability/canary/library/${encodeURIComponent(promptId)}/draft`,
    {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        template_text: templateText,
        model_id: modelId,
        inference_config: inferenceConfig,
      }),
    },
  );
  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(msg || `HTTP ${res.status}`);
  }
}

export async function publishVersion(
  promptId: string,
  description?: string,
): Promise<{ version: string; arn: string }> {
  const res = await fetch(
    `/api/observability/canary/library/${encodeURIComponent(promptId)}/publish`,
    {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description }),
    },
  );
  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(msg || `HTTP ${res.status}`);
  }
  return res.json() as Promise<{ version: string; arn: string }>;
}

export async function startCanaryExperiment(
  subjectAArn: string,
  subjectBArn: string,
  initialWeightB: number,
): Promise<void> {
  const res = await fetch('/api/observability/canary/start', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      subject_a_arn: subjectAArn,
      subject_b_arn: subjectBArn,
      initial_weight_b: initialWeightB,
    }),
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(msg || `HTTP ${res.status}`);
  }
  startExperiment(subjectAArn, subjectBArn, initialWeightB);
}

export async function resetCanaryExperiment(): Promise<void> {
  const res = await fetch('/api/observability/canary/reset', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(msg || `HTTP ${res.status}`);
  }
  resetExperiment();
}

// ── Prompt invoke (streaming) ─────────────────────────────────────────────────

export async function invokePrompt(
  promptId: string,
  opts: {
    version?: string;
    variables?: Record<string, string>;
    guardrailId?: string;
    guardrailVersion?: string;
    onChunk: (text: string) => void;
    onGuardrail?: (trace: unknown) => void;
  },
): Promise<void> {
  const res = await fetch(
    `/api/observability/canary/library/${encodeURIComponent(promptId)}/invoke`,
    {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        version: opts.version,
        variables: opts.variables,
        guardrailId: opts.guardrailId,
        guardrailVersion: opts.guardrailVersion,
      }),
    },
  );
  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(msg || `HTTP ${res.status}`);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error('No response body');
  const decoder = new TextDecoder();
  let buf = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line) as { text?: string; guardrail?: unknown; done?: boolean; error?: string };
        if (evt.error) throw new Error(evt.error);
        if (evt.text) opts.onChunk(evt.text);
        if (evt.guardrail) opts.onGuardrail?.(evt.guardrail);
      } catch {
        // non-JSON line, skip
      }
    }
  }
}

// ── Prompt optimize (AI Assist) ───────────────────────────────────────────────

export type OptimizeMetric = 'clarity' | 'brevity' | 'safety' | 'groundedness';

export async function optimizePrompt(
  promptId: string,
  templateText: string,
  targetMetric: OptimizeMetric = 'clarity',
): Promise<string> {
  const res = await fetch(
    `/api/observability/canary/library/${encodeURIComponent(promptId)}/optimize`,
    {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ templateText, targetMetric }),
    },
  );
  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(msg || `HTTP ${res.status}`);
  }
  const data = (await res.json()) as { optimizedText: string };
  return data.optimizedText;
}
