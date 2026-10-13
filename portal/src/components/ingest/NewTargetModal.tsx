import { Card, Modal, SectionLabel } from '@connorhoehnslalom/ui-components/shared';
import type { CrawlTarget } from './types';
import { TargetForm, type TargetDraft } from './TargetForm';

export type { TargetDraft } from './TargetForm';

/** Creating a crawl target — a header action's form, not a record (editing happens on the target's page). */
export function NewTargetModal({
  existing,
  onSave,
  onCancel,
}: {
  existing?: CrawlTarget | null;
  onSave: (draft: TargetDraft) => Promise<void>;
  onCancel: () => void;
}) {
  return (
    <Modal open={true} onClose={onCancel} maxWidth={560}>
      <Card padding="md" className="w-[min(560px,92vw)]">
        <SectionLabel as="h3" className="mb-4">
          {existing ? 'Edit Crawl Target' : 'New Crawl Target'}
        </SectionLabel>
        <TargetForm existing={existing} onSave={onSave} onCancel={onCancel} submitLabel={existing ? 'Save changes' : 'Create target'} />
      </Card>
    </Modal>
  );
}
