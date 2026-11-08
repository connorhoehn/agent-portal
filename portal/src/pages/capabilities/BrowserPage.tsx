import { useState } from 'react';
import { Link } from 'react-router';
import { InlineAlert, PageSection, Tabs } from '@connorhoehn/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { WebQATab } from './browser/WebQATab';
import { JourneyTab } from './browser/JourneyTab';
import { SessionsTab } from './browser/SessionsTab';

// The shell: which of the three diagnostics is on screen. Everything else lives
// in ./browser/.
//
// Removed with the decomposition: a SiteMap ReactFlow graph, its layout
// function, the CrawlPage/CrawlSession/CrawlView types and a Toggle switch —
// ~120 lines and the whole @xyflow/react import, none of it reachable. Crawling
// moved to Knowledge → Sources and the UI came with it; only the dead code
// stayed behind.

const TABS = [
  { id: 'qa', label: 'Web Q&A' },
  { id: 'journey', label: 'Journey Recorder' },
  { id: 'sessions', label: 'Sessions' },
];

/** The two capability ids every control on this page depends on. */
type CapKey = 'browser' | 'browserProfile';
interface CapabilityStatus {
  key: string;
  label: string;
  state: 'ok' | 'missing' | 'unconfigured' | 'unknown';
  detail: string;
  envVar: string;
}

function BrowserPage() {
  const [mode, setMode] = useState('qa');

  // The precondition, said before the button rather than after it.
  //
  // `createBrowserSession` passes `profileIdentifier` straight through when
  // BROWSER_PROFILE_ID is set, so a stale id — the ordinary state of this
  // account, since capability ids are reminted on every stack rebuild and
  // .env.aws is not regenerated — makes StartBrowserSession reject and the
  // page answer with a bare failure. Capabilities already KNOWS this: its
  // reconcile marks the profile "points at nothing". This page drives the
  // capability and said nothing, so the same fact was one click away from
  // the person hitting the error and nowhere near them.
  const { data } = useFetch<{ capabilities: CapabilityStatus[] }>(
    '/api/capabilities/reconcile', 60_000,
  );
  const blocking = (data?.capabilities ?? []).filter(
    (c) => (c.key as CapKey) === 'browser' || (c.key as CapKey) === 'browserProfile',
  ).filter((c) => c.state === 'missing');

  return (
    <PageSection
      title="Browser"
      description="Diagnostics for the AgentCore Browser capability. Crawling lives in Knowledge → Sources, where a survey scopes it first."
      actions={<Tabs items={TABS} value={mode} onValueChange={setMode} aria-label="Browser diagnostics" />}
    >
      {blocking.map((c) => (
        <InlineAlert key={c.key} tone="error" className="mb-3">
          {`${c.label}: ${c.detail} Everything on this page launches a real browser session with that id, so it will fail until ${c.envVar} is corrected — see `}
          <Link to="/admin/capabilities" className="text-primary no-underline hover:underline">Capabilities</Link>
          {'.'}
        </InlineAlert>
      ))}
      {mode === 'qa' && <WebQATab />}
      {mode === 'journey' && <JourneyTab />}
      {mode === 'sessions' && <SessionsTab />}
    </PageSection>
  );
}

export default BrowserPage;
