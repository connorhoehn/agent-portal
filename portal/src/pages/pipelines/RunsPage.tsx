import { ActivityIcon, CollectionPage } from '@connorhoehnslalom/ui-components/shared';
import { useNavigate } from 'react-router';
import { RunsLedger } from '../../components/runs/RunsLedger';

export default function RunsPage() {
  const navigate = useNavigate();
  return <CollectionPage title="Runs" description="Every run, what it acted for, and where it stands." data-testid="pipelines-runs">
    <RunsLedger endpoint="/api/pipelines/runs" detailBase="/pipelines/runs" showWorkspace data-testid="pipelines-runs-table"
      actions={[{ id: 'activity', label: 'Work graph', icon: <ActivityIcon />, onClick: () => navigate('/pipelines/activity'), 'data-testid': 'pipelines-runs-activity' }]} />
  </CollectionPage>;
}
