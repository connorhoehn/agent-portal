import { useEffect, useRef, useState } from 'react';
import {
  Inline,
  Spinner,
  Stack,
} from '@connorhoehnslalom/ui-components/shared';

// ─── Types ────────────────────────────────────────────────────────────────────

type ProvisioningStep =
  | 'create_aurora_table'
  | 'create_vector_index'
  | 'create_text_index'
  | 'create_bedrock_kb'
  | 'wait_kb_active'
  | 'create_data_source'
  | 'init_landing_zone'
  | 'done';

type StepStatus = 'pending' | 'running' | 'done' | 'error';

const STEPS: { id: ProvisioningStep; label: string }[] = [
  { id: 'create_aurora_table', label: 'Creating Aurora vector table' },
  { id: 'create_vector_index', label: 'Building HNSW index' },
  { id: 'create_text_index',   label: 'Building full-text index' },
  { id: 'create_bedrock_kb',   label: 'Creating Bedrock Knowledge Base' },
  { id: 'wait_kb_active',      label: 'Waiting for KB to become ACTIVE' },
  { id: 'create_data_source',  label: 'Creating S3 data source' },
  { id: 'init_landing_zone',   label: 'Initialising S3 landing zone' },
];

// ─── Props ────────────────────────────────────────────────────────────────────

export interface ProvisioningProgressProps {
  registryId: string;
  onComplete: (bedrockKbId: string) => void;
  onError: (message: string) => void;
}

// ─── Step icon sub-components ─────────────────────────────────────────────────

function PendingIcon() {
  return (
    <Inline gap="none" aria-hidden className="w-[18px] h-[18px] rounded-full border-2 border-border shrink-0" />
  );
}

function RunningIcon() {
  return <Spinner size="sm" />;
}

function DoneIcon() {
  return (
    <Inline
      gap="none"
      justify="center"
      aria-hidden
      className="w-[18px] h-[18px] rounded-full bg-success shrink-0 text-[11px] text-surface font-bold"
    >
      ✓
    </Inline>
  );
}

function ErrorIcon() {
  return (
    <Inline
      gap="none"
      justify="center"
      aria-hidden
      className="w-[18px] h-[18px] rounded-full bg-danger shrink-0 text-[11px] text-surface font-bold"
    >
      ✗
    </Inline>
  );
}

function StepIcon({ status }: { status: StepStatus }) {
  if (status === 'running') return <RunningIcon />;
  if (status === 'done')    return <DoneIcon />;
  if (status === 'error')   return <ErrorIcon />;
  return <PendingIcon />;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ProvisioningProgress({
  registryId,
  onComplete,
  onError,
}: ProvisioningProgressProps) {
  const initialStates = () => {
    const m: Partial<Record<ProvisioningStep, StepStatus>> = {};
    for (const s of STEPS) m[s.id] = 'pending';
    return m as Record<ProvisioningStep, StepStatus>;
  };

  const [stepStates, setStepStates] = useState<Record<ProvisioningStep, StepStatus>>(initialStates);
  const [stepMessages, setStepMessages] = useState<Partial<Record<ProvisioningStep, string>>>({});
  const esRef = useRef<EventSource | null>(null);

  // Stable callback refs so the effect only runs when registryId changes
  const onCompleteRef = useRef(onComplete);
  const onErrorRef    = useRef(onError);
  onCompleteRef.current = onComplete;
  onErrorRef.current    = onError;

  useEffect(() => {
    const es = new EventSource(`/api/admin/kb-registry/${registryId}/status`);
    esRef.current = es;

    // Track whether we received a terminal event (complete/failed/error) so
    // the es.onerror handler doesn't overwrite the actual error when the server
    // intentionally closes the stream after sending the terminal event.
    let terminal = false;

    es.onmessage = (ev) => {
      let data: {
        type: string;
        step?: ProvisioningStep;
        stepStatus?: StepStatus;
        message?: string;
        status?: string;
        kbId?: string;
      };

      try {
        data = JSON.parse(ev.data);
      } catch {
        return;
      }

      if (data.type === 'poll') {
        if (data.status === 'ACTIVE') {
          terminal = true;
          es.close();
          onCompleteRef.current(data.kbId ?? '');
        } else if (data.status === 'FAILED') {
          terminal = true;
          es.close();
          onErrorRef.current('KB provisioning failed');
        }
        return;
      }

      if (data.type === 'step' && data.step && data.stepStatus) {
        setStepStates(prev => ({ ...prev, [data.step!]: data.stepStatus! }));
        if (data.message) {
          setStepMessages(prev => ({ ...prev, [data.step!]: data.message }));
        }
        return;
      }

      if (data.type === 'complete') {
        terminal = true;
        es.close();
        onCompleteRef.current(data.kbId ?? '');
        return;
      }

      if (data.type === 'failed' || data.type === 'error') {
        terminal = true;
        es.close();
        onErrorRef.current(data.message ?? 'Unknown provisioning error');
      }
    };

    es.onerror = () => {
      // Only surface connection errors if we haven't already received a
      // terminal event — otherwise the server intentionally closed the stream.
      if (!terminal) {
        es.close();
        onErrorRef.current('Connection to provisioning stream lost');
      }
    };

    return () => {
      es.close();
    };
  }, [registryId]);

  const doneCount    = STEPS.filter(s => stepStates[s.id] === 'done').length;
  const totalCount   = STEPS.length;
  const currentStep  = STEPS.find(s => stepStates[s.id] === 'running');
  const currentLabel = currentStep?.label ?? 'idle';


  return (
    <div role="region" aria-label="KB provisioning progress">
      {/* A screen-reader-only progressbar carrying the live step count. The
          `srOnlyStyle` object it replaces was the classic clip-rect recipe;
          `sr-only` is the same thing as a class. */}
      <Inline
        gap="none"
        role="progressbar"
        aria-valuenow={doneCount}
        aria-valuemin={0}
        aria-valuemax={totalCount}
        aria-valuetext={`Step ${doneCount + 1} of ${totalCount}: ${currentLabel}`}
        className="sr-only"
      />

      <Stack gap="none" className="flex flex-col gap-3">
        {STEPS.map(step => {
          const status = stepStates[step.id];
          const msg    = stepMessages[step.id];

          return (
            <Inline gap="none"
              key={step.id}
              className="flex items-start gap-2.5"
            >
              <StepIcon status={status} />

              <Stack gap="none" className="flex flex-col gap-0.5">
                <Inline
                  as="span"
                  gap="none"
                  className={[
                    'text-[13px]',
                    status === 'running' ? 'font-semibold' : 'font-normal',
                    status === 'done' ? 'text-success'
                      : status === 'error' ? 'text-danger'
                      : status === 'running' ? 'text-text-primary' : 'text-text-tertiary',
                  ].join(' ')}
                >
                  {step.label}
                </Inline>
                {msg && (
                  <Inline as="span" gap="none" className="text-[11px] text-text-tertiary">{msg}</Inline>
                )}
              </Stack>
            </Inline>
          );
        })}
      </Stack>
    </div>
  );
}

export default ProvisioningProgress;
