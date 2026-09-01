import { useState } from 'react';
import { PageSection, Tabs } from '@connorhoehnslalom/ui-components/shared';
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

function BrowserPage() {
  const [mode, setMode] = useState('qa');

  return (
    <PageSection
      title="Browser"
      description="Diagnostics for the AgentCore Browser capability. Crawling lives in Knowledge → Sources, where a survey scopes it first."
      actions={<Tabs items={TABS} value={mode} onValueChange={setMode} aria-label="Browser diagnostics" />}
    >
      {mode === 'qa' && <WebQATab />}
      {mode === 'journey' && <JourneyTab />}
      {mode === 'sessions' && <SessionsTab />}
    </PageSection>
  );
}

export default BrowserPage;
