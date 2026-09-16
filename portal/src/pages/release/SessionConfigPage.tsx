// Release → Session configuration. What every Claude Code devbox session is
// actually running, and the one lever an operator has: ship a new bundle.
//
// Today this whole mechanism is agents/devbox/managed-settings.json baked
// into the image at build time — a SessionStart hook nobody in the portal
// can see. This page makes it visible: the live bundle's hooks (the
// SessionStart hook is the headline — it fires on every session, fleet-wide,
// unattended), its bundled skills against the library's current versions,
// and a Publish action for the pending bundle that surfaces exactly why a
// publish is refused rather than a bare 403/409.

import {
  Button, Card, Chip, DataTable, EmptyState, InlineAlert, Inline, LoadingState,
  PageSection, Stack, StatStrip, Toolbar, ToolbarGroup, ToolbarLabel,
  type DataTableColumn,
} from '@connorhoehnslalom/ui-components/shared';
import { Link } from 'react-router';
import { KeyValue } from '../../components/KeyValue';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { useFetch } from '../../hooks/useFetch';
import { useCapabilities } from '../../lib/capabilities';
import { relativeTime } from '../../lib/relativeTime';
import { toastError, toastSuccess } from '../../lib/toastStore';
import {
  HOOK_EVENT_LABEL, SKILL_STATUS_LABEL, STATUS_LABEL, STATUS_TONE,
  driftLine, publishBlockedReason, skillStatusTone,
} from './sessionFormat';
import { T } from './Text';
import type { BundledSkill, SessionBundleDetail, SessionBundleListResponse, SessionHook } from './types';

function HookCard({ hook }: { hook: SessionHook }) {
  const isSessionStart = hook.event === 'SessionStart';
  return (
    <Card padding={isSessionStart ? 'lg' : 'md'} className={isSessionStart ? 'border-primary/40' : undefined}>
      <Inline gap="xs" wrap>
        <Chip tone={isSessionStart ? 'accent' : 'neutral'} size="xs">{HOOK_EVENT_LABEL[hook.event]}</Chip>
        <Chip tone={hook.enabled ? 'success' : 'neutral'} size="xs">{hook.enabled ? 'enabled' : 'disabled'}</Chip>
        {isSessionStart && <T className="text-[11px] text-text-tertiary">runs on every session, fleet-wide</T>}
      </Inline>
      <Card padding="sm" className="mt-2">
        <T as="div" className="font-mono text-[12px] text-text-primary">{hook.command}</T>
      </Card>
      <T as="div" className="mt-2 mb-0 text-[12px] leading-relaxed text-text-secondary" wrap>{hook.description}</T>
    </Card>
  );
}

function SkillsTable({ skills }: { skills: BundledSkill[] }) {
  const columns: DataTableColumn<BundledSkill>[] = [
    {
      key: 'name', header: 'Skill',
      render: (s) => (
        <Stack gap="none" className="min-w-0">
          <T as="div" className="text-[13px] font-semibold text-text-primary truncate">{s.name}</T>
          <T as="div" className="text-[11px] text-text-tertiary truncate" title={s.description}>{s.description}</T>
        </Stack>
      ),
    },
    {
      key: 'source', header: 'Source',
      render: (s) => <Chip tone="neutral" size="xs">{s.source}</Chip>,
    },
    {
      key: 'version', header: 'Version', align: 'right',
      render: (s) => <T className="font-mono text-[12px] text-text-secondary">v{s.version}</T>,
    },
    {
      key: 'status', header: 'Status', align: 'right',
      render: (s) => (
        <Chip tone={skillStatusTone(s.status)} size="xs">{SKILL_STATUS_LABEL[s.status]}</Chip>
      ),
    },
  ];
  return (
    <DataTable<BundledSkill>
      data={skills}
      columns={columns}
      keyField={(s) => s.id}
      pageSize={10}
      emptyMessage="No bundled skills"
    />
  );
}

