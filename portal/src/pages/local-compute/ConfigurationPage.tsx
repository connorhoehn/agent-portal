// Configuration is a read-only settings preview until bundles are deployed
// and reported by real sessions. The provider currently returns fixtures;
// changing its "live" row does not install anything or restart a machine.
import { Link } from 'react-router';
import { Chip, DataTable, EmptyState, InlineAlert, LoadingState, PageSection, Stack, Tabs, type DataTableColumn } from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { useUrlState } from '../../lib/useUrlState';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { HOOK_EVENT_LABEL, driftLine, versionLabel } from '../release/sessionFormat';
import type { BundledSkill, SessionBundleDetail } from '../release/types';
import type { LibraryResponse } from '../library/types';

type ContentsView = 'skills' | 'hooks' | 'settings';

export function ConfigurationContents({ bundle, library, view, onViewChange }: {
  bundle: SessionBundleDetail;
  library: LibraryResponse | null;
  view: ContentsView;
  onViewChange: (view: ContentsView) => void;
}) {
  const updates = bundle.skills.filter((skill) => skill.status === 'stale');
  const columns: DataTableColumn<BundledSkill>[] = [
    { key: 'name', header: 'Skill', render: (skill) => <div className="min-w-0"><div className="text-[13px] font-medium">{skill.name}</div><div className="text-xs text-text-secondary">{skill.description}</div></div> },
    { key: 'version', header: 'In configuration', render: (skill) => <span className="whitespace-nowrap font-mono text-xs">{versionLabel(skill.version)}</span> },
    { key: 'library', header: 'Library version', render: (skill) => {
      const asset = library?.assets.find((asset) => asset.id === skill.id);
      return <span className="whitespace-nowrap font-mono text-xs">{asset ? versionLabel(asset.version) : library ? 'Not listed' : 'Unavailable'}</span>;
    } },
    { key: 'status', header: 'Availability', render: (skill) => <Chip size="xs" tone={skill.status === 'stale' ? 'info' : 'neutral'}>{skill.status === 'stale' ? 'Update available' : skill.status === 'missing' ? 'Not in library' : 'Up to date'}</Chip> },
  ];
  return <Stack gap="md" className="text-[13px]">
    <InlineAlert tone="info">
      Read-only preview using example bundle data. Installed configuration versions are not reported by machines or sessions yet. Publishing and rollout tracking are not connected.
    </InlineAlert>
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border pb-4">
      <h2 className="text-sm font-semibold">Configuration preview {versionLabel(bundle.version)}</h2>
      <Chip size="xs" tone="neutral">Example data</Chip>
      <span className="text-xs text-text-secondary">Example publication: {new Date(bundle.publishedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
      <span className="text-xs text-text-secondary">Machine assignments: not reported</span>
    </div>
    <section aria-label="Updates available" className="space-y-2">
      <h2 className="text-sm font-semibold">{driftLine(bundle) ?? 'No updates available'}</h2>
      <p className="text-text-secondary">A newer library version does not automatically update a session.</p>
      {updates.map((skill) => {
        const asset = library?.assets.find((asset) => asset.id === skill.id);
        return <details key={skill.id} className="rounded-md border border-border px-3 py-2">
          <summary className="cursor-pointer text-text-primary">
            <span className="font-medium">{skill.name}</span>
            <span className="ml-3 text-xs text-text-secondary">In configuration {versionLabel(skill.version)} → Library {asset ? versionLabel(asset.version) : 'version unavailable'}</span>
            <span className="ml-3 text-xs text-primary">Review changes</span>
          </summary>
          <div className="mt-3 space-y-2 border-t border-border pt-3 text-text-secondary">
            <p>{asset?.description ?? skill.description}</p>
            <p>Version comparison only. A content diff and the list of machines or sessions that would restart are not available. Nothing is applied from this page.</p>
            {asset && <Link className="text-primary hover:underline" to={`/iq/library/${encodeURIComponent(skill.id)}`}>Open library skill →</Link>}
          </div>
        </details>;
      })}
    </section>
    <section aria-label="Configuration contents" className="min-w-0">
      <h2 className="mb-2 text-sm font-semibold">Configuration contents</h2>
      <Tabs aria-label="Configuration contents" value={view} onValueChange={(value) => onViewChange(value as ContentsView)} items={[
        { id: 'skills', label: `Skills · ${bundle.skills.length}` },
        { id: 'hooks', label: `Hooks · ${bundle.hooks.length}` },
        { id: 'settings', label: `Settings · ${Object.keys(bundle.settings).length}` },
      ]} />
      <div className="min-w-0 overflow-x-auto py-3">
        {view === 'skills' && <DataTable data={bundle.skills} columns={columns} keyField={(skill) => skill.id} frameless emptyMessage="No skills in this configuration" />}
        {view === 'hooks' && (bundle.hooks.length ? <div className="space-y-2">{bundle.hooks.map((hook, index) => <details key={`${hook.event}-${index}`} className="rounded-md border border-border px-3 py-2">
          <summary className="cursor-pointer"><span className="font-medium">{HOOK_EVENT_LABEL[hook.event]}</span><span className="ml-3 text-xs text-text-secondary">{hook.enabled ? 'Enabled' : 'Disabled'} · Show command</span></summary>
          <p className="my-2 text-text-secondary">{hook.description}</p>
          <pre className="overflow-x-auto rounded bg-surface-inset p-3 text-xs">{hook.command}</pre>
        </details>)}</div> : <EmptyState size="sm" title="No hooks" />)}
        {view === 'settings' && (Object.keys(bundle.settings).length ? <div className="space-y-2">{Object.entries(bundle.settings).map(([key, value]) => <details key={key} className="rounded-md border border-border px-3 py-2">
          <summary className="cursor-pointer break-words font-mono text-xs">{key}<span className="ml-3 font-sans text-text-secondary">Show value</span></summary>
          <pre className="mt-2 overflow-x-auto rounded bg-surface-inset p-3 text-xs">{String(value)}</pre>
        </details>)}</div> : <EmptyState size="sm" title="No settings" />)}
      </div>
    </section>
    <p className="border-t border-border pt-3 text-xs text-text-secondary">Version history and rollout results will appear when persistent configuration publishing, session version reporting, and rollout tracking are implemented. Until then, this page cannot apply updates or restart sessions.</p>
  </Stack>;
}

export default function ConfigurationPage() {
  const { data, isLoading, error, degraded, refresh } = useFetch<SessionBundleDetail>('/api/session-bundle/live', 30_000);
  const library = useFetch<LibraryResponse>('/api/library?kind=skill&tier=all&limit=200', 60_000);
  const [view, setView] = useUrlState<ContentsView>('contents', (raw) => raw === 'hooks' || raw === 'settings' ? raw : 'skills', (value) => value === 'skills' ? null : value);
  const failure = error ?? degraded;
  return <PageSection title="Session settings" description="Inspect bundled skills, hooks, and settings. Runtime configuration management is not available yet.">
    {failure ? <UnavailableNotice error={failure} what="configuration preview" source="Session bundle provider" onRetry={refresh} />
      : isLoading && !data ? <LoadingState label="Loading settings…" />
      : !data ? <EmptyState size="sm" title="No configuration preview" />
      : <>
        {(library.error ?? library.degraded) && <UnavailableNotice error={library.error ?? library.degraded ?? ''} what="library versions" source="Agent library" onRetry={library.refresh} />}
        <ConfigurationContents bundle={data} library={library.data ?? null} view={view} onViewChange={setView} />
      </>}
  </PageSection>;
}
