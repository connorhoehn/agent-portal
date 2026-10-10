// The Distillation landing's "Play the demo" (docs/distillation-demo.md).
//
// Only on a mock dev server: the control routes (`/api/__mock/*`) 404 off
// one, and a 404 from the state read hides this whole section. Starting the
// demo switches the server's mock world to `distillation-demo` — for every
// viewer of that server — so the action is gated like the other bot controls
// (ManageBots) and says so. The progress line is the director's own state,
// read from `GET /api/__mock/state`, never a client-side timer.
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { Button, Inline, PageSection, Stack, StatusPill, T } from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { toastError } from '../../lib/toastStore';
import { sendJson } from '../../lib/writeJson';
import { DEMO_SCENARIO, demoProgress, type MockStateResponse } from './demoModel';

export function DistillationDemoPanel({ canPlay, onChanged }: {
  /** ManageBots — the same gate as Compact and Agree/Disagree. */
  canPlay: boolean;
  /** The module re-reads its live counts after a start or a stop. */
  onChanged: () => void;
}) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  // Polled while a story plays (each beat is ~2.5 s); slowly otherwise, so a
  // story started from elsewhere still shows up here.
  const [fast, setFast] = useState(false);
  // A 404 means mock control is off on this server: stop asking.
  const [off, setOff] = useState(false);
  const state = useFetch<MockStateResponse>(canPlay && !off ? '/api/__mock/state' : null, fast ? 2_000 : 20_000);
  const demo = state.data?.distillationDemo;
  const progress = demoProgress(demo);
  useEffect(() => { setFast(progress.playing); }, [progress.playing]);
  useEffect(() => { if (state.error && !state.data) setOff(true); }, [state.error, state.data]);

  // Mock control is off (404), not yet answered, or the reader may not play.
  if (!canPlay || state.error || !state.data || !demo) return null;

  const run = async (path: string, body: unknown) => {
    setBusy(true);
    try {
      await sendJson(path, 'POST', body);
      state.refresh();
      onChanged();
    } catch (err) {
      toastError(null, 'Could not change the demo', err instanceof Error ? err.message : 'Request failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <PageSection
      size="md"
      title="Watch the fleet learn"
      description="A three-minute story: lab sessions write run notes, a compaction turns them into patterns, people review them, and the agreed ones become a guide an agent then runs. Playing it replaces this server's demo data for everyone using it."
      actions={(
        <Inline gap="xs" align="center">
          {progress.playing && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void run('/api/__mock/reset', {}); }} data-testid="distillation-demo-stop">
              Stop and restore
            </Button>
          )}
          <Button
            size="sm"
            variant={progress.playing ? 'secondary' : 'primary'}
            disabled={busy}
            onClick={() => { void run('/api/__mock/scenario', { scenario: DEMO_SCENARIO }); }}
            data-testid="distillation-demo-play"
          >
            {progress.playing ? 'Restart the demo' : 'Play the demo'}
          </Button>
        </Inline>
      )}
      data-testid="distillation-demo"
    >
      {progress.line && (
        <Stack gap="xs">
          <Inline gap="sm" align="center" wrap={false}>
            <StatusPill tone={progress.tone} label={progress.status} size="sm" data-testid="distillation-demo-status" />
            <T size="sm" tone="secondary" wrap data-testid="distillation-demo-line">{progress.line}</T>
          </Inline>
          {progress.look && (
            <Inline gap="xs">
              <Button size="sm" variant="ghost" onClick={() => navigate(progress.look!.href)} data-testid="distillation-demo-look">
                {progress.look.label} →
              </Button>
            </Inline>
          )}
        </Stack>
      )}
    </PageSection>
  );
}
