import { PageRecordings } from '../../components/recordings/PageRecordings';

/** Work uses the shared participant-authorized recording workspace. */
export function InitiativeRecordings({ projectId, projectName, ...props }: {
  projectId: string; projectName: string; preview?: boolean; onOpen(id: string | null): void;
}) {
  return <PageRecordings lobby={`orgiq:initiative:${projectId}`} subjectName={projectName} {...props} />;
}
