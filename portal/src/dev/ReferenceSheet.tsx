// Dev-only design reference sheet (/dev/reference-sheet, registered only when
// import.meta.env.DEV). Every tile is a live library component with fixture
// data, captioned with its tile id, component, subpath and state, so an image
// model can be pointed at "tile F-7" and copy the real product instead of
// inventing one. scripts/design/render-reference-sheet.mjs screenshots it into
// docs/design/ and records each tile's box in reference-sheet.json.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import {
  Avatar,
  Badge,
  Breadcrumbs,
  Button,
  Card,
  CardHeader,
  ChannelHeader,
  ChatIcon,
  Checkbox,
  Chip,
  CollectionPage,
  DataTable,
  DotMeter,
  EmptyState,
  ErrorState,
  ExpertCard,
  FormField,
  IconButton,
  Inline,
  Input,
  KPIGrid,
  LoadingState,
  NotificationBell,
  NotificationCenter,
  PageHeader,
  PageSection,
  PaneHeader,
  PresenceAvatars,
  PresenceDot,
  ProgressBar,
  SearchIcon,
  SearchInput,
  SectionLayout,
  SegmentedControl,
  Select,
  Stack,
  StatCard,
  StatusPill,
  SubNavLayout,
  Switch,
  T,
  Tabs,
  Textarea,
  type DataTableColumn,
  type StackGap,
} from '@connorhoehn/ui-components/shared';
import { ChatPanel } from '@connorhoehn/ui-components/social';
import { ContextComposer, ConversationInputProvider } from '@connorhoehn/ui-components/social/rich-composer';
import { AudioLevelMeter, CallTileRow, HuddleBar, ParticipantTile, SettingsGearIcon } from '@connorhoehn/ui-components/video';
import {
  VOICE_PHASES,
  VOICE_PHASE_LABEL,
  VoiceActivityRing,
  VoiceConfirmCard,
  VoiceDock,
  VoiceTurnStrip,
  type VoicePhase,
} from '@connorhoehn/ui-components/voice';
import {
  COLOR_TOKENS,
  INITIATIVES,
  MESSAGES,
  NOTIFICATIONS,
  PENDING,
  PEOPLE,
  PRIMARY_NAV,
  SECTION_NAV,
  STATUS_TONE,
  TURNS,
  TURNS_FAILED,
  noop,
  type Initiative,
} from './referenceSheetData';

// ── Tile frame ─────────────────────────────────────────────────────────────
// The sheet is 1536px wide (1600 viewport, 32px gutters); tiles wrap with the
// library's `lg` gap (16px), so four quarters, three thirds or two halves fill a row.
type Width = 'quarter' | 'third' | 'half' | 'twoThirds' | 'full';
const WIDTH: Record<Width, string> = {
  quarter: 'w-[372px]',
  third: 'w-[501px]',
  half: 'w-[760px]',
  twoThirds: 'w-[1019px]',
  full: 'w-full',
};

interface TileProps {
  id: string;
  component: string;
  subpath: string;
  state: string;
  width?: Width;
  /** Extra body classes, e.g. room above a popover. */
  bodyClassName?: string;
  children: ReactNode;
}

function Tile({ id, component, subpath, state, width = 'quarter', bodyClassName, children }: TileProps) {
  return (
    <Card
      padding="none"
      data-tile={id}
      data-component={component}
      data-subpath={subpath}
      data-state={state}
      className={`${WIDTH[width]} min-w-0 overflow-hidden`}
    >
      <CardHeader inset title={`${id}  ${component}`} subtitle={`${subpath} · ${state}`} />
      <Stack gap="sm" className={`min-w-0 p-4 ${bodyClassName ?? ''}`}>{children}</Stack>
    </Card>
  );
}

function Section({ id, letter, title, description, children }: { id: string; letter: string; title: string; description: string; children: ReactNode }) {
  return (
    <Stack as="section" gap="md" data-section={id} id={`section-${id}`} className="py-6">
      <PageSection title={`${letter}. ${title}`} description={description} size="lg">
        <Inline gap="lg" wrap align="start">{children}</Inline>
      </PageSection>
    </Stack>
  );
}

// ── Shared fixtures as components ─────────────────────────────────────────
const INITIATIVE_COLUMNS: DataTableColumn<Initiative>[] = [
  { key: 'name', header: 'Initiative', sortable: true, render: (row) => <T size="sm" weight="medium">{row.name}</T> },
  { key: 'owner', header: 'Owner', render: (row) => (
    <Inline gap="xs" align="center" wrap={false}><Avatar name={row.owner} size={20} /><T size="sm">{row.owner}</T></Inline>
  ) },
  { key: 'status', header: 'Status', render: (row) => <StatusPill size="sm" tone={STATUS_TONE[row.status]} label={row.status} /> },
  { key: 'contributors', header: 'People', numeric: true, align: 'right', render: (row) => <T size="sm" tabular>{row.contributors}</T> },
  { key: 'updated', header: 'Updated', render: (row) => <T size="sm" tone="secondary">{row.updated}</T> },
];

// The layout frame's content column is narrow; it shows the same table with fewer columns.
const FRAME_COLUMNS = INITIATIVE_COLUMNS.filter((column) => ['name', 'status', 'updated'].includes(column.key));

const STATUS_OPTIONS = [
  { value: 'all', label: 'All statuses' },
  { value: 'active', label: 'Active' },
  { value: 'at-risk', label: 'At risk' },
  { value: 'blocked', label: 'Blocked' },
  { value: 'done', label: 'Done' },
];

function DeviceSettings() {
  return <IconButton variant="ghost" size="sm" aria-label="Device settings" icon={<SettingsGearIcon size={15} />} onClick={noop} />;
}

