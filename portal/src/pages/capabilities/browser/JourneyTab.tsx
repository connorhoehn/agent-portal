import { useState } from 'react';
import { Button, Card, CardHeader, ChoiceList, ChoiceRow, Inline, InlineAlert, InlinePlaceholder, Input, MetaLine, SectionLabel, SegmentedControl, Stack, T } from '@connorhoehnslalom/ui-components/shared';
import { useCapabilities } from '../../../lib/capabilities';
import { useFetch } from '../../../hooks/useFetch';
import { toastError } from '../../../lib/toastStore';
import { JourneyCarousel } from './JourneyCarousel';
import { JourneyTimeline } from './JourneyTimeline';
import { SESSIONS_URL, closeSession, journeyUrl, launchSession, navigateSession } from './browserApi';
import { openSessions } from './browserFormat';
import type { BrowserSession, JourneyStep } from './types';
import { UnavailableNotice } from '../../../components/UnavailableNotice';

const VIEW_OPTIONS = [
  { value: 'carousel', label: 'Carousel' },
  { value: 'timeline', label: 'Timeline' },
];

/**
 * Journey Recorder: an ordered series of web pages with screenshots, replayable
 * as a carousel or a timeline.
 *
 * Starting/steering/ending a journey mutates /api/capabilities (ManageDevbox);
 * resuming an existing session to VIEW its recorded steps is a read and stays
 * open to everyone.
 */
export function JourneyTab() {
  const { can, ready } = useCapabilities();
  const canManage = ready && can('ManageDevbox');

  const { data: sessionsData, refresh: refreshSessions, degraded: sessionsDegraded } =
    useFetch<{ sessions: BrowserSession[]; degraded?: string }>(SESSIONS_URL, 10000);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const { data: journeyData, refresh: refreshJourney } =
    useFetch<{ steps: JourneyStep[] }>(journeyUrl(activeSessionId), 5000);

  const [url, setUrl] = useState('https://example.com');
  const [label, setLabel] = useState('journey');
  const [navigating, setNavigating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState('carousel');
  const [carouselIdx, setCarouselIdx] = useState(0);

  const steps = journeyData?.steps ?? [];
  const resumable = openSessions(sessionsData?.sessions ?? []);

  async function startJourney() {
    setNavigating(true);
    setError(null);
    try {
      const session = await launchSession(label, url);
      setActiveSessionId(session.sessionId);
      // The launch endpoint navigates but does not capture into the journey
      // ring, so the first step needs an explicit capturing navigate.
      await navigateSession(session.sessionId, url);
      setCarouselIdx(0);
      refreshJourney();
      refreshSessions();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setNavigating(false);
    }
  }

  async function stepTo(nextUrl: string) {
    if (!activeSessionId) return;
    setNavigating(true);
    setError(null);
    try {
      await navigateSession(activeSessionId, nextUrl);
      refreshJourney();
      setCarouselIdx(steps.length); // jump the carousel to the new step
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setNavigating(false);
    }
  }

  async function endJourney() {
    if (!activeSessionId) return;
    try {
      await closeSession(activeSessionId);
      refreshSessions();
      setActiveSessionId(null);
      setCarouselIdx(0);
    } catch (err) {
      toastError(null, 'Could not end journey', err instanceof Error ? err.message : undefined);
    }
  }

  return (
    <Card padding="none" className="overflow-hidden">
      <CardHeader inset
        title="Journey Recorder"
        subtitle="Record an ordered series of web pages with screenshots. Replay as a carousel or scrollable timeline."
      />
      <Stack gap="md" className="px-3.5 py-3">
        {!activeSessionId ? (
          <Stack gap="lg">
            {canManage ? (
              <Stack gap="sm">
                <Input
                  value={label}
                  onChange={e => setLabel(e.target.value)}
                  placeholder="Journey label (e.g. competitor-research)"
                  aria-label="Journey label"
                />
                <Inline gap="sm" wrap={false}>
                  <Input
                    type="url"
                    value={url}
                    onChange={e => setUrl(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') void startJourney(); }}
                    placeholder="Starting URL"
                    aria-label="Starting URL"
                    className="flex-1"
                  />
                  <Button variant="primary" onClick={() => { void startJourney(); }} disabled={navigating || !url}>
                    {navigating ? 'Starting…' : 'Start journey'}
                  </Button>
                </Inline>
              </Stack>
            ) : (
              <InlinePlaceholder>
                Viewing only — your role can&apos;t start a journey. Open sessions below can still be replayed.
              </InlinePlaceholder>
            )}

            {/* `/api/capabilities/browser-sessions` answers 200 with `degraded`
                when ListBrowserSessions fails, and this block used to be gated
                on `resumable.length > 0` alone — so a failed read and a genuinely
                empty list produced the same screen: no "resume" affordance and
                no explanation. That is worse here than on a list page, because
                the reader's next move is to START a session, and an AgentCore
                browser is a real resource to spend on the belief that nothing
                is open. */}
            {sessionsDegraded && resumable.length === 0 && (
              <UnavailableNotice
                error={sessionsDegraded}
                what="open browser sessions"
                source="Sessions are listed from AgentCore ListBrowserSessions"
                onRetry={() => void refreshSessions()}
              />
            )}
            {resumable.length > 0 && (
              <Stack gap="sm">
                <SectionLabel>Or resume an open session</SectionLabel>
                <ChoiceList data-testid="journey-resumable">
                  {resumable.map(s => (
                    <ChoiceRow
                      key={s.sessionId}
                      title={s.sessionId}
                      description={s.agentName}
                      onSelect={() => { setActiveSessionId(s.sessionId); refreshJourney(); }}
                      data-testid={`journey-resume-${s.sessionId}`}
                    />
                  ))}
                </ChoiceList>
              </Stack>
            )}
          </Stack>
        ) : (
          <Stack gap="md">
            {canManage && (
              <Inline gap="sm" wrap={false}>
                <Input
                  type="url"
                  value={url}
                  onChange={e => setUrl(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') void stepTo(url); }}
                  placeholder="Next URL"
                  aria-label="Next URL"
                  className="flex-1"
                />
                <Button variant="primary" onClick={() => { void stepTo(url); }} disabled={navigating || !url}>
                  {navigating ? 'Navigating…' : 'Navigate (record)'}
                </Button>
                <Button variant="danger" onClick={() => { void endJourney(); }}>End</Button>
              </Inline>
            )}

            <Inline gap="sm" justify="between">
              <MetaLine
                items={[
                  `${steps.length} step${steps.length === 1 ? '' : 's'}`,
                  <T key="sid" className="font-mono">session {activeSessionId.slice(0, 12)}…</T>,
                ]}
              />
              <SegmentedControl options={VIEW_OPTIONS} value={view} onChange={setView} size="sm" />
            </Inline>

            {error && <InlineAlert tone="error">{error}</InlineAlert>}

            {steps.length === 0 ? (
              <InlinePlaceholder align="center" size="sm">
                No steps captured yet. Enter a URL above.
              </InlinePlaceholder>
            ) : view === 'carousel' ? (
              <JourneyCarousel
                steps={steps}
                idx={Math.min(carouselIdx, steps.length - 1)}
                onIdx={setCarouselIdx}
              />
            ) : (
              <JourneyTimeline steps={steps} onJump={i => { setView('carousel'); setCarouselIdx(i); }} />
            )}
          </Stack>
        )}
      </Stack>
    </Card>
  );
}
