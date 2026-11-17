// The candidate's landing (docs/interviews-tenant-plan.md row I2.1; decision 3): the page an interview link opens.
//
// The candidate is not a user, so this page is rendered outside the app entirely (main.tsx mounts it in place of
// the session provider and the app when the path is /join): no shell, no nav, no bell, no tenant chrome, no
// session read, no realtime socket, nothing from the staff bundle's data hooks. It loads nothing from another
// origin and sends no Referer.
//
// The link carries its token in the fragment (/join#<token>), which no browser sends to a server. The page
// takes it, removes it from the address at once, and trades it for a guest cookie (POST
// /api/interview-invite/exchange). A reload has no token and reads the interview on that cookie (GET
// /api/interview-invite/interview). A dead link, whatever the reason, shows one plain page.
//
// Consents, the device check and the waiting room are row I2.3.

import { useEffect, useState } from 'react';
import { Card, EmptyState, KeyValue, LoadingState, PageFrame, Stack, T } from '@connorhoehn/ui-components/shared';

interface GuestInterview {
  opening: { title: string };
  round: { name: string; minutes: number };
  scheduledAt: string | null;
}

type View = { kind: 'loading' } | { kind: 'ready'; interview: GuestInterview } | { kind: 'dead' } | { kind: 'busy' } | { kind: 'failed' };

const API = '/api/interview-invite';

/** Read the token from the fragment and take it out of the address before anything else happens. */
function takeToken(): string | null {
  const token = window.location.hash.replace(/^#/, '');
  if (window.location.hash) window.history.replaceState(null, '', window.location.pathname);
  return token || null;
}

/** No request this page makes carries a Referer, whatever the browser's default. */
function noReferrer(): void {
  let meta = document.querySelector('meta[name="referrer"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.setAttribute('name', 'referrer');
    document.head.appendChild(meta);
  }
  meta.setAttribute('content', 'no-referrer');
}

async function load(token: string | null): Promise<View> {
  const init: RequestInit = { credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer' };
  const res = token
    ? await fetch(`${API}/exchange`, { ...init, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) })
    : await fetch(`${API}/interview`, init);
  if (res.ok) return { kind: 'ready', interview: ((await res.json()) as { interview: GuestInterview }).interview };
  if (res.status === 404) return { kind: 'dead' };
  if (res.status === 429) return { kind: 'busy' };
  return { kind: 'failed' };
}

function when(iso: string | null): string {
  if (!iso) return 'The time is still being arranged';
  return new Date(iso).toLocaleString(undefined, { weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
}

export default function JoinPage() {
  const [view, setView] = useState<View>({ kind: 'loading' });

  useEffect(() => {
    noReferrer();
    const token = takeToken();
    let live = true;
    load(token).then((v) => { if (live) setView(v); }, () => { if (live) setView({ kind: 'failed' }); });
    return () => { live = false; };
  }, []);

  if (view.kind === 'loading') return <PageFrame title="Your interview" data-testid="join-page"><LoadingState label="Opening your invitation" /></PageFrame>;

  if (view.kind === 'dead') {
    return (
      <PageFrame title="Your interview" data-testid="join-page">
        <EmptyState title="This link no longer works" body="Ask the person who sent it to you for a new one." testId="join-dead" />
      </PageFrame>
    );
  }

  if (view.kind === 'busy' || view.kind === 'failed') {
    return (
      <PageFrame title="Your interview" data-testid="join-page">
        <EmptyState
          title="This page could not open your invitation just now"
          body={view.kind === 'busy' ? 'Wait a minute, then open your link again.' : 'Check your connection, then open your link again.'}
          testId="join-retry"
        />
      </PageFrame>
    );
  }

  const { interview } = view;
  return (
    <PageFrame title="Your interview" description={interview.opening.title} data-testid="join-page">
      <Stack gap="md" className="max-w-xl">
        <Card padding="lg" data-testid="join-interview">
          <KeyValue
            items={[
              { label: 'Role', value: interview.opening.title },
              { label: 'Round', value: interview.round.name },
              { label: 'Length', value: `${interview.round.minutes} minutes` },
              { label: 'When', value: when(interview.scheduledAt) },
            ]}
          />
        </Card>
        <T size="sm" tone="secondary" data-testid="join-next">
          A few minutes before the start, open your link again and your interviewer will let you in.
        </T>
      </Stack>
    </PageFrame>
  );
}