/** The footer's Social entry, as SocialFooter/EmbeddedSocialEntry compose it. */
function FooterSocialEntry() {
  return (
    <Inline gap="sm" align="center" wrap={false} className="min-w-0">
      <Button variant="ghost" size="sm" onClick={noop}>
        <Inline gap="xs" align="center" wrap={false}><ChatIcon size={16} />Social</Inline>
      </Button>
      <Inline gap="xs" align="center" wrap={false} className="border-l border-border pl-3">
        <PresenceAvatars size={20} maxVisible={4} users={PEOPLE} />
        <PresenceDot state="online" pulse={false} size="sm" />
        <T size="xs" tone="secondary" tabular className="whitespace-nowrap">6 online</T>
      </Inline>
      <Inline gap="none" align="center" className="border-l border-border pl-2">
        <NotificationBell items={NOTIFICATIONS} unreadCount={2} size="sm" label="Social activity" placement="bottom-start" />
      </Inline>
    </Inline>
  );
}

/** The footer row: Social entry on the left, the huddle half filling the rest (SocialFooter.tsx). */
function FooterRow({ voice, huddle }: { voice?: ReactNode; huddle?: ReactNode }) {
  return (
    <Inline as="footer" gap="md" align="center" justify="between" wrap={false}
      className="min-h-11 min-w-0 border-t border-border bg-surface px-4 py-1">
      <FooterSocialEntry />
      {voice}
      {huddle ?? (
        <HuddleBar name="Auth Migration" showContext={false} phase="idle" onStart={noop} startLabel="Huddle"
          onToggleChat={noop} chatLabel="Message" extras={<DeviceSettings />}
          className="min-w-0 flex-1 border-l border-border" />
      )}
    </Inline>
  );
}

/** A caption that starts a new row of tiles inside a section. */
function Subhead({ children }: { children: ReactNode }) {
  return <T as="div" size="sm" weight="semibold" tone="secondary" className="w-full">{children}</T>;
}

function Callout({ n, label }: { n: number; label: string }) {
  return <Chip tone="accent" size="sm" solid>{`${n} ${label}`}</Chip>;
}

// ── A. Layout ─────────────────────────────────────────────────────────────
function LayoutFrame() {
  return (
    <Stack gap="none" data-tenant="orgiq" className="h-[800px] min-w-0 overflow-hidden rounded-md border border-border bg-bg">
      <Inline as="header" justify="between" align="center" wrap={false} className="shell-header shrink-0 border-b border-border bg-surface px-4 py-2">
        <Inline gap="sm" align="center" wrap={false}>
          <T size="sm" weight="semibold">Work</T>
          <Callout n={1} label="Header" />
        </Inline>
        <Inline gap="sm" align="center" wrap={false}>
          <Chip size="sm" outline>⌘K Jump to a page</Chip>
          <NotificationBell items={NOTIFICATIONS} unreadCount={2} size="sm" label="Activity" />
          <Avatar name="Demo User" size={24} />
        </Inline>
      </Inline>
      <Stack gap="none" className="min-h-0 flex-1">
        <SubNavLayout title="Work" items={PRIMARY_NAV} railWidth={200} storageKey="reference-sheet-primary"
          railLabel="Work navigation" railHeader={<Callout n={2} label="Primary rail" />}>
          <Stack gap="none" className="h-full min-h-0 bg-bg">
            <SectionLayout
              title="Initiatives"
              items={SECTION_NAV}
              railWidth={180}
              storageKey="reference-sheet-section"
              railHeader={<Callout n={3} label="Section rail" />}
              fill="parent"
              list={{
                label: 'Initiatives',
                title: 'Initiatives',
                count: INITIATIVES.length,
                header: <Stack gap="xs"><Callout n={4} label="List rail (flush)" /><SearchInput value="" onChange={noop} placeholder="Filter initiatives" aria-label="Filter initiatives" size="sm" /></Stack>,
                body: (
                  <Stack gap="none">
                    {INITIATIVES.map((row, index) => (
                      <Inline key={row.id} gap="sm" align="center" justify="between" wrap={false}
                        className={`px-3 py-2 ${index === 0 ? 'bg-primary-soft' : ''}`}>
                        <T size="sm" weight={index === 0 ? 'semibold' : 'normal'} className="truncate">{row.name}</T>
                        <StatusPill size="sm" variant="text" tone={STATUS_TONE[row.status]} label={row.status} />
                      </Inline>
                    ))}
                  </Stack>
                ),
              }}
              listRailWidth="sm"
              header={{
                breadcrumbs: [{ label: 'Plan' }, { label: 'Initiatives', href: '#' }, { label: 'Auth Migration' }],
                title: 'Auth Migration',
                description: 'Move every service to the new token issuer before the SOC2 audit.',
                badge: <StatusPill size="sm" tone="success" label="active" />,
                actions: <Button variant="primary" size="sm">Start a computer</Button>,
              }}
              aside={(
                <Stack gap="sm" className="h-full w-[340px] min-w-0 shrink-0 border-l border-border bg-surface p-3">
                  <Callout n={7} label="Conversation pane (far right)" />
                  <ChatPanel messages={MESSAGES} onSend={noop} currentUserId="demo-user" showHeader={false} />
                </Stack>
              )}
            >
              <Stack gap="sm" className="p-4">
                <Inline gap="sm" align="center"><Callout n={5} label="Trail and title band (above)" /><Callout n={6} label="Content (table first)" /></Inline>
                <DataTable data={[...INITIATIVES]} columns={FRAME_COLUMNS} keyField={(row) => row.id} size="sm" />
              </Stack>
            </SectionLayout>
          </Stack>
        </SubNavLayout>
      </Stack>
      <FooterRow voice={<Callout n={8} label="Footer: Social entry, then the huddle half" />} />
    </Stack>
  );
}