function PublishAction({ bundle, onPublished }: { bundle: SessionBundleDetail; onPublished: () => void }) {
  const { can, ready } = useCapabilities();
  const staticReason = publishBlockedReason(bundle);

  async function publish() {
    try {
      const res = await fetch(`/api/session-bundle/${encodeURIComponent(bundle.id)}/publish`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        // No dry-run box picker yet on this page — publish surfaces the
        // real refusal below rather than pretending a dry run happened.
        body: JSON.stringify({}),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (res.status === 409) {
        toastError(null, 'Publish refused', body.error ?? 'This bundle cannot ship to the fleet yet.');
        return;
      }
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      toastSuccess(null, 'Published', `${bundle.id} is now live for ${bundle.sessionsAffected} session${bundle.sessionsAffected === 1 ? '' : 's'}.`);
      onPublished();
    } catch (err) {
      toastError(null, 'Could not publish', (err as Error).message);
    }
  }

  if (ready && !can('ManageDevbox')) {
    return (
      <T className="text-[11px] text-text-tertiary" wrap>
        Publishing this bundle needs Manage devbox — an SME or HR admin can publish it from this page.
      </T>
    );
  }

  return (
    <Stack gap="xs">
      <Button
        variant="primary"
        size="sm"
        className="w-fit"
        disabled={staticReason != null}
        onClick={() => void publish()}
      >
        Publish to fleet
      </Button>
      {staticReason && (
        <T className="text-[11px] text-danger">{staticReason}</T>
      )}
      {!staticReason && (
        <T className="text-[11px] text-text-tertiary" wrap>
          Needs a passing dry run on a box — start one in{' '}
          <Link to="/admin/devbox" className="text-primary hover:underline">Computer Lab</Link>
          {' '}— and a named approver; a real refusal from the server will show here if either is missing.
        </T>
      )}
    </Stack>
  );
}

export default function SessionConfigPage() {
  const { data: live, isLoading: liveLoading, error: liveError, degraded: liveDegraded, refresh: refreshLive } =
    useFetch<SessionBundleDetail>('/api/session-bundle/live', 30_000);
  const liveFailure = liveError ?? liveDegraded;
  const { data: list, refresh: refreshList } = useFetch<SessionBundleListResponse>('/api/session-bundle', 30_000);

  const pending = list?.bundles.find((b) => b.status === 'pending') ?? null;
  const drift = live ? driftLine(live) : null;

  function refreshAll() {
    refreshLive();
    refreshList();
  }

  return (
    <PageSection
      title="Session configuration"
      description="What every Claude Code devbox session is configured with — hooks, bundled skills, and settings — and the drift between what shipped and what the library now holds."
    >
      {liveFailure ? (
        <UnavailableNotice
          error={liveFailure}
          what="the live bundle"
          source="The live bundle is read from the devbox fleet"
          onRetry={refreshLive}
        />
      ) : liveLoading && !live ? (
        <LoadingState label="Loading the live bundle…" />
      ) : !live ? (
        <EmptyState title="No live bundle" description="Nothing has ever been published to the fleet." />
      ) : (
        <Stack gap="lg">
          <StatStrip
            aria-label="Live bundle"
            items={[
              { label: 'Live version', value: live.version, hint: `published ${relativeTime(live.publishedAt)} by ${live.publishedBy}` },
              { label: 'Sessions affected', value: live.sessionsAffected, hint: 'boxes a republish would restart' },
              { label: 'Bundled skills', value: live.skills.length },
              ...(drift ? [{ label: 'Drift', value: drift, tone: 'danger' as const }] : []),
            ]}
          />

          <section>
            <Toolbar size="sm" aria-label="Bundled skills">
              <ToolbarGroup>
                <ToolbarLabel>Bundled skills</ToolbarLabel>
              </ToolbarGroup>
            </Toolbar>
            <SkillsTable skills={live.skills} />
          </section>

          <section>
            <Toolbar size="sm" aria-label="Hooks">
              <ToolbarGroup>
                <ToolbarLabel>Hooks</ToolbarLabel>
              </ToolbarGroup>
            </Toolbar>
            {live.hooks.length === 0 ? (
              <EmptyState title="No hooks" description="This bundle injects nothing at session lifecycle events." />
            ) : (
              <Inline gap="md" wrap className="items-stretch [&>*]:flex-1 [&>*]:min-w-[280px]">
                {live.hooks.map((h, i) => <HookCard key={`${h.event}-${i}`} hook={h} />)}
              </Inline>
            )}
          </section>

          {Object.keys(live.settings).length > 0 && (
            <section>
              <Toolbar size="sm" aria-label="Settings">
                <ToolbarGroup>
                  <ToolbarLabel>Settings</ToolbarLabel>
                </ToolbarGroup>
              </Toolbar>
              <Card padding="md">
                <Stack gap="xs">
                  {Object.entries(live.settings).map(([k, v]) => (
                    <KeyValue key={k} layout="row" label={k} value={String(v)} labelWidth="w-48" mono />
                  ))}
                </Stack>
              </Card>
            </section>
          )}
        </Stack>
      )}

      {pending && (
        <Stack as="section" gap="sm" className="mt-6">
          <Toolbar size="sm" aria-label="Pending bundle">
            <ToolbarGroup>
              <ToolbarLabel>Pending — {pending.id}</ToolbarLabel>
              <Chip tone={STATUS_TONE[pending.status]} size="xs">{STATUS_LABEL[pending.status]}</Chip>
            </ToolbarGroup>
          </Toolbar>
          <Card padding="lg">
            <Stack gap="md">
              <InlineAlert tone={driftLine(pending) ? 'warning' : 'info'}>
                Prepared by {pending.publishedBy} · {relativeTime(pending.publishedAt)} · would affect{' '}
                {pending.sessionsAffected} session{pending.sessionsAffected === 1 ? '' : 's'} on publish.
                {driftLine(pending)
                  ? ` This bundle itself still carries drift: ${driftLine(pending)}.`
                  : drift ? ` Publishing this clears the live bundle's current drift (${drift}).` : ''}
              </InlineAlert>
              <SkillsTable skills={pending.skills} />
              <PublishAction bundle={pending} onPublished={refreshAll} />
            </Stack>
          </Card>
        </Stack>
      )}
    </PageSection>
  );
}
