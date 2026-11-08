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
import { Button, Card, Chip, Inline, Stack } from '@connorhoehn/ui-components/shared';
import { writeJson } from '../../lib/writeJson';
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
        const res = await writeJson<CheckResponse>('/api/rediscovery/check', 'POST', { problem, repo, initiativeId, workItemId });
        if (!res.ok || !res.data) throw new Error(res.error ?? 'rediscovery check failed');
        if (!cancelled) setResp(res.data);
      } catch {
        // No error state on purpose — see file header.
      }
    })();
    return () => { cancelled = true; };
  }, [problem, repo, initiativeId, workItemId]);

  function outcome(experienceId: string, action: 'used' | 'dismissed') {
    // Best-effort telemetry — losing one outcome ping shouldn't block the
    // action it's reporting on, so the result is intentionally unawaited
    // and unchecked.
    void writeJson('/api/rediscovery/outcome', 'POST', { experienceId, workItemId, action });
  }

  if (!resp || !worthShowing(resp.matches)) return null;
  const shown = resp.matches.filter((m) => matchQualifies(m) && !dismissed.has(m.experienceId));
  if (shown.length === 0) return null;
  const savings = savingsLine(resp.estimateAvoidedUsd, resp.estimateAvoidedMinutes);

  return (
    <Card padding="md" className="mb-3 border-primary/30 bg-primary/5">
      <T size="xs" as="div" className="font-semibold text-text-primary mb-2">Someone already hit this</T>
      <Stack gap="sm">
        {shown.map((m) => (
          <Card key={m.experienceId} padding="sm">
            <Inline gap="xs" align="center" wrap>
              <Chip tone={VERDICT_TONE[m.verdict]} size="sm">{VERDICT_LABEL[m.verdict]}</Chip>
              {m.crossProject && <Chip tone="info" size="sm">cross-project</Chip>}
              <T size="xs" className="font-semibold text-text-primary">{m.title}</T>
            </Inline>
            <T size="xs" as="div" className="text-text-tertiary mt-1">{provenanceLine(m)}</T>
            <T size="xs" as="div" wrap className="text-text-secondary mt-1.5 leading-snug line-clamp-3">{m.body}</T>
            <T size="xs" as="div" className="text-text-tertiary mt-1 italic">{m.why}</T>
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
      {savings && <T size="xs" as="div" className="text-text-tertiary mt-2">{savings}</T>}
    </Card>
  );
}
