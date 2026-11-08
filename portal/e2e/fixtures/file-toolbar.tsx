import '../../src/app.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, useLocation } from 'react-router';
import { Stack, T } from '@connorhoehn/ui-components/shared';
import { SessionProvider } from '../../src/lib/auth';
import { InitiativeFiles } from '../../src/pages/projects/InitiativeFiles';
import { TeamFiles } from '../../src/pages/assessment/dashboard/TeamFiles';

const query = new URLSearchParams(location.search);
const tenant = query.get('tenant') === 'assessment' ? 'assessment' : 'orgiq';
document.documentElement.dataset.tenant = tenant;
if (query.get('theme') === 'dark') document.documentElement.dataset.theme = 'dark';
function Fixture() {
  const here = useLocation();
  return <Stack gap="md" className="mx-auto max-w-[980px] p-4" data-testid="file-toolbar-fixture">
    <T size="lg" weight="semibold">{tenant === 'assessment' ? 'Notifications Service' : 'Observability Platform'}</T>
    <output data-testid="fixture-route">{here.pathname + here.search}</output>
    {tenant === 'assessment' ? <TeamFiles teamId="TEAM-005" teamName="Notifications Service" />
      : <InitiativeFiles projectId="p-observability" projectName="Observability Platform" itemIds={[]}
        workspaceHref="/iq/workspace" onOpenRecording={() => { throw new Error('This fixture does not open recording content.'); }} />}
  </Stack>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><BrowserRouter><SessionProvider><Fixture /></SessionProvider></BrowserRouter></StrictMode>);
