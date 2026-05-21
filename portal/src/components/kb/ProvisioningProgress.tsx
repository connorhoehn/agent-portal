import { useEffect, useRef, useState } from 'react';

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
    <span
      style={{
        display: 'inline-block',
        width: 18,
        height: 18,
        borderRadius: '50%',
        border: '2px solid #d1d5db',
        flexShrink: 0,
      }}
    />
  );
}

function RunningIcon() {
  return (
    <span
      style={{
        display: 'inline-block',
        width: 18,
        height: 18,
        borderRadius: '50%',
        border: '2px solid #2563eb',
        borderTopColor: 'transparent',
        flexShrink: 0,
        animation: 'kb-spin 0.7s linear infinite',
      }}
    />
  );
}

function DoneIcon() {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 18,
        height: 18,
        borderRadius: '50%',
        background: '#16a34a',
        flexShrink: 0,
        fontSize: 11,
        color: '#fff',
        fontWeight: 700,
      }}
    >
      ✓
    </span>
  );
}

function ErrorIcon() {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 18,
        height: 18,
        borderRadius: '50%',
        background: '#dc2626',
        flexShrink: 0,
        fontSize: 11,
        color: '#fff',
        fontWeight: 700,
      }}
    >
      ✗
    </span>
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

  return (
    <>
      {/* Inject keyframe once via a style tag */}
      <style>{`@keyframes kb-spin { to { transform: rotate(360deg); } }`}</style>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {STEPS.map(step => {
          const status = stepStates[step.id];
          const msg    = stepMessages[step.id];

          return (
            <div
              key={step.id}
              style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}
            >
              <StepIcon status={status} />

              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span
                  style={{
                    fontSize: 13,
                    fontWeight: status === 'running' ? 600 : 400,
                    color:
                      status === 'done'
                        ? '#16a34a'
                        : status === 'error'
                        ? '#dc2626'
                        : status === 'running'
                        ? '#1e40af'
                        : '#6b7280',
                  }}
                >
                  {step.label}
                </span>
                {msg && (
                  <span style={{ fontSize: 11, color: '#9ca3af' }}>{msg}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

export default ProvisioningProgress;
