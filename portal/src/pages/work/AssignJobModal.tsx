// The confirmation step between "this work item could use an agent" and a row
// on the queue. Picking a suggestion used to fill a composer somewhere else on
// the page and quietly wait; now the choice opens this modal, which says
// exactly what will run — the item, the initiative it moves, the complexity
// and dollar estimate, and the mission the agent will be handed — and queues
// it on explicit confirmation only.

import { useState } from 'react';
import {
  Button, Card, Chip, DetailSection, Divider, Inline, Modal, Stack,
} from '@connorhoehnslalom/ui-components/shared';
import { KeyValue } from '../../components/KeyValue';
import { toastError, toastPending, toastSuccess } from '../../lib/toastStore';
import { RediscoveryPanel } from './RediscoveryPanel';
import {
  SUGGESTION_LABEL, SUGGESTION_TONE, T, post, serves,
  type Job, type WorkSuggestion,
} from './workShared';

export function AssignJobModal({ suggestion, onClose, onQueued }: {
  suggestion: WorkSuggestion | null;
  onClose: () => void;
  onQueued: (job: Job) => void;
}) {
  const [busy, setBusy] = useState(false);
  const s = suggestion;

  async function confirm() {
    if (!s || busy) return;
    setBusy(true);
    const tid = toastPending('Queueing job', s.title);
    try {
      const res = await post('/api/work/jobs', {
        title: s.title, prompt: s.prompt, suggestionId: s.id,
      });
      if (!res.ok) throw new Error((await res.json() as { error?: string }).error ?? `HTTP ${res.status}`);
      const job = await res.json() as Job;
      const sv = serves(job);
      toastSuccess(tid, 'Job queued', sv
        ? `Serving “${sv.itemTitle}” · ${sv.initiativeName} — the first idle computer picks it up within ~10s`
        : 'an idle worker picks it up within ~10s');
      onQueued(job);
    } catch (err) {
      toastError(tid, 'Could not queue job', (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={s != null}
      onClose={onClose}
      title="Queue this for an agent"
      maxWidth={560}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={() => void confirm()} disabled={busy}>
            {busy ? 'Queueing…' : 'Queue job'}
          </Button>
        </>
      }
    >
      {s && (
        <Stack gap="xs">
          <Inline align="center" gap="sm" className="pb-2">
            <Chip tone={SUGGESTION_TONE[s.kind]} size="sm">{SUGGESTION_LABEL[s.kind]}</Chip>
            <T className="text-[13.5px] font-semibold text-text-primary">{s.title}</T>
          </Inline>
          <KeyValue layout="row" labelWidth="w-[110px]" label="Initiative" value={s.initiativeName} />
          <KeyValue layout="row" labelWidth="w-[110px]" label="Why now" value={s.reason} />
          <KeyValue layout="row" labelWidth="w-[110px]" label="Estimate">
            <T className="tabular-nums">
              {s.storyPoints != null ? `${s.storyPoints} pts` : 'unestimated'}
              {s.estimatedCostUsd != null ? ` · ~$${s.estimatedCostUsd.toFixed(2)}` : ''}
            </T>
          </KeyValue>
          <KeyValue
            layout="row"
            labelWidth="w-[110px]"
            label="Runs on"
            value="the first idle computer (a microVM with workspace + git), within ~10s"
          />
          <Divider spacing="sm" />
          {/* Prior art belongs right next to the number, not on a page nobody
              visits before confirming — this is the one instant a human is
              already paying attention to what this job costs. */}
          <RediscoveryPanel
            problem={`${s.title}\n\n${s.prompt}`}
            initiativeId={s.initiativeId}
            workItemId={s.workItemId}
          />
          {/* The mission is what the agent actually receives — showing it here
              is the difference between confirming an action and confirming a
              title. */}
          <DetailSection title="The mission the agent gets" first>
            <Card padding="sm" className="max-h-[180px] overflow-y-auto whitespace-pre-wrap bg-surface-hover/40 text-[12px] leading-relaxed text-text-secondary">
              {s.prompt}
            </Card>
          </DetailSection>
          <Divider spacing="sm" />
          <T className="text-[11px] text-text-tertiary">
            Anything the agent produces still passes review before it ships.
          </T>
        </Stack>
      )}
    </Modal>
  );
}
