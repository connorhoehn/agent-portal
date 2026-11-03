import '@connorhoehnslalom/ui-components/styles.css';
import '../../src/app.css';
import { createContext, StrictMode, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, useLocation } from 'react-router';
import { PaneHeader, SidePaneProvider, SidePaneSplit } from '@connorhoehnslalom/ui-components';
import { Button, IconButton, Inline, Stack, T } from '@connorhoehnslalom/ui-components/shared';
import { InitiativeSidePane, useInitiativePane } from '../../src/pages/projects/InitiativeSidePane';
import { InitiativeDetailsTrigger, type InitiativeFactsInput } from '../../src/pages/projects/InitiativeDetailsCard';
import { buildOverview } from '../../src/pages/project-detail/overviewModel';
import { node, OBS_PROJECT, OBS_TREE } from '../../src/pages/project-detail/__tests__/obsFixture';

// Explicitly inert conversation adapters; no gateway, call, session or message actions.
export const ConversationViewsSlot = createContext<HTMLElement | null>(null);
export function useConversationPane() { return { huddle: null, inHuddle: false }; }
export function ConversationPaneBody({ children }: { children: ReactNode }) { return <>{children}</>; }
const facts: InitiativeFactsInput = { project: { ...OBS_PROJECT, summary: 'Centralize telemetry, reduce alert noise, and control retention costs. Focus: actionable alerts, team error budgets, and OpenTelemetry. This additional sentence is hidden by the two-line summary but remains available in the project Overview.' }, statusLabel: 'In progress', owner: { name: 'Nora DaSilva', avatarUrl: '/__pane-avatar-owner.svg' }, smes: [{ name: 'Layla Hassan', avatarUrl: '/__pane-avatar-sme.svg' }, { name: 'Eli Garcia' }] };
function Surface() {
  const control = useInitiativePane(facts.project.id), location = useLocation();
  const [opened, setOpened] = useState(''), [state, setState] = useState('attention'), [smallTab, setSmallTab] = useState('discussion');
  const overview = state === 'loading' ? { state: 'loading' as const, stats: [] } : state === 'error' ? { state: 'error' as const, stats: [], error: 'Fixture denies work read' }
    : buildOverview(facts.project, { tree: state === 'empty' ? [] : state === 'next' ? [node({ id: 'inert-epic', type: 'epic', children: [node({ id: 'inert-next-work', title: 'Verify collector coverage', assigneeName: 'Eli Garcia' })] })] : OBS_TREE, error: null, loading: false });
  return <Stack gap="none" className="h-dvh bg-surface text-text-primary">
    <SidePaneSplit>
      <Stack gap="md" className="min-w-0 flex-1 p-4">
        <Inline gap="sm"><T size="lg" weight="semibold">Initiative details fixture</T><InitiativeDetailsTrigger onOpenDetails={() => control.open('details')} /></Inline>
        <textarea aria-label="Main draft" className="border border-border p-2" />
        <div contentEditable role="textbox" aria-label="Rich draft" className="border border-border p-2" />
        <Inline gap="sm"><Button size="sm" variant="secondary" onClick={() => control.open('discussion')}>Discussion tab</Button><Button size="sm" variant="ghost" onClick={() => setState('next')}>Show next work</Button><Button size="sm" variant="ghost" onClick={() => setState('empty')}>Show empty work</Button><Button size="sm" variant="ghost" onClick={() => setState('error')}>Show failed read</Button><Button size="sm" variant="ghost" onClick={() => setState('loading')}>Show loading read</Button></Inline>
        <output data-testid="fixture-opened">{opened}</output><output data-testid="fixture-search">{location.search}</output>
        <div className="w-75 border border-border" data-testid="small-pane-header"><PaneHeader tabs={[{ id: 'discussion', label: 'Discussion' }, { id: 'agent', label: 'Agent' }, { id: 'details', label: 'Details' }]} value={smallTab} onValueChange={setSmallTab} trailing={<IconButton aria-label="Small pane files" variant="outline" icon="d" size="sm" />} /></div>
        <Inline gap="sm" data-testid="native-theme-actions"><Button size="sm">Primary</Button><Button size="sm" variant="secondary">Secondary</Button><Button size="sm" variant="ghost">Ghost</Button><Button size="sm" variant="danger-solid">Destructive</Button><Button size="sm" variant="secondary" disabled>Disabled</Button><IconButton aria-label="Primary icon" size="sm" variant="primary" icon="i" /><IconButton aria-label="Pressed icon" size="sm" variant="outline" aria-pressed icon="i" /></Inline>
      </Stack>
      <InitiativeSidePane control={control} subtitle={facts.project.name} facts={facts} overview={overview} discussion={<p className="px-4 py-3">Inert initiative discussion</p>} agent={<p>Inert agent</p>} decisions={[]} workItemIds={[]} workspaceHref="/iq/search?scope=p-observability" onOpenWorkItem={setOpened} onOpenDecisions={() => setOpened('decisions')} />
    </SidePaneSplit>
  </Stack>;
}
const params = new URLSearchParams(location.search);
document.documentElement.dataset.tenant = params.get('tenant') ?? 'orgiq';
document.documentElement.dataset.theme = params.get('theme') ?? 'light';
createRoot(document.getElementById('root')!).render(<StrictMode><BrowserRouter><SidePaneProvider storageKey="inert-details-pane"><Surface /></SidePaneProvider></BrowserRouter></StrictMode>);
