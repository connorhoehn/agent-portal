// Fixture (failing): a decision asked in a modal form — counts as one decisionmodal.
import { Modal, Textarea, Button } from '@connorhoehnslalom/ui-components/shared';

export function Decide({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title="Approve this spend?">
      <Textarea aria-label="Reason" />
      <Button onClick={onClose}>Approve</Button>
    </Modal>
  );
}
