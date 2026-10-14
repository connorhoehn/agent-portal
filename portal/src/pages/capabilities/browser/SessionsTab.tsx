import { useState } from 'react';
import {
  Button, Card, CardHeader, Chip, CloseIcon, IconButton, Inline, InlinePlaceholder, Input,
  Link as ExternalLink, MetaLine, Stack, T, Table, TableBody, TableHead, TableRow, TableTd,
  TableTh,
} from '@connorhoehnslalom/ui-components/shared';
import { useCapabilities } from '../../../lib/capabilities';
import { useFetch } from '../../../hooks/useFetch';
import { UnavailableNotice } from '../../../components/UnavailableNotice';
import { relativeTimeSeconds } from '../../../lib/relativeTime';
import { toastError } from '../../../lib/toastStore';
import { SESSIONS_URL, closeSession, launchSession } from './browserApi';
import { closedSessions, isBlankUrl, openSessions, sessionTone } from './browserFormat';
import type { BrowserSession } from './types';

const MAX_PAST_ROWS = 20;

/**
 * The raw open + closed session lists — the admin power-user view.
 * Launching and closing mutate /api/capabilities (ManageDevbox); the lists
 * themselves are readable by anyone.
 */
export function SessionsTab() {
  const { can, ready } = useCapabilities();
  const canManage = ready && can('ManageDevbox');
  // A dead BROWSER_ID fails SOFT here — CLAUDE.md records exactly this: the
  // browser call is indistinguishable from "there are no sessions" unless the
  // route's `degraded` marker is read. It is, now.
  const {
    data, error, degraded, refresh,
  } = useFetch<{ sessions: BrowserSession[] }>(SESSIONS_URL, 10000);
  const failure = error ?? degraded;

  const sessions = data?.sessions ?? [];
  const open = openSessions(sessions);
  const closed = closedSessions(sessions);

  async function handleClose(sessionId: string) {
    try {
      await closeSession(sessionId);
      refresh();
    } catch (err) {
      toastError(null, 'Could not close session', err instanceof Error ? err.message : undefined);
    }
  }

  return (
    <Stack gap="lg">
      {failure && (
        <UnavailableNotice
          error={failure}
          what="the browser session list"
          source="Sessions are listed live from the AgentCore Data Plane"
          onRetry={refresh}
        />
      )}

      {canManage && <LaunchSessionCard onLaunched={refresh} />}

      <Card padding="none" className="overflow-hidden">
        <CardHeader inset title="Open sessions" action={<MetaLine items={[`${open.length} open`]} />} />
        <Stack gap="md" className="px-3.5 py-3">
          {failure ? (
            <InlinePlaceholder align="center" size="sm" tone="surface">
              Unknown — this read failed. See the notice above.
            </InlinePlaceholder>
          ) : open.length === 0 ? (
            <InlinePlaceholder align="center" size="sm">No open browser sessions.</InlinePlaceholder>
          ) : (
            <Table>
              <TableHead>
                <TableRow>
                  <TableTh>Label</TableTh>
                  <TableTh>Status</TableTh>
                  <TableTh>Current URL</TableTh>
                  <TableTh numeric>Requests</TableTh>
                  <TableTh>Last active</TableTh>
                  <TableTh><T className="sr-only">Actions</T></TableTh>
                </TableRow>
              </TableHead>
              <TableBody>
                {open.map(session => (
                  <TableRow key={session.sessionId}>
                    <TableTd >{session.agentName}</TableTd>
                    <TableTd>
                      <Chip tone={sessionTone(session.status)} size="xs">{session.status}</Chip>
                    </TableTd>
                    {/* title=, like the other sessions table in this file does
                        at the `s.currentUrl` cell below. A truncated URL with no
                        hover is a link whose destination cannot be read at all. */}
                    <TableTd className="max-w-[260px] truncate" title={session.currentUrl}>
                      {isBlankUrl(session.currentUrl) ? (
                        <T className="text-text-tertiary">—</T>
                      ) : (
                        <ExternalLink external href={session.currentUrl}>{session.currentUrl}</ExternalLink>
                      )}
                    </TableTd>
                    <TableTd numeric>{session.requestCount}</TableTd>
                    <TableTd className="whitespace-nowrap text-text-tertiary">
                      {relativeTimeSeconds(session.lastActivityAt)}
                    </TableTd>
                    <TableTd>
                      {canManage && (
                        <IconButton
                          size="sm"
                          icon={<CloseIcon />}
                          aria-label="Close session"
                          title="Close session"
                          onClick={() => void handleClose(session.sessionId)}
                        />
                      )}
                    </TableTd>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Stack>
      </Card>

      <Card padding="none" className="overflow-hidden">
        <CardHeader inset
          title="Past sessions"
          action={<MetaLine items={['from AgentCore Data Plane', `${closed.length} closed`]} />}
        />
        <Stack gap="md" className="px-3.5 py-3">
          {failure ? (
            <InlinePlaceholder align="center" size="sm" tone="surface">
              Unknown — this read failed. See the notice above.
            </InlinePlaceholder>
          ) : closed.length === 0 ? (
            <InlinePlaceholder align="center" size="sm">
              No past sessions yet. Launch one above, or invoke the search agent with a
              browse-the-web prompt.
            </InlinePlaceholder>
          ) : (
            <Table>
              <TableHead>
                <TableRow>
                  <TableTh>Agent</TableTh>
                  <TableTh>Started</TableTh>
                  <TableTh>Last URL</TableTh>
                  <TableTh numeric>Requests</TableTh>
                  <TableTh>Status</TableTh>
                </TableRow>
              </TableHead>
              <TableBody>
                {closed.slice(0, MAX_PAST_ROWS).map(s => (
                  <TableRow key={s.sessionId}>
                    <TableTd >{s.agentName}</TableTd>
                    <TableTd className="whitespace-nowrap text-text-tertiary">
                      {new Date(s.startedAt).toLocaleString()}
                    </TableTd>
                    <TableTd className="max-w-[320px] truncate" title={s.currentUrl}>
                      {isBlankUrl(s.currentUrl) ? <T className="text-text-tertiary">—</T> : s.currentUrl}
                    </TableTd>
                    <TableTd numeric className="text-text-tertiary">
                      {s.requestCount}
                    </TableTd>
                    <TableTd><Chip tone="neutral" size="xs">{s.status}</Chip></TableTd>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Stack>
      </Card>
    </Stack>
  );
}

function LaunchSessionCard({ onLaunched }: { onLaunched: () => void }) {
  const [agentName, setAgentName] = useState('portal');
  const [url, setUrl] = useState('');
  const [launching, setLaunching] = useState(false);

  async function launch() {
    if (!agentName) return;
    setLaunching(true);
    try {
      await launchSession(agentName, url);
      setUrl('');
      onLaunched();
    } finally {
      setLaunching(false);
    }
  }

  return (
    <Card padding="none" className="overflow-hidden">
      <CardHeader inset title="Launch browser session" />
      <Stack gap="md" className="px-3.5 py-3">
        <Inline gap="sm" wrap={false}>
          <Input
            value={agentName}
            onChange={e => setAgentName(e.target.value)}
            placeholder="Session label (any text)"
            aria-label="Session label"
            className="w-40 flex-none"
          />
          <Input
            type="url"
            value={url}
            onChange={e => setUrl(e.target.value)}
            placeholder="Starting URL (optional)"
            aria-label="Starting URL"
            className="flex-1"
          />
          <Button variant="primary" onClick={() => { void launch(); }} disabled={!agentName || launching}>
            {launching ? 'Launching…' : 'Launch'}
          </Button>
        </Inline>
      </Stack>
    </Card>
  );
}
