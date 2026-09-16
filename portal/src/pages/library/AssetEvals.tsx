// The eval panel — the piece that turns "never evaluated" (AssetDrawer's
// Health & usage panel, when evalPassRate is null) into something a reviewer
// can act on: what the suite actually checks, what the last run found per
// case, and a button to run it again against the version on screen.
//
// Self-contained by design (see the module header this was built under): the
// drawer owner drops it in wherever it fits rather than this file reaching
// into AssetDrawer's layout decisions.

import { useState } from 'react';
import {
  Button, Card, Chip, DetailSection, EmptyState, Inline, InlinePlaceholder, LoadingState, ProgressBar, Stack,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { useCapabilities } from '../../lib/capabilities';
import { toastError, toastPending, toastSuccess } from '../../lib/toastStore';
import { writeJson } from '../../lib/writeJson';
import { T } from './Text';
import {
  assertionSummary, caseResultFor, formatPassRate, latestRun, progressColor,
  type EvalCase, type EvalRun,
} from './evalFormat';

export function AssetEvals({ assetId, version }: { assetId: string; version: string }) {
  const [busy, setBusy] = useState(false);
  const base = `/api/library/evals/${encodeURIComponent(assetId)}`;
  // ManageBots — the same gate the server's run route enforces
  // (middleware/src/routes/prompt-evals.ts). Without this, a member saw a
  // live-looking "Run evals" button that always 403'd with no explanation
  // (DEFECTS.md #11). Same pattern as the Promotions drawer (#3).
  const { can, ready } = useCapabilities();
  const canRun = ready && can('ManageBots');

  const { data: casesData, isLoading: casesLoading, error: casesError } =
    useFetch<{ cases: EvalCase[] }>(`${base}/cases`, 0);
  const { data: runsData, isLoading: runsLoading, error: runsError, refresh: refreshRuns } =
    useFetch<{ runs: EvalRun[] }>(`${base}/runs`, 0);

  async function runNow() {
    if (busy) return;
    setBusy(true);
    const tid = toastPending('Running evals', `v${version}`);
    const res = await writeJson<EvalRun & { error?: string; action?: string }>(`${base}/run`, 'POST', { version });
    // Surface the server's own text plus which capability it wanted — a
    // stale capability cache can still let a disallowed request through to
    // here, and a bare "Forbidden" toast gave no next step (DEFECTS.md #11).
    if (!res.ok || !res.data) {
      const body = res.data;
      const message = body?.action
        ? `${body.error ?? 'Forbidden'} — Run evals needs ${body.action}.`
        : (res.error ?? `HTTP ${res.status}`);
      toastError(tid, 'Eval run failed', message);
      setBusy(false);
      return;
    }
    toastSuccess(tid, 'Eval run complete', `${formatPassRate(res.data.passRate)} — ${res.data.passed}/${res.data.total} passed`);
    refreshRuns();
    setBusy(false);
  }

  if (casesError) return <EmptyState title="Could not load the eval set" description={casesError} />;
  if (casesLoading || !casesData) return <LoadingState label="Loading eval set…" />;

  const cases = casesData.cases;
  const runs = runsData?.runs ?? [];
  const latest = latestRun(runs);
  const rate = latest?.passRate ?? null;

  return (
    <Stack gap="lg">
      <DetailSection
        first
        title="Eval set"
        hint={cases.length === 0 ? 'no cases yet' : `${cases.length} case${cases.length === 1 ? '' : 's'}`}
      >
        {cases.length === 0 ? (
          <InlinePlaceholder>No eval set for this asset — nothing here can satisfy the gate above sandbox.</InlinePlaceholder>
        ) : (
          <Card padding="none">
            {cases.map((c) => (
              <Inline key={c.id} gap="xs" wrap={false} className="items-start gap-2.5 border-b border-border bg-surface px-3 py-2 last:border-b-0">
                <T className="min-w-0 flex-1 truncate text-[12px] text-text-primary" title={c.name}>{c.name}</T>
                <Chip tone="neutral" size="xs">{assertionSummary(c.assertions.length)}</Chip>
              </Inline>
            ))}
          </Card>
        )}
      </DetailSection>

      <DetailSection
        title="Latest run"
        hint={runsLoading ? undefined : (latest ? `ran by ${latest.ranBy} on v${latest.version}` : undefined)}
        actions={
          canRun ? (
            <Button size="sm" variant="secondary" disabled={busy || cases.length === 0} onClick={() => void runNow()}>
              {busy ? 'Running…' : 'Run evals'}
            </Button>
          ) : (
            <T className="text-[11px] text-text-tertiary">Running evals needs Manage bots.</T>
          )
        }
      >
        {runsError ? (
          <T className="text-[12px] text-text-tertiary">{runsError}</T>
        ) : runsLoading ? (
          <LoadingState label="Loading run history…" />
        ) : !latest ? (
          <InlinePlaceholder>Never evaluated — run the suite to produce the pass rate the release gate reads.</InlinePlaceholder>
        ) : (
          <Stack gap="sm">
            <div>
              <T as="div" className="mb-1 text-[11px] text-text-tertiary">
                Pass rate — {formatPassRate(rate)} ({latest.passed}/{latest.total})
              </T>
              <ProgressBar
                value={Math.round((rate ?? 0) * 100)}
                max={100}
                size="sm"
                showRatio={false}
                color={progressColor(rate)}
                aria-label="Eval pass rate"
              />
            </div>
            <Card padding="none">
              {cases.map((c) => {
                const result = caseResultFor(latest, c.id);
                return (
                  <Stack key={c.id} gap="none" className="border-b border-border bg-surface px-3 py-2 last:border-b-0">
                    <Inline gap="xs" wrap={false}>
                      <T className="min-w-0 flex-1 truncate text-[12px] text-text-primary" title={c.name}>{c.name}</T>
                      {result == null ? (
                        <Chip tone="neutral" size="xs">not run</Chip>
                      ) : result.passed ? (
                        <Chip tone="success" size="xs">pass</Chip>
                      ) : (
                        <Chip tone="danger" size="xs">fail</Chip>
                      )}
                    </Inline>
                    {result && !result.passed && result.failures.length > 0 && (
                      <Stack as="ul" gap="none" className="m-0 mt-1 list-none pl-0">
                        {result.failures.map((f, i) => (
                          <T as="li" key={i} className="text-[11px] leading-relaxed text-text-tertiary">{f}</T>
                        ))}
                      </Stack>
                    )}
                  </Stack>
                );
              })}
            </Card>
          </Stack>
        )}
      </DetailSection>
    </Stack>
  );
}
