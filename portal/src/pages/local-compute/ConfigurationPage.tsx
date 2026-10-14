// Configuration is a read-only settings preview until bundles are deployed
// and reported by real sessions. The provider currently returns fixtures;
// changing its "live" row does not install anything or restart a machine.
import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Chip, CodeBlock, CollectionToolbar, DataTable, Disclosure, EmptyState, Inline, InlineAlert, LoadingState, PageSection, Stack, Tabs, Text, type DataTableColumn } from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { useUrlState } from '../../lib/useUrlState';
import { filterRows } from '../../hooks/useRowSearch';
import { CollectionCommandHost } from '../../components/collections/CollectionCommandHost';
import { configurationCommandAdapter } from './localComputeCommands';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { HOOK_EVENT_LABEL, driftLine, versionLabel } from '../release/sessionFormat';
import type { BundledSkill, SessionBundleDetail } from '../release/types';
import type { LibraryResponse } from '../library/types';

type ContentsView = 'skills' | 'hooks' | 'settings';

const AVAILABILITY_OPTIONS = [
  { value: '', label: 'Any availability' },
  { value: 'current', label: 'Up to date' },
  { value: 'stale', label: 'Update available' },
  { value: 'missing', label: 'Not in library' },
];

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

export function ConfigurationContents({ bundle, library, view, onViewChange, onRefresh }: {
  bundle: SessionBundleDetail;
  library: LibraryResponse | null;
  view: ContentsView;
  onViewChange: (view: ContentsView) => void;
  /** Re-read the bundle; given, the contents carry the skills command composer. */
  onRefresh?: () => void;
}) {
  const updates = bundle.skills.filter((skill) => skill.status === 'stale');
  // The skills table's search and availability filter, shared by its toolbar
  // and the command composer.
  const [skillQuery, setSkillQuery] = useState('');
  const [availability, setAvailability] = useState('');
  const skills = useMemo(
    () => filterRows(bundle.skills.filter((skill) => !availability || skill.status === availability), skillQuery, (skill) => `${skill.name} ${skill.id} ${skill.description}`),
    [bundle.skills, availability, skillQuery],
  );
  const commands = onRefresh ? configurationCommandAdapter({
    setQuery: setSkillQuery, setAvailability, refresh: onRefresh, showView: onViewChange,
  }) : null;
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
      <Stack gap="sm" className="min-w-0" data-collection-command-boundary="embedded">
      <Tabs aria-label="Configuration contents" value={view} onValueChange={(value) => onViewChange(value as ContentsView)} items={[
        { id: 'skills', label: `Skills · ${bundle.skills.length}` },
        { id: 'hooks', label: `Hooks · ${bundle.hooks.length}` },
        { id: 'settings', label: `Settings · ${Object.keys(bundle.settings).length}` },
      ]} />
      <Stack gap="none" className="min-w-0 overflow-x-auto py-3">
        {view === 'skills' && <Stack gap="sm" className="min-w-0">
          <CollectionToolbar
            label="Skill filters"
            search={{ value: skillQuery, onChange: setSkillQuery, placeholder: 'Search skills', 'aria-label': 'Search skills' }}
            filters={[{ id: 'availability', label: 'Availability', value: availability, onChange: setAvailability, options: AVAILABILITY_OPTIONS }]}
            summary={`${skills.length} of ${bundle.skills.length} skills`}
          />
          <DataTable data={skills} columns={columns} keyField={(skill) => skill.id} frameless
            staticRows="A skill is a capability this configuration ships to the worker; it has no page of its own." emptyMessage={bundle.skills.length > 0 ? 'No skill matches the search or availability' : 'No skills in this configuration'} />
        </Stack>}
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
        </ToggleDisclosure>)}</Stack> : <EmptyState title="No hooks" />)}
        {view === 'settings' && (Object.keys(bundle.settings).length ? <Stack gap="sm">{Object.entries(bundle.settings).map(([key, value]) => <ToggleDisclosure
          key={key}
          summary={<Text wrap className="break-words font-mono text-xs">{key}</Text>}
          verb={['Show', 'Hide']}
          noun="value"
        >
          <CodeBlock code={String(value)} language="text" theme="light" className="text-xs" />
        </ToggleDisclosure>)}</Stack> : <EmptyState title="No settings" />)}
      </Stack>
      {commands && <CollectionCommandHost adapter={commands} />}
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
      // The library read decides each skill's "Library version" and its link,
      // so the contents wait for its first answer instead of claiming
      // "version unavailable" for a read that is still in flight.
      : (isLoading && !data) || (library.isLoading && !library.data) ? <LoadingState label="Loading settings…" />
      : !data ? <EmptyState title="No configuration preview" description="No session bundle has been published yet, so sessions run with the settings baked into their image." />
      : <>
        {(library.error ?? library.degraded) && <UnavailableNotice error={library.error ?? library.degraded ?? ''} what="library versions" source={LIBRARY_VERSIONS_SOURCE} onRetry={library.refresh} />}
        <ConfigurationContents bundle={data} library={library.data ?? null} view={view} onViewChange={setView} onRefresh={refresh} />
      </>}
  </PageSection>;
}
