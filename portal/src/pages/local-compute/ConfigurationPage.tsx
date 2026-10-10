// Configuration is a read-only settings preview until bundles are deployed
// and reported by real sessions. The provider currently returns fixtures;
// changing its "live" row does not install anything or restart a machine.
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Chip, CodeBlock, DataTable, Disclosure, EmptyState, Inline, InlineAlert, LoadingState, PageSection, Stack, Tabs, Text, type DataTableColumn } from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { useUrlState } from '../../lib/useUrlState';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { HOOK_EVENT_LABEL, driftLine, versionLabel } from '../release/sessionFormat';
import type { BundledSkill, SessionBundleDetail } from '../release/types';
import type { LibraryResponse } from '../library/types';

type ContentsView = 'skills' | 'hooks' | 'settings';

/** Where each read comes from, as the clause UnavailableNotice joins to
 *  "…, so this is unknown rather than empty." — not a bare noun. */
const BUNDLE_SOURCE = 'Session settings are read from the session bundle service';
const LIBRARY_VERSIONS_SOURCE = 'Library versions are read from the Agent library catalog';

/**
 * A Disclosure whose hint says what the click does NOW — "Show value" while
 * closed, "Hide value" while open. The library's Disclosure takes a static
 * hint, so the open state is held here (controlled) to word it.
 */
