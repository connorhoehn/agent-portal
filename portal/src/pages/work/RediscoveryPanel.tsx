// "Before you spend" — the pre-flight step at a moment where spend is already
// authorised. See docs/asset-library-and-promotion.md § Not built yet:
// short-circuiting rediscovery. Lives inside AssignJobModal, above the
// mission block: the modal already states the dollar cost of the decision,
// so prior art belongs right next to it, not on a separate page nobody
// visits before confirming.
//
// Silence is a feature, not a loading state: a weak or absent match renders
// nothing, because a low-confidence guess shown at a spend moment is exactly
// what trains a person to stop reading this panel. Same reasoning for a
// failed fetch — the middleware may not even be up yet, and a plumbing error
// has no business interrupting someone about to confirm a job.

import { useEffect, useState } from 'react';
import { Button, Card, Chip, Inline, Stack } from '@connorhoehnslalom/ui-components/shared';
import { T } from './workShared';
import {
  VERDICT_LABEL, VERDICT_TONE, matchQualifies, provenanceLine, savingsLine, worthShowing,
  type RediscoveryMatch,
} from './rediscoveryFormat';

interface CheckResponse {
  matches: RediscoveryMatch[];
  estimateAvoidedUsd: number | null;
  estimateAvoidedMinutes: number | null;
}

async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function RediscoveryPanel({ problem, repo, initiativeId, workItemId, onUse }: {
  problem: string;
  repo?: string;
  initiativeId?: string;
  workItemId?: string;
  onUse?: () => void;
}) {
  const [resp, setResp] = useState<CheckResponse | null>(null);
  // Per-panel-instance only — dismissing a suggestion inside one modal open
  // shouldn't need a round trip before the row disappears, and the outcome
  // POST is the durable record of the dismissal, not this state.
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    setResp(null);
    if (!problem.trim()) return;
    (async () => {
      try {
        const res = await postJson('/api/rediscovery/check', { problem, repo, initiativeId, workItemId });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json() as CheckResponse;
        if (!cancelled) setResp(body);
      } catch {
        // No error state on purpose — see file header.
      }
    })();
    return () => { cancelled = true; };
  }, [problem, repo, initiativeId, workItemId]);

  function outcome(experienceId: string, action: 'used' | 'dismissed') {
    void postJson('/api/rediscovery/outcome', { experienceId, workItemId, action }).catch(() => {
      // Best-effort telemetry — losing one outcome ping shouldn't block the
      // action it's reporting on.
    });
  }

  if (!resp || !worthShowing(resp.matches)) return null;
  const shown = resp.matches.filter((m) => matchQualifies(m) && !dismissed.has(m.experienceId));
  if (shown.length === 0) return null;
  const savings = savingsLine(resp.estimateAvoidedUsd, resp.estimateAvoidedMinutes);

  return (
    <Card padding="md" className="mb-3 border-primary/30 bg-primary/5">
      <T as="div" className="text-[12.5px] font-semibold text-text-primary mb-2">Someone already hit this</T>
      <Stack gap="sm">
        {shown.map((m) => (
          <Card key={m.experienceId} padding="sm">
            <Inline gap="xs" align="center" wrap>
              <Chip tone={VERDICT_TONE[m.verdict]} size="sm">{VERDICT_LABEL[m.verdict]}</Chip>
              {m.crossProject && <Chip tone="info" size="sm">cross-project</Chip>}
              <T className="text-[12.5px] font-semibold text-text-primary">{m.title}</T>
            </Inline>
            <T as="div" className="text-[11px] text-text-tertiary mt-1">{provenanceLine(m)}</T>
            <T as="div" wrap className="text-[12px] text-text-secondary mt-1.5 leading-snug line-clamp-3">{m.body}</T>
            <T as="div" className="text-[11px] text-text-tertiary mt-1 italic">{m.why}</T>
            <Inline gap="sm" className="mt-2">
              <Button
                variant="secondary" size="sm"
                onClick={() => { outcome(m.experienceId, 'used'); onUse?.(); }}
              >
                Use this
              </Button>
              <Button
                variant="ghost" size="sm"
                onClick={() => {
                  outcome(m.experienceId, 'dismissed');
                  setDismissed((prev) => new Set(prev).add(m.experienceId));
                }}
              >
                Not the same thing
              </Button>
            </Inline>
          </Card>
        ))}
      </Stack>
      {savings && <T as="div" className="text-[11px] text-text-tertiary mt-2">{savings}</T>}
    </Card>
  );
}
