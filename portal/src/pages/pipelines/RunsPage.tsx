import { ActivityIcon } from '@connorhoehn/ui-components/shared';
import { useNavigate } from 'react-router';
import { RunsLedger } from '../../components/runs/RunsLedger';
import { CollectionCommandPage } from '../../components/collections/CollectionCommandPage';

export default function RunsPage() {
  const navigate = useNavigate();
  return <CollectionCommandPage title="Runs" description="Every run, what it acted for, and where it stands." data-testid="pipelines-runs">
    <RunsLedger endpoint="/api/pipelines/runs" detailBase="/pipelines/runs" showWorkspace fill data-testid="pipelines-runs-table"
      actions={[{ id: 'activity', label: 'Work graph', icon: <ActivityIcon />, onClick: () => navigate('/pipelines/activity'), 'data-testid': 'pipelines-runs-activity' }]} />
  </CollectionCommandPage>;
}
