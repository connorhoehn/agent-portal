import { ActivityIcon } from '@connorhoehnslalom/ui-components/shared';
import { useNavigate } from 'react-router';
import { RunsLedger } from '../../components/runs/RunsLedger';
import { RunCollectionPage } from '../../components/runs/RunCollectionPage';

export default function RunsPage() {
  const navigate = useNavigate();
  return <RunCollectionPage title="Runs" description="Every run, what it acted for, and where it stands." data-testid="pipelines-runs">
    <RunsLedger endpoint="/api/pipelines/runs" detailBase="/pipelines/runs" showWorkspace fill data-testid="pipelines-runs-table"
      actions={[{ id: 'activity', label: 'Work graph', icon: <ActivityIcon />, onClick: () => navigate('/pipelines/activity'), 'data-testid': 'pipelines-runs-activity' }]} />
  </RunCollectionPage>;
}
