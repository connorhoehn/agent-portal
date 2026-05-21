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

    fetch('/api/observability/canary/library')
      .then(async (res) => {
        if (!res.ok) {
          const msg = await res.text().catch(() => res.statusText);
          throw new Error(msg || `HTTP ${res.status}`);
        }
        return res.json() as Promise<PromptLibraryEntry[]>;
      })
      .then((data) => {
        if (!cancelled) {
          setPrompts(data);
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

    fetch(`/api/observability/canary/library/${encodeURIComponent(promptId)}/versions`)
      .then(async (res) => {
        if (!res.ok) {
          const msg = await res.text().catch(() => res.statusText);
          throw new Error(msg || `HTTP ${res.status}`);
        }
        return res.json() as Promise<PromptLibraryEntry[]>;
      })
      .then((data) => {
        if (!cancelled) {
          setVersions(data);
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
    fetch(url)
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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, templateText, modelId, inferenceConfig }),
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
    headers: { 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(msg || `HTTP ${res.status}`);
  }
  resetExperiment();
}
