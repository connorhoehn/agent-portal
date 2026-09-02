import { useState } from 'react';
import { Button, Card, Inline, InlineAlert, InlinePlaceholder, Input, MetaLine, SectionLabel, SegmentedControl, Stack } from '@connorhoehnslalom/ui-components/shared';
import { useCapabilities } from '../../../lib/capabilities';
import { useFetch } from '../../../hooks/useFetch';
import { JourneyCarousel } from './JourneyCarousel';
import { JourneyTimeline } from './JourneyTimeline';
import { SESSIONS_URL, closeSession, journeyUrl, launchSession, navigateSession } from './browserApi';
import { openSessions } from './browserFormat';
import type { BrowserSession, JourneyStep } from './types';

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

  const { data: sessionsData, refresh: refreshSessions } =
    useFetch<{ sessions: BrowserSession[] }>(SESSIONS_URL, 10000);
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
    await closeSession(activeSessionId);
    refreshSessions();
    setActiveSessionId(null);
    setCarouselIdx(0);
  }

  return (
    <Card padding="md">
      <Stack gap="md">
        <Stack gap="xs">
          <h2 className="text-[14px] font-semibold text-text-primary">Journey Recorder</h2>
          <p className="text-[12px] leading-relaxed text-text-tertiary">
            Record an ordered series of web pages with screenshots. Replay as a carousel or
            scrollable timeline.
          </p>
        </Stack>

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

            {resumable.length > 0 && (
              <Stack gap="sm">
                <SectionLabel>Or resume an open session</SectionLabel>
                <Stack gap="xs">
                  {resumable.map(s => (
                    <Button
                      key={s.sessionId}
                      variant="secondary"
                      size="sm"
                      onClick={() => { setActiveSessionId(s.sessionId); refreshJourney(); }}
                      fullWidth
                    >
                      {/* Button centres its content; the rail reads as a list,
                          so the label is pushed left by a full-width row. */}
                      <Inline gap="sm" justify="start" wrap={false} className="w-full">
                        <span className="font-mono text-[11px]">{s.sessionId}</span>
                        <span className="text-text-tertiary">{s.agentName}</span>
                      </Inline>
                    </Button>
                  ))}
                </Stack>
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
                  <span key="sid" className="font-mono">session {activeSessionId.slice(0, 12)}…</span>,
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
