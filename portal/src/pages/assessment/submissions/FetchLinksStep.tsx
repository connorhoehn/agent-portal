// Step 3 of the Submissions wizard: hand-off checklist for each linked evidence URL —
// mark it fetched once the file has been collected, or skip it. Trimmed from the source
// app's FetchLinksStep.tsx: no upload dropzone or reject-reason menu here, just the
// fetched/skipped PATCH the contract calls for (docs/assessment-tenant.md).

import { useEffect, useState } from 'react';
import {
  Button, Card, CardHeader, CheckIcon, Chip, CloseIcon, DataTable, ExternalLinkIcon, IconButton, Inline, InlineAlert, Stack, T,
} from '@connorhoehnslalom/ui-components/shared';
import type { CommitResponse, LinkStatus } from '../secondaryTypes';
import { linksStepComplete, pendingLinksBanner } from '../secondaryFormat';
import { useCapabilities } from '../../../lib/capabilities';

type CommitResult = CommitResponse['results'][number];
type CommitLink = CommitResult['links'][number];

interface FetchLinksStepProps {
  commit: CommitResponse;
  onContinue: () => void;
  onBack: () => void;
  /** Fires whenever "every link fetched or skipped" flips, so the wizard shell's
   * bottom Next button can be gated by the same rule as this step's own Continue. */
  onCompletionChange?: (complete: boolean) => void;
}

export default function FetchLinksStep({ commit, onContinue, onBack, onCompletionChange }: FetchLinksStepProps) {
  const { can, ready } = useCapabilities();
  const canManage = ready && can('ManageSubmissions');

  // Local optimistic status per `${envelope_id}::${url}`, seeded from whatever the
  // commit response already recorded (a resumed/re-opened envelope may have some
  // links already resolved).
  const initial = new Map<string, LinkStatus>();
  commit.results.forEach((r) => r.links.forEach((l) => initial.set(`${r.envelope_id}::${l.url}`, l.status)));
  const [statuses, setStatuses] = useState<Map<string, LinkStatus>>(initial);
  const [errors, setErrors] = useState<Map<string, string>>(new Map());
  const [pending, setPending] = useState<Set<string>>(new Set());

  // Effective per-result link statuses (server-committed status overridden by
  // any optimistic local edit) — the single source both the InlineAlert banner
  // and the Continue/Next gating read from.
  const effectiveResults = commit.results.map((r) => ({
    links: r.links.map((l) => ({ status: statuses.get(`${r.envelope_id}::${l.url}`) ?? l.status })),
  }));
  const complete = linksStepComplete(effectiveResults);
  const unresolved = effectiveResults.reduce((n, r) => n + r.links.filter((l) => l.status === 'pending').length, 0);

  useEffect(() => {
    onCompletionChange?.(complete);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [complete]);

  async function setStatus(teamId: string, envelopeId: string, url: string, dimensionId: string | null, status: LinkStatus) {
    const key = `${envelopeId}::${url}`;
    setPending((prev) => new Set(prev).add(key));
    const prior = statuses.get(key);
    setStatuses((prev) => new Map(prev).set(key, status));
    try {
      const res = await fetch(
        `/api/assessment/submissions/${encodeURIComponent(teamId)}/${encodeURIComponent(envelopeId)}/links`,
        {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url, dimension_id: dimensionId, status }),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Couldn't update this link (HTTP ${res.status}).`);
      }
      setErrors((prev) => {
        if (!prev.has(key)) return prev;
        const next = new Map(prev);
        next.delete(key);
        return next;
      });
    } catch (err) {
      setStatuses((prev) => new Map(prev).set(key, prior ?? 'pending'));
      setErrors((prev) => new Map(prev).set(key, (err as Error).message));
    } finally {
      setPending((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }

  return (
    <Stack gap="md">
      <Stack gap="none" className="text-sm text-text-secondary">
        Download each linked evidence page, then mark it fetched — or skip it if there is nothing to add.
      </Stack>

      {commit.results.map((result) => (
        <Card key={result.envelope_id} padding="md">
          <CardHeader title={result.team_id} subtitle={result.envelope_id} />
          <DataTable<CommitLink>
            data={result.links}
            keyField={(link) => `${result.envelope_id}::${link.url}`}
            size="sm"
            emptyMessage="No evidence links on this submission."
            // One submission's evidence links — small today, bounded
            // regardless of how many a form ends up carrying.
            pageSize={10}
            columns={[
              {
                key: 'link',
                header: 'Link',
                render: (link) => <T size="sm" title={link.url}>{link.label}</T>,
              },
              {
                key: 'dimension',
                header: 'Dimension',
                render: (link) => (link.dimension_id ? <Chip tone="neutral" size="xs">Dim {link.dimension_id}</Chip> : '—'),
              },
              {
                key: 'status',
                header: 'Status',
                render: (link) => {
                  const key = `${result.envelope_id}::${link.url}`;
                  const status = statuses.get(key) ?? link.status;
                  const err = errors.get(key);
                  if (err) return <Chip tone="danger" size="xs" title={err}>{err.length > 40 ? `${err.slice(0, 40)}…` : err}</Chip>;
                  return (
                    <Chip tone={status === 'fetched' ? 'success' : status === 'skipped' ? 'neutral' : 'warning'} size="xs">
                      {status}
                    </Chip>
                  );
                },
              },
            ]}
            rowActions={(link) => {
              const key = `${result.envelope_id}::${link.url}`;
              const status = statuses.get(key) ?? link.status;
              const busy = pending.has(key);
              return (
                <>
                  <IconButton
                    size="sm"
                    icon={<ExternalLinkIcon />}
                    aria-label={`Open ${link.label}`}
                    title="Open the link in a new tab"
                    onClick={() => window.open(link.url, '_blank', 'noopener,noreferrer')}
                  />
                  {canManage && (
                    <>
                      <IconButton
                        size="sm"
                        icon={<CheckIcon />}
                        aria-label={status === 'fetched' ? `Mark ${link.label} not fetched` : `Mark ${link.label} fetched`}
                        title={status === 'fetched' ? 'Fetched — click to undo' : 'Mark fetched'}
                        disabled={busy}
                        onClick={() => void setStatus(result.team_id, result.envelope_id, link.url, link.dimension_id, status === 'fetched' ? 'pending' : 'fetched')}
                      />
                      <IconButton
                        size="sm"
                        icon={<CloseIcon />}
                        aria-label={status === 'skipped' ? `Unskip ${link.label}` : `Skip ${link.label}`}
                        title={status === 'skipped' ? 'Skipped — click to undo' : 'Skip'}
                        disabled={busy || status === 'fetched'}
                        onClick={() => void setStatus(result.team_id, result.envelope_id, link.url, link.dimension_id, status === 'skipped' ? 'pending' : 'skipped')}
                      />
                    </>
                  )}
                </>
              );
            }}
          />
        </Card>
      ))}

      {unresolved > 0 && (
        <InlineAlert tone="info">
          {pendingLinksBanner(unresolved)}
        </InlineAlert>
      )}

      <Inline align="center" justify="end" gap="sm">
        <Button variant="secondary" onClick={onBack}>← Back</Button>
        <Button onClick={onContinue} disabled={!complete}>Continue</Button>
      </Inline>
    </Stack>
  );
}