function ToggleDisclosure({ summary, lead, verb, noun, bodyClassName, children }: {
  summary: ReactNode;
  /** Muted text before the toggle wording, e.g. "Enabled". */
  lead?: ReactNode;
  verb: [show: string, hide: string];
  noun: string;
  bodyClassName?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return <Disclosure
    summary={summary}
    open={open}
    onToggle={setOpen}
    hint={<Inline wrap className="gap-x-3 text-xs">{lead}<Text className="text-primary">{open ? verb[1] : verb[0]} {noun}</Text></Inline>}
    {...(bodyClassName ? { bodyClassName } : {})}
  >
    {children}
  </Disclosure>;
}

export function ConfigurationContents({ bundle, library, view, onViewChange }: {
  bundle: SessionBundleDetail;
  library: LibraryResponse | null;
  view: ContentsView;
  onViewChange: (view: ContentsView) => void;
}) {
  const updates = bundle.skills.filter((skill) => skill.status === 'stale');
  const columns: DataTableColumn<BundledSkill>[] = [
    { key: 'name', header: 'Skill', render: (skill) => <Stack gap="none" className="min-w-0"><Text as="div" className="text-[13px] font-medium">{skill.name}</Text><Text as="div" wrap className="text-xs text-text-secondary">{skill.description}</Text></Stack> },
    { key: 'version', header: 'In configuration', render: (skill) => <Text className="whitespace-nowrap font-mono text-xs">{versionLabel(skill.version)}</Text> },
    { key: 'library', header: 'Library version', render: (skill) => {
      const asset = library?.assets.find((asset) => asset.id === skill.id);
      return <Text className="whitespace-nowrap font-mono text-xs">{asset ? versionLabel(asset.version) : library ? 'Not listed' : 'Unavailable'}</Text>;
    } },
    { key: 'status', header: 'Availability', render: (skill) => <Chip size="xs" tone={skill.status === 'stale' ? 'info' : 'neutral'}>{skill.status === 'stale' ? 'Update available' : skill.status === 'missing' ? 'Not in library' : 'Up to date'}</Chip> },
  ];
  return <Stack gap="md" className="text-[13px]">
    <InlineAlert tone="info">
      Read-only preview using example bundle data. Installed configuration versions are not reported by machines or sessions yet. Publishing and rollout tracking are not connected.
    </InlineAlert>
    <Inline wrap align="center" className="gap-x-3 gap-y-1 border-b border-border pb-4">
      <Inline as="h2" className="text-sm font-semibold">Configuration preview {versionLabel(bundle.version)}</Inline>
      <Chip size="xs" tone="neutral">Example data</Chip>
      <Text className="text-xs text-text-secondary">Example publication: {new Date(bundle.publishedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</Text>
      <Text className="text-xs text-text-secondary">Machine assignments: not reported</Text>
    </Inline>
    <Stack as="section" aria-label="Updates available" gap="sm">
      <Inline as="h2" className="text-sm font-semibold">{driftLine(bundle) ?? 'No updates available'}</Inline>
      <Text as="p" wrap className="text-text-secondary">A newer library version does not automatically update a session.</Text>
      {updates.map((skill) => {
        const asset = library?.assets.find((asset) => asset.id === skill.id);
        // "Details", not "Review changes": the bundle records a version, not
        // the content it shipped, so there is no diff to review — only the
        // two versions and the library's current description (sme #21).
        return <ToggleDisclosure
          key={skill.id}
          summary={<Text className="font-medium">{skill.name}</Text>}
          lead={<Text className="text-text-secondary">In configuration {versionLabel(skill.version)} → Library {asset ? versionLabel(asset.version) : 'version unavailable'}</Text>}
          verb={['Show', 'Hide']}
          noun="details"
          bodyClassName="text-text-secondary"
        >
          <Stack gap="sm">
            <Text as="p" wrap>{asset?.description ?? skill.description}</Text>
            <Text as="p" wrap>The bundle records which version it ships, not that version's content, so no content diff is available here, and nothing is applied from this page.</Text>
            {asset && <Link className="text-primary hover:underline" to={`/iq/library/${encodeURIComponent(skill.id)}`}>Open library skill →</Link>}
          </Stack>
        </ToggleDisclosure>;
      })}
    </Stack>
    <Stack as="section" aria-label="Configuration contents" gap="sm" className="min-w-0">
      <Inline as="h2" className="text-sm font-semibold">Configuration contents</Inline>
      <Tabs aria-label="Configuration contents" value={view} onValueChange={(value) => onViewChange(value as ContentsView)} items={[
        { id: 'skills', label: `Skills · ${bundle.skills.length}` },
        { id: 'hooks', label: `Hooks · ${bundle.hooks.length}` },
        { id: 'settings', label: `Settings · ${Object.keys(bundle.settings).length}` },
      ]} />
      <Stack gap="none" className="min-w-0 overflow-x-auto py-3">
        {view === 'skills' && <DataTable data={bundle.skills} columns={columns} keyField={(skill) => skill.id} frameless emptyMessage="No skills in this configuration" />}
        {view === 'hooks' && (bundle.hooks.length ? <Stack gap="sm">{bundle.hooks.map((hook, index) => <ToggleDisclosure
          key={`${hook.event}-${index}`}
          summary={<Text className="font-medium">{HOOK_EVENT_LABEL[hook.event]}</Text>}
          lead={<Text className="text-text-secondary">{hook.enabled ? 'Enabled' : 'Disabled'}</Text>}
          verb={['Show', 'Hide']}
          noun="command"
        >
          <Stack gap="sm">
            <Text as="p" wrap className="text-text-secondary">{hook.description}</Text>
            <CodeBlock code={hook.command} language="bash" theme="light" className="text-xs" />
          </Stack>
        </ToggleDisclosure>)}</Stack> : <EmptyState size="sm" title="No hooks" />)}
        {view === 'settings' && (Object.keys(bundle.settings).length ? <Stack gap="sm">{Object.entries(bundle.settings).map(([key, value]) => <ToggleDisclosure
          key={key}
          summary={<Text wrap className="break-words font-mono text-xs">{key}</Text>}
          verb={['Show', 'Hide']}
          noun="value"
        >
          <CodeBlock code={String(value)} language="text" theme="light" className="text-xs" />
        </ToggleDisclosure>)}</Stack> : <EmptyState size="sm" title="No settings" />)}
      </Stack>
    </Stack>
    <Text as="p" wrap className="border-t border-border pt-3 text-xs text-text-secondary">Version history and rollout results will appear when persistent configuration publishing, session version reporting, and rollout tracking are implemented. Until then, this page cannot apply updates or restart sessions.</Text>
  </Stack>;
}

export default function ConfigurationPage() {
  const { data, isLoading, error, degraded, refresh } = useFetch<SessionBundleDetail>('/api/session-bundle/live', 30_000);
  const library = useFetch<LibraryResponse>('/api/library?kind=skill&tier=all&limit=200', 60_000);
  const [view, setView] = useUrlState<ContentsView>('contents', (raw) => raw === 'hooks' || raw === 'settings' ? raw : 'skills', (value) => value === 'skills' ? null : value);
  const failure = error ?? degraded;
  // GET /api/session-bundle/live answers `null` when nothing has been
  // published (not a 404), so the empty state below is reachable; `failure`
  // is only ever a real failure to read.
  return <PageSection title="Session settings" description="Inspect bundled skills, hooks, and settings. Runtime configuration management is not available yet.">
    {failure ? <UnavailableNotice error={failure} what="configuration preview" source={BUNDLE_SOURCE} onRetry={refresh} />
      : isLoading && !data ? <LoadingState label="Loading settings…" />
      : !data ? <EmptyState size="sm" title="No configuration preview" description="No session bundle has been published yet, so sessions run with the settings baked into their image." />
      : <>
        {(library.error ?? library.degraded) && <UnavailableNotice error={library.error ?? library.degraded ?? ''} what="library versions" source={LIBRARY_VERSIONS_SOURCE} onRetry={library.refresh} />}
        <ConfigurationContents bundle={data} library={library.data ?? null} view={view} onViewChange={setView} />
      </>}
  </PageSection>;
}