const LAYOUT_LEGEND: [number, string, string][] = [
  [1, 'Header', 'Tenant switcher, ⌘K hint, fleet, activity bell, persona. One row, never wraps the page.'],
  [2, 'Primary rail', 'SubNavLayout. The tenant’s doors in groups (Plan, Design, Build, Engage, System); folds at three levels deep.'],
  [3, 'Section rail', 'SectionLayout items: the facets of the area you opened.'],
  [4, 'List rail', 'The page’s own list as a flush rail (ListRail), never a floating box. One compact filter row.'],
  [5, 'Trail and title band', 'The full breadcrumb comes first, then the title, badge and the one primary action.'],
  [6, 'Content', 'Table first, above the fold. No stacks of status cards pushing it down.'],
  [7, 'Conversation pane', 'Chat and huddle chat open in the far-right split pane, beside the page.'],
  [8, 'Footer', 'One non-shrinking row: Social entry (reads “Messages” without a Social grant), presence, activity, the today strip, then the huddle half. Voice docks here.'],
];

// ── F. Voice helpers ──────────────────────────────────────────────────────
const LEVELS = [0, 0.3, 0.8] as const;

function RingMatrix({ phase }: { phase: VoicePhase }) {
  return (
    <Stack gap="sm">
      <Inline gap="md" align="center" wrap={false}>
        <T size="xs" tone="tertiary" className="w-8">size</T>
        {LEVELS.map((level) => <T key={level} size="xs" tone="tertiary" tabular className="w-14">{`level ${level}`}</T>)}
      </Inline>
      {(['sm', 'md'] as const).map((size) => (
        <Inline key={size} gap="md" align="center" wrap={false}>
          <T size="xs" tone="secondary" className="w-8">{size}</T>
          {LEVELS.map((level) => (
            <Inline key={level} align="center" justify="start" className="w-14">
              <VoiceActivityRing phase={phase} size={size} level={level} outputLevel={level} label={`${VOICE_PHASE_LABEL[phase]}, level ${level}`} />
            </Inline>
          ))}
        </Inline>
      ))}
    </Stack>
  );
}

const DOCK_PROPS: Record<VoicePhase, { level: number; outputLevel: number; elapsed?: number; line?: { role: 'you' | 'assistant'; text: string } }> = {
  off: { level: 0, outputLevel: 0 },
  connecting: { level: 0, outputLevel: 0, elapsed: 0 },
  listening: { level: 0.6, outputLevel: 0, elapsed: 14, line: { role: 'you', text: 'Find me the latest kubernetes experts' } },
  thinking: { level: 0.05, outputLevel: 0, elapsed: 17, line: { role: 'you', text: 'Find me the latest kubernetes experts' } },
  executing: { level: 0, outputLevel: 0.2, elapsed: 19, line: { role: 'assistant', text: 'Searching people for kubernetes.' } },
  speaking: { level: 0, outputLevel: 0.7, elapsed: 23, line: { role: 'assistant', text: 'Nora DaSilva and Theo Chang worked on the cluster upgrade last month.' } },
  confirming: { level: 0, outputLevel: 0, elapsed: 41, line: { role: 'assistant', text: 'Starting a computer in each needs your OK.' } },
  ended: { level: 0, outputLevel: 0, line: { role: 'assistant', text: 'Session ended after 2:14.' } },
  unavailable: { level: 0, outputLevel: 0 },
};

function Dock({ phase, compact = false, footer = false }: { phase: VoicePhase; compact?: boolean; footer?: boolean }) {
  const p = DOCK_PROPS[phase];
  const live = phase !== 'off' && phase !== 'ended' && phase !== 'unavailable';
  return (
    <VoiceDock
      phase={phase}
      level={p.level}
      outputLevel={p.outputLevel}
      {...(p.elapsed !== undefined ? { elapsedSeconds: p.elapsed } : {})}
      budget={live ? { usedUsd: 0.04 + (p.elapsed ?? 0) * 0.0008, holdUsd: 0.25 } : null}
      lastLine={p.line ?? null}
      // One open confirmation per page: the compact tile shows the phase, F-16 shows the card.
      pending={phase === 'confirming' && !compact && !footer ? PENDING : null}
      onStart={noop}
      onStop={noop}
      onMute={noop}
      {...(phase === 'unavailable' ? { unavailableReason: 'Voice is not configured: no OPENAI_API_KEY on the middleware' } : {})}
      compact={compact}
      size={footer ? 'footer' : 'panel'}
      data-testid={`sheet-voice-dock-${phase}${compact ? '-compact' : ''}${footer ? '-footer' : ''}`}
    />
  );
}

// ── G. Tokens helpers ─────────────────────────────────────────────────────
function useTokenValues(root: React.RefObject<HTMLElement | null>, names: string[]) {
  const [values, setValues] = useState<Record<string, string>>({});
  useLayoutEffect(() => {
    if (!root.current) return;
    const style = getComputedStyle(root.current);
    setValues(Object.fromEntries(names.map((name) => [name, style.getPropertyValue(name).trim()])));
    // names is a module constant
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root]);
  return values;
}

const GAPS: StackGap[] = ['none', 'xs', 'sm', 'md', 'lg', 'xl'];
const GAP_PX: Record<StackGap, string> = { none: '0', xs: '6px', sm: '8px', md: '12px', lg: '16px', xl: '24px' };

// ── The sheet ─────────────────────────────────────────────────────────────
export default function ReferenceSheet() {
  const root = useRef<HTMLElement | null>(null);
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState('work');
  const [segment, setSegment] = useState('table');
  const tokenValues = useTokenValues(root, COLOR_TOKENS.flatMap((group) => group.tokens.map((token) => token.name)));

  useEffect(() => {
    let cancelled = false;
    // Two frames after fonts: the rails measure themselves on mount.
    void document.fonts.ready.then(() => requestAnimationFrame(() => requestAnimationFrame(() => { if (!cancelled) setReady(true); })));
    return () => { cancelled = true; };
  }, []);

  return (
    <ConversationInputProvider>
      <Stack gap="none" data-tenant="orgiq" className="min-h-screen bg-bg">
        <Stack ref={root} gap="none" className="mx-auto w-[1536px] py-8" data-reference-sheet="" {...(ready ? { 'data-ready': '' } : {})}>
          <PageHeader
            title="Voice navigator reference sheet"
            description="Live components from @connorhoehn/ui-components 2.510.1 with product fixture data. Tile ids (A-1, F-7) are stable; docs/design/reference-sheet.json has each tile's box."
            badge={<Chip size="sm" tone="info">dev only</Chip>}
            size="lg"
          />

          {/* ── A ── */}
          <Section id="layout" letter="A" title="Layout" description="The portal shell, scaled into one frame. Numbers name the regions; the legend says what each one is for.">
            <Tile id="A-1" component="SubNavLayout + SectionLayout + footer row" subpath="/shared, /video" state="orgiq initiative page" width="full">
              <LayoutFrame />
            </Tile>
            <Tile id="A-2" component="Layout legend" subpath="n/a" state="regions 1-8" width="full">
              <Inline gap="lg" wrap align="start">
                {LAYOUT_LEGEND.map(([n, name, text]) => (
                  <Stack key={n} gap="xs" className="w-[360px]">
                    <Inline gap="sm" align="center"><Callout n={n} label={name} /></Inline>
                    <T size="sm" tone="secondary" as="p" wrap>{text}</T>
                  </Stack>
                ))}
              </Inline>
            </Tile>
            <Tile id="A-3" component="Footer row" subpath="/shared, /video" state="today: idle, no call" width="full">
              <FooterRow />
            </Tile>
            <Tile id="A-4" component="Footer row + VoiceDock" subpath="/shared, /video, /voice" state="spec §5 placement: listening, beside the huddle half" width="full">
              <FooterRow voice={<VoiceDock size="footer" phase="listening" level={0.6} outputLevel={0} elapsedSeconds={14}
                budget={{ usedUsd: 0.05, holdUsd: 0.25 }} lastLine={{ role: 'you', text: 'Open the computer lab' }}
                onStop={noop} onMute={noop} className="min-w-0 max-w-[640px] flex-1 border-l border-border" />} />
            </Tile>
          </Section>

          {/* ── B ── */}
          <Section id="navigation" letter="B" title="Navigation and shells" description="Headers, trails, tabs and the sectioned-area layout every page sits in.">
            <Tile id="B-1" component="PageHeader" subpath="/shared" state="breadcrumbs, badge, actions" width="half">
              <PageHeader title="Initiatives" description="Epics, decisions and contributors across the org."
                breadcrumbs={[{ label: 'Plan' }, { label: 'Initiatives' }]}
                badge={<Chip size="sm">6</Chip>}
                actions={<Inline gap="sm"><Button variant="secondary" size="sm">Export</Button><Button variant="primary" size="sm">New initiative</Button></Inline>} />
            </Tile>
            <Tile id="B-2" component="PageHeader" subpath="/shared" state="tabs, back link" width="half">
              <PageHeader title="Auth Migration" back={{ label: 'Initiatives', to: '/iq/projects' }}
                tabs={[{ id: 'overview', label: 'Overview' }, { id: 'work', label: 'Work' }, { id: 'decisions', label: 'Decisions' }, { id: 'people', label: 'People' }]}
                activeTab={tab} onTabChange={setTab} size="sm" />
            </Tile>
            <Tile id="B-3" component="Breadcrumbs" subpath="/shared" state="md and sm" width="half">
              <Breadcrumbs items={[{ label: 'Build' }, { label: 'Local compute', href: '#' }, { label: 'Configuration' }]} />
              <Breadcrumbs size="sm" items={[{ label: 'Plan' }, { label: 'Initiatives', href: '#' }, { label: 'RAG Knowledge Search', href: '#' }, { label: 'Decisions' }]} />
            </Tile>
            <Tile id="B-4" component="ChannelHeader" subpath="/shared" state="md, members, actions" width="half">
              <ChannelHeader name="platform-engineering" memberCount={14} description="Releases, incidents and on-call handoffs" online
                actions={<Button variant="secondary" size="sm">Huddle</Button>} />
            </Tile>
            <Tile id="B-5" component="ChannelHeader" subpath="/shared" state="sm, tabs" width="half">
              <ChannelHeader size="sm" name="Auth Migration" memberCount={7}
                tabs={<Tabs size="sm" items={[{ id: 'chat', label: 'Chat' }, { id: 'pins', label: 'Pins' }]} value="chat" onValueChange={noop} />} />
            </Tile>
            <Tile id="B-6" component="Tabs" subpath="/shared" state="underline, pill, segmented" width="half">
              <Tabs items={[{ id: 'work', label: 'Work', badge: 12 }, { id: 'decisions', label: 'Decisions', badge: 4 }, { id: 'people', label: 'People' }]} value={tab} onValueChange={setTab} />
              <Tabs variant="pill" size="sm" items={[{ id: 'work', label: 'Work' }, { id: 'decisions', label: 'Decisions' }, { id: 'people', label: 'People' }]} value={tab} onValueChange={setTab} />
              <Tabs variant="segmented" size="sm" items={[{ id: 'work', label: 'Work' }, { id: 'decisions', label: 'Decisions' }, { id: 'people', label: 'People' }]} value={tab} onValueChange={setTab} />
            </Tile>
            <Tile id="B-7" component="PaneHeader" subpath="/shared" state="tabs, trailing" width="half">
              <PaneHeader tabs={[{ id: 'chat', label: 'Chat' }, { id: 'people', label: 'People' }, { id: 'files', label: 'Files' }]} value="chat" onValueChange={noop}
                trailing={<IconButton variant="ghost" size="sm" aria-label="Search the conversation" icon={<SearchIcon size={14} />} />} label="Conversation" />
            </Tile>
            <Tile id="B-8" component="SectionLayout" subpath="/shared" state="section rail + header, no list" width="full">
              <Stack gap="none" className="h-[260px] min-w-0 overflow-hidden rounded-md border border-border">
                <SectionLayout title="Automate" items={[{ path: '#inbox', label: 'Inbox', count: 3 }, { path: '#runs', label: 'Runs' }, { path: '#findings', label: 'Findings', count: 2, accent: 'warning' }, { path: '#changes', label: 'Graph updates' }]}
                  storageKey="reference-sheet-b8" railWidth={180} fill="parent"
                  header={{ breadcrumbs: [{ label: 'Build' }, { label: 'Automate', href: '#' }, { label: 'Findings' }], title: 'Findings', description: 'What the sweeps flagged and what failed.' }}>
                  <Stack gap="sm" className="p-4">
                    <EmptyState layout="line" title="No open findings since yesterday" />
                  </Stack>
                </SectionLayout>
              </Stack>
            </Tile>
          </Section>

          {/* ── C ── */}
          <Section id="inputs" letter="C" title="Inputs" description="Buttons, form controls and the command composer. One primary action per region.">
            {(['sm', 'md', 'lg'] as const).map((size, index) => (
              <Tile key={size} id={`C-${index + 1}`} component="Button" subpath="/shared" state={`all variants, size ${size}`} width="full">
                <Inline gap="sm" wrap align="center">
                  {(['primary', 'secondary', 'ghost', 'danger', 'danger-solid', 'success', 'info', 'link'] as const).map((variant) => (
                    <Button key={variant} variant={variant} size={size} onClick={noop}>{variant}</Button>
                  ))}
                  <Button variant="primary" size={size} disabled>disabled</Button>
                </Inline>
              </Tile>
            ))}
            <Tile id="C-4" component="IconButton" subpath="/shared" state="ghost, primary, danger, outline" width="quarter">
              <Inline gap="sm" align="center">
                {(['ghost', 'primary', 'danger', 'outline'] as const).map((variant) => (
                  <IconButton key={variant} variant={variant} size="md" aria-label={variant} icon={<SearchIcon size={16} />} />
                ))}
              </Inline>
            </Tile>
            <Tile id="C-5" component="Input + FormField" subpath="/shared" state="default, prefix, invalid, disabled" width="quarter">
              <FormField label="Computer label">{(w) => <Input {...w} value="auth-loadtest" onChange={noop} size="sm" />}</FormField>
              <Input value="" onChange={noop} placeholder="Search people" prefix={<SearchIcon size={14} />} size="sm" aria-label="Search people" />
              <FormField label="Budget (USD)" error="Must be under the initiative’s remaining 12.40">{(w) => <Input {...w} value="40" onChange={noop} invalid size="sm" />}</FormField>
              <Input value="read only" onChange={noop} disabled size="sm" aria-label="Disabled" />
            </Tile>
            <Tile id="C-6" component="Select + SearchInput + Textarea" subpath="/shared" state="default" width="quarter">
              <Select options={STATUS_OPTIONS} value="active" onChange={noop} size="sm" aria-label="Status" />
              <SearchInput value="kubernetes" onChange={noop} placeholder="Search" aria-label="Search" size="sm" />
              <Textarea value="Out this afternoon, back tomorrow 9:00." onChange={noop} rows={2} aria-label="Status message" />
            </Tile>
            <Tile id="C-7" component="SegmentedControl + Switch + Checkbox" subpath="/shared" state="neutral, accent; on, off" width="quarter">
              <SegmentedControl size="sm" options={[{ label: 'Table', value: 'table' }, { label: 'Cards', value: 'cards' }, { label: 'Graph', value: 'graph' }]} value={segment} onChange={setSegment} aria-label="View" />
              <SegmentedControl size="md" tone="accent" options={[{ label: 'Agent', value: 'agent' }, { label: 'Chat', value: 'chat' }]} value="agent" onChange={noop} aria-label="Mode" />
              <Inline gap="md" align="center">
                <Switch checked onChange={noop} aria-label="On" /><Switch checked={false} onChange={noop} aria-label="Off" />
                <Checkbox checked onChange={noop} aria-label="Checked" /><Checkbox checked={false} onChange={noop} aria-label="Unchecked" /><Checkbox checked={false} indeterminate onChange={noop} aria-label="Mixed" />
              </Inline>
            </Tile>
            <Tile id="C-8" component="ContextComposer" subpath="/social/rich-composer" state="empty" width="third">
              <ContextComposer context={{ kind: 'conversation', id: 'sheet-empty', title: 'Search' }} presentation="document"
                placeholder="Ask about people, initiatives or decisions" onSend={noop} draftKey="sheet-empty" />
            </Tile>
            <Tile id="C-9" component="ContextComposer" subpath="/social/rich-composer" state="typing" width="third">
              <ContextComposer context={{ kind: 'conversation', id: 'sheet-typing', title: 'Search' }} presentation="document"
                defaultDraft="Find me the latest kubernetes experts" onSend={noop} draftKey="sheet-typing" />
            </Tile>
            <Tile id="C-10" component="ContextComposer" subpath="/social/rich-composer" state="sending (working)" width="third">
              <ContextComposer context={{ kind: 'conversation', id: 'sheet-working', title: 'Search' }} presentation="document"
                working task={{ label: 'Searching people for kubernetes', status: 'running', phase: 'Search agent' }} onSend={noop} draftKey="sheet-working" />
            </Tile>
          </Section>

          {/* ── D ── */}
          <Section id="data" letter="D" title="Data" description="Table-first list pages with one compact filter row, then cards, pills and the whole-region states.">
            <Tile id="D-1" component="CollectionPage + DataTable" subpath="/shared" state="filter row, 6 rows" width="full">
              <CollectionPage<Initiative>
                title="Initiatives"
                description="Every initiative you own or contribute to."
                titleAs="h3"
                toolbar={{
                  label: 'Initiatives',
                  search: { value: '', onChange: noop, placeholder: 'Filter initiatives', 'aria-label': 'Filter initiatives' },
                  filters: [{ id: 'status', label: 'Status', value: 'all', options: STATUS_OPTIONS, onChange: noop }],
                  resultCount: INITIATIVES.length,
                  onRefresh: noop,
                }}
                table={{ data: [...INITIATIVES], columns: INITIATIVE_COLUMNS, keyField: (row) => row.id, size: 'sm' }}
              />
            </Tile>
            <Tile id="D-2" component="StatusPill" subpath="/shared" state="every tone, pill and text" width="half">
              <Inline gap="sm" wrap align="center">
                {(['success', 'info', 'warning', 'error', 'danger', 'pending', 'neutral'] as const).map((tone) => <StatusPill key={tone} tone={tone} label={tone} size="sm" />)}
              </Inline>
              <Inline gap="sm" wrap align="center">
                {(['success', 'info', 'warning', 'error', 'pending', 'neutral'] as const).map((tone) => <StatusPill key={tone} tone={tone} label={tone} variant="text" size="sm" />)}
              </Inline>
              <Inline gap="sm" wrap align="center">
                {(['success', 'info', 'warning', 'error'] as const).map((tone) => <StatusPill key={tone} tone={tone} label={tone} variant="tag" size="md" />)}
              </Inline>
            </Tile>
            <Tile id="D-3" component="Chip + Badge" subpath="/shared" state="tones, solid, outline, dot" width="half">
              <Inline gap="sm" wrap align="center">
                {(['neutral', 'success', 'warning', 'danger', 'info', 'caution', 'accent'] as const).map((tone) => <Chip key={tone} tone={tone} size="sm">{tone}</Chip>)}
              </Inline>
              <Inline gap="sm" wrap align="center">
                <Chip tone="accent" solid size="sm">solid</Chip>
                <Chip outline size="sm">outline</Chip>
                <Chip tone="success" dot="pulse" size="sm">live</Chip>
                <Chip tone="info" mono size="sm">p-051</Chip>
                <Badge variant="count" value={12} aria-label="12 unread" />
                <Badge variant="dot" aria-label="Unread" />
              </Inline>
            </Tile>
            <Tile id="D-4" component="StatCard in KPIGrid" subpath="/shared" state="4 columns, delta, sparkline" width="full">
              <KPIGrid columns={4} dense>
                <StatCard label="Active initiatives" value="3" hint="of 6 you contribute to" size="sm" />
                <StatCard label="Computers running" value="2" delta={{ value: 1, direction: 'up', tone: 'neutral', suffix: ' since 9:00' }} size="sm" />
                <StatCard label="Open findings" value="2" danger hint="stale_docs" size="sm" />
                <StatCard label="Voice spend today" value="$0.31" sparklineData={[0.02, 0.05, 0.05, 0.11, 0.18, 0.24, 0.31]} mono size="sm" />
              </KPIGrid>
            </Tile>
            <Tile id="D-5" component="Card + CardHeader" subpath="/shared" state="title, subtitle, action" width="third">
              <Card padding="none">
                <CardHeader title="Cutover checklist" subtitle="Auth Migration · due Thursday" action={<Button variant="ghost" size="sm">Open</Button>} />
                <Stack gap="xs" className="p-3">
                  <T size="sm">Token exchange in staging</T>
                  <T size="sm" tone="secondary">Network policy merged</T>
                  <ProgressBar value={2} max={3} size="sm" showRatio label="Done" />
                </Stack>
              </Card>
            </Tile>
            <Tile id="D-6" component="ExpertCard" subpath="/shared" state="matched skills, evidence" width="third">
              <ExpertCard name="Nora DaSilva" title="Staff engineer, Platform Engineering"
                matchedSkills={[{ name: 'Kubernetes', strength: 0.9 }, { name: 'Helm', strength: 0.6 }]}
                otherSkills={['Terraform', 'Go']}
                evidence={[{ id: 'e1', title: 'Cluster upgrade runbook', source: 'Runbooks' }]}
                onAsk={noop} askLabel="Message" />
            </Tile>
            <Tile id="D-7" component="DotMeter + AudioLevelMeter" subpath="/shared, /video" state="budget 20%, 80% (warn); mic 0, 0.3, 0.8" width="third">
              <DotMeter value={0.2} segments={5} note="$0.05 of $0.25" />
              <DotMeter value={0.8} segments={5} warnAbove={0.75} note="$0.20 of $0.25" />
              {LEVELS.map((level) => (
                <Inline key={level} gap="sm" align="center" wrap={false}>
                  <T size="xs" tone="tertiary" tabular className="w-16">{`mic ${level}`}</T>
                  <AudioLevelMeter level={level} label={`Microphone ${level}`} />
                </Inline>
              ))}
            </Tile>
            <Tile id="D-8" component="EmptyState" subpath="/shared" state="block, with action" width="quarter">
              <EmptyState title="No computers yet" description="Start one from an initiative you own or contribute to." actionLabel="Open the Computer Lab" onAction={noop} size="sm" />
            </Tile>
            <Tile id="D-9" component="EmptyState" subpath="/shared" state="line" width="quarter">
              <EmptyState layout="line" title="Nothing matches “kubernetes” in decisions" />
            </Tile>
            <Tile id="D-10" component="LoadingState" subpath="/shared" state="loading" width="quarter">
              <LoadingState label="Loading initiatives…" />
            </Tile>
            <Tile id="D-11" component="ErrorState" subpath="/shared" state="error with retry" width="quarter">
              <ErrorState title="Could not load findings" body="The middleware answered 503." actionLabel="Retry" onAction={noop} />
            </Tile>
          </Section>

          {/* ── E ── */}
          <Section id="social" letter="E" title="Social" description="Presence, activity, the huddle bar in every phase and the call tiles. All of it lives in the bottom bar or the right pane.">
            <Tile id="E-1" component="PresenceAvatars + PresenceDot + Avatar" subpath="/shared" state="sizes 20, 28; online, away, busy, offline" width="third">
              <PresenceAvatars size={20} maxVisible={4} users={PEOPLE} />
              <PresenceAvatars size={28} maxVisible={6} users={PEOPLE} />
              <Inline gap="md" align="center">
                {(['online', 'away', 'busy', 'offline'] as const).map((state) => <PresenceDot key={state} state={state} label={state} size="sm" />)}
              </Inline>
              <Inline gap="sm" align="center"><Avatar name="Vera Green" size={32} /><Avatar name="Theo Chang" size={24} /><Avatar name="Omar Haddad" size={20} /></Inline>
            </Tile>
            <Tile id="E-2" component="NotificationCenter" subpath="/shared" state="2 unread, 1 read" width="third">
              <NotificationCenter items={NOTIFICATIONS} onItemClick={noop} onMarkAllRead={noop} />
            </Tile>
            <Tile id="E-3" component="ChatPanel" subpath="/social" state="3 messages, composer" width="third" bodyClassName="h-[360px]">
              <ChatPanel messages={MESSAGES} onSend={noop} currentUserId="demo-user" showHeader={false} fill />
            </Tile>
            {([
              ['E-4', 'idle', { phase: 'idle', onStart: noop, startLabel: 'Huddle', onToggleChat: noop, chatLabel: 'Message' }],
              ['E-5', 'joinable', { phase: 'joinable', liveParticipants: PEOPLE.slice(0, 3).map((p) => ({ id: p.id, displayName: p.name })), participantCount: 3, onJoin: noop, onToggleChat: noop, chatLabel: 'Message' }],
              ['E-6', 'ringing', { phase: 'ringing', statusLabel: 'Calling Auth Migration…', ringingCount: 2, onLeave: noop, leaveLabel: 'Cancel' }],
              ['E-7', 'connecting', { phase: 'connecting', onLeave: noop }],
              ['E-8', 'live', { phase: 'live', startedAt: Date.now() - 754_000, participantCount: 3, mic: { on: true, onToggle: noop, level: 0.5 }, camera: { on: false, onToggle: noop }, onToggleChat: noop, chatLabel: 'Message', chatUnread: 2, onLeave: noop }],
              ['E-9', 'reconnecting', { phase: 'reconnecting', startedAt: Date.now() - 900_000, participantCount: 3, onLeave: noop }],
              ['E-10', 'ended', { phase: 'ended', onLeave: noop, leaveLabel: 'Dismiss' }],
            ] as const).map(([id, state, props]) => (
              <Tile key={id} id={id} component="HuddleBar" subpath="/video" state={state} width="half">
                <HuddleBar name="Auth Migration huddle" showContext={state !== 'idle' && state !== 'joinable'} {...props}
                  extras={<DeviceSettings />} className="min-w-0 border border-border bg-surface" />
              </Tile>
            ))}
            <Tile id="E-11" component="FooterRow (Social entry + HuddleBar)" subpath="/shared, /video" state="in a call: live" width="half">
              <FooterRow huddle={<HuddleBar name="Auth Migration huddle" phase="live" startedAt={Date.now() - 754_000} participantCount={3}
                mic={{ on: true, onToggle: noop, level: 0.5 }} camera={{ on: false, onToggle: noop }} onToggleChat={noop} chatLabel="Message" onLeave={noop}
                className="min-w-0 flex-1 border-l border-border" />} />
            </Tile>
            <Tile id="E-12" component="ParticipantTile" subpath="/video" state="speaking, muted, hand raised, local" width="full">
              <Inline gap="md" wrap={false}>
                <ParticipantTile id="p-vera" displayName="Vera Green" isSpeaking className="h-[150px] w-[220px]" />
                <ParticipantTile id="p-omar" displayName="Omar Haddad" isMuted className="h-[150px] w-[220px]" />
                <ParticipantTile id="p-theo" displayName="Theo Chang" handRaised className="h-[150px] w-[220px]" />
                <ParticipantTile id="demo-user" displayName="Demo User" isLocal isMuted className="h-[150px] w-[220px]" />
              </Inline>
            </Tile>
            <Tile id="E-13" component="CallTileRow" subpath="/video" state="dock variant, active speaker" width="full">
              <CallTileRow variant="dock" activeSpeakerId="p-vera" tileWidth={160} tileHeight={100}
                participants={[{ id: 'p-vera', displayName: 'Vera Green' }, { id: 'p-omar', displayName: 'Omar Haddad', isMuted: true }, { id: 'p-theo', displayName: 'Theo Chang', ringing: true }]}
                localParticipant={{ id: 'demo-user', displayName: 'Demo User', isLocal: true, cameraOff: true }} />
            </Tile>
          </Section>

          {/* ── F ── */}
          <Section id="voice" letter="F" title="Voice" description="The three voice primitives (/voice, 2.510.1). The ring follows the microphone while listening, pulses on the assistant's audio while speaking, rotates while connecting, thinking or working, and sits dim when off. Rendered with reduced motion, so rotation and pulse show as their static frame.">
            <Subhead>VoiceActivityRing, every phase (F-1 to F-9)</Subhead>
            {VOICE_PHASES.map((phase, index) => (
              <Tile key={phase} id={`F-${index + 1}`} component="VoiceActivityRing" subpath="/voice" state={`${phase}: sm and md at levels 0, 0.3, 0.8`} width="third">
                <RingMatrix phase={phase} />
              </Tile>
            ))}
            <Subhead>VoiceDock, full: transcript line, budget meter, elapsed, mute, hang-up (F-10 to F-18)</Subhead>
            {VOICE_PHASES.map((phase, index) => (
              <Tile key={phase} id={`F-${10 + index}`} component="VoiceDock" subpath="/voice" state={`${phase}, full`} width="half"
                bodyClassName={phase === 'confirming' ? 'pb-48' : undefined}>
                <Dock phase={phase} />
              </Tile>
            ))}
            <Subhead>VoiceDock, compact: no transcript line or budget meter (F-19 to F-27)</Subhead>
            {VOICE_PHASES.map((phase, index) => (
              <Tile key={phase} id={`F-${19 + index}`} component="VoiceDock" subpath="/voice" state={phase === 'confirming' ? 'confirming, compact (its card is F-16)' : `${phase}, compact`} width="third">
                <Dock phase={phase} compact />
              </Tile>
            ))}
            <Subhead>VoiceDock, footer size: the footer’s metrics, an 18px ring, xs labels, a quiet Voice / End control (F-31 to F-39)</Subhead>
            {VOICE_PHASES.map((phase, index) => (
              <Tile key={phase} id={`F-${31 + index}`} component="VoiceDock" subpath="/voice" state={phase === 'confirming' ? 'confirming, footer (its card is F-16)' : `${phase}, footer`} width="half">
                <Dock phase={phase} footer />
              </Tile>
            ))}
            <Subhead>Confirmation card and transcript strip (F-28 to F-30)</Subhead>
            <Tile id="F-28" component="VoiceConfirmCard" subpath="/voice" state="Start a computer in 3 projects" width="third">
              <VoiceConfirmCard pending={PENDING} autoFocus={false} />
            </Tile>
            <Tile id="F-29" component="VoiceTurnStrip" subpath="/voice" state="4 turns: done, running, refused" width="third">
              <VoiceTurnStrip turns={TURNS} onClear={noop} />
            </Tile>
            <Tile id="F-30" component="VoiceTurnStrip" subpath="/voice" state="failed tool call; empty" width="third">
              <VoiceTurnStrip turns={TURNS_FAILED} />
              <VoiceTurnStrip turns={[]} />
            </Tile>
          </Section>

          {/* ── G ── */}
          <Section id="tokens" letter="G" title="Tokens" description="The colour tokens, type scale and spacing the sheet uses, read live from the CSS variables (orgiq tenant).">
            {COLOR_TOKENS.map((group, index) => (
              <Tile key={group.group} id={`G-${index + 1}`} component="Colour tokens" subpath="portal/src/app.css" state={group.group} width="quarter">
                {group.tokens.map((token) => (
                  <Inline key={token.name} gap="sm" align="center" wrap={false}>
                    <Stack aria-hidden className={`h-7 w-12 shrink-0 rounded border border-border ${token.swatch}`} />
                    <Stack gap="none" className="min-w-0">
                      <T size="xs" weight="medium" className="truncate">{token.name}</T>
                      <T size="xs" tone="tertiary" tabular>{tokenValues[token.name] || '…'}</T>
                    </Stack>
                  </Inline>
                ))}
              </Tile>
            ))}
            <Tile id="G-5" component="T (type scale)" subpath="/shared" state="sizes xs, sm, base, lg × weights" width="half">
              {(['lg', 'base', 'sm', 'xs'] as const).map((size) => (
                <Inline key={size} gap="lg" align="center" wrap={false}>
                  <T size="xs" tone="tertiary" className="w-10">{size}</T>
                  {(['normal', 'medium', 'semibold', 'bold'] as const).map((weight) => <T key={weight} size={size} weight={weight}>{weight}</T>)}
                </Inline>
              ))}
              <Inline gap="lg" align="center" wrap={false}>
                <T size="xs" tone="tertiary" className="w-10">tone</T>
                {(['primary', 'secondary', 'tertiary'] as const).map((tone) => <T key={tone} size="sm" tone={tone}>{tone}</T>)}
              </Inline>
            </Tile>
            <Tile id="G-6" component="Stack / Inline gap" subpath="/shared" state="none, xs, sm, md, lg, xl" width="half">
              {GAPS.map((gap) => (
                <Inline key={gap} gap="lg" align="center" wrap={false}>
                  <T size="xs" tone="tertiary" className="w-24">{`${gap} (${GAP_PX[gap]})`}</T>
                  <Inline gap={gap} align="center" wrap={false}>
                    <Chip size="xs" tone="accent">a</Chip><Chip size="xs" tone="accent">b</Chip><Chip size="xs" tone="accent">c</Chip>
                  </Inline>
                </Inline>
              ))}
            </Tile>
          </Section>
        </Stack>
      </Stack>
    </ConversationInputProvider>
  );
}
