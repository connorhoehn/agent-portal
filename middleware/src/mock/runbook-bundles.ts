// The seeded runbooks that carry tools (R8): two procedures a run built
// mid-session and would otherwise lose when the workspace is wiped, plus the
// established procedures in runbook-bundles-established.ts (the journey walk,
// the packed-library release). Each is self-contained (procedure + scripts/ + data/)
// and ships to every box as a Claude Code skill (lib/runbooks/library.ts).
//
//   rb-ws-cdp-debug             watch a page's websocket frames over the Chrome
//                               DevTools Protocol; replays a recorded capture offline
//   rb-gateway-presence-client  the client captured for the gateway's undocumented
//                               presence API; replays a recorded response offline
//
// The files are real and run: mock/runbook-bundles/<id>/ (packed into
// runbook-bundles.generated.ts). Each Verify command runs offline against the
// bundled data, and mock/__tests__/runbook-bundles.test.ts runs it.
import type { RunbookDoc, RunbookFile } from '../lib/runbooks/types.js';
import { filesOf } from '../lib/runbooks/files.js';
import { BUNDLE_FILES } from './runbook-bundles.generated.js';
import { JOURNEY_WALK_RUNBOOK_ID, LIBRARY_RELEASE_RUNBOOK_ID, journeyWalkDoc, libraryReleaseDoc } from './runbook-bundles-established.js';

export { JOURNEY_WALK_RUNBOOK_ID, LIBRARY_RELEASE_RUNBOOK_ID } from './runbook-bundles-established.js';

export const CDP_RUNBOOK_ID = 'rb-ws-cdp-debug';
export const PRESENCE_RUNBOOK_ID = 'rb-gateway-presence-client';

export const cdpWebsocketDoc: RunbookDoc = {
  title: "Debug a websocket app's traffic over the DevTools protocol",
  summary: 'Print every frame a page sends and receives over its websockets, live from Chrome or replayed from a capture, with a tally by message type.',
  use_when: [
    'A realtime page looks idle or wrong and you need to see which websocket frames actually crossed the socket',
    'An action in the UI seems to do nothing and you suspect the gateway never answered',
  ],
  not_for: [
    'Plain HTTP requests (read the Network panel or a HAR instead)',
    'Load-testing a gateway',
  ],
  triggers: {
    work_item_labels: ['realtime', 'websocket'], repos: [], tools: ['chrome', 'cdp'],
    keywords: ['websocket', 'frames', 'cdp', 'devtools', 'gateway', 'realtime', 'socket'],
  },
  preconditions: [
    'Node 22 or later is on the PATH (the script uses its built-in WebSocket).',
    'You know the address of the page under test (`$APP_URL`).',
  ],
  steps: [
    {
      do: "Open this skill's folder so the bundled scripts and data resolve.",
      command: { lang: 'bash', text: 'cd ~/.claude/skills/rb-ws-cdp-debug' },
      expect: '`ls` to list `scripts` and `data`.',
    },
    {
      do: 'Start a debugging Chrome on the page under test, unless one is already listening.',
      command: { lang: 'bash', text: '${CHROME:-google-chrome} --headless=new --remote-debugging-port=9222 \\\n  --user-data-dir="$(mktemp -d)" "$APP_URL" &\nCHROME_PID=$!' },
      expect: '`curl -s localhost:9222/json/version` to print a `Browser` line.',
    },
    {
      do: "Capture the page's websocket frames while you reproduce the problem.",
      command: { lang: 'bash', text: 'node scripts/cdp-ws-frames.mjs --port 9222 --match "$APP_URL" --seconds 60 --out /tmp/frames.jsonl' },
      expect: 'one `→ sent` or `← recv` line per frame, then a `summary:` line.',
      why: 'The raw capture in /tmp/frames.jsonl replays offline, so you can share it or compare two runs.',
    },
    {
      do: 'Read the summary of the websocket capture for frames you expected and did not get.',
      command: { lang: 'bash', text: 'node scripts/cdp-ws-frames.mjs --replay /tmp/frames.jsonl | tail -1' },
      expect: 'the message types tallied; a `subscribe` with no `subscribed`, or sends with no receives, is where to look.',
    },
  ],
  verify: [
    {
      check: 'Replay the bundled capture and compare its summary with the recorded one.',
      command: { lang: 'bash', text: 'node scripts/cdp-ws-frames.mjs --replay data/sample-frames.jsonl | tail -1 | diff - data/expected-summary.txt && echo replay-ok' },
    },
  ],
  failure_modes: [
    { symptom: '`no DevTools endpoint at http://127.0.0.1:9222`', cause: 'Chrome was started without remote debugging, or another profile holds the port', response: 'Redo step 2 with a fresh user data folder' },
    { symptom: 'The summary counts 0 sockets', cause: 'The socket opened before the capture started', response: 'Reload the page while step 3 is running' },
  ],
  rollback: [
    { do: 'Stop the debugging Chrome that step 2 started.', command: { lang: 'bash', text: 'kill "$CHROME_PID"' } },
  ],
  notes: 'Frames print cut to 120 characters; the raw capture keeps them whole. Captures can hold session tokens: the bundled sample redacts its auth frame, and a capture you keep or share should too.',
};

export const presenceClientDoc: RunbookDoc = {
  title: "Call the gateway's presence API with the captured client",
  summary: "Read who is online in a realtime channel through the small client captured from the portal's traffic, because the API has no published docs.",
  use_when: [
    'You need a channel\'s presence (who is online or idle) from a script or a check',
    'A presence bug needs the roster the gateway reports, not what the portal renders',
  ],
  not_for: [
    'Changing presence (the API is read-only)',
    'Chat history (read the conversation API)',
  ],
  triggers: {
    work_item_labels: ['realtime', 'presence'], repos: [], tools: ['gateway'],
    keywords: ['presence', 'online', 'roster', 'gateway', 'channel', 'client'],
  },
  preconditions: [
    'Node 22 or later is on the PATH.',
    'You hold a signed-in cookie jar for the user whose view you need (`$COOKIE_JAR`) and the BFF address (`$BFF`).',
  ],
  steps: [
    {
      do: "Open this skill's folder so the bundled client and its recorded response resolve.",
      command: { lang: 'bash', text: 'cd ~/.claude/skills/rb-gateway-presence-client' },
      expect: '`ls` to list `scripts` and `data`.',
    },
    {
      do: 'Fetch a realtime token for that user so the client can call the gateway.',
      command: { lang: 'bash', text: 'export GATEWAY_TOKEN=$(curl -s -b "$COOKIE_JAR" "$BFF/api/session/realtime-token" | jq -r .token)' },
      expect: '`echo ${#GATEWAY_TOKEN}` to print a length over 100; the token lasts ten minutes.',
    },
    {
      do: "Read the channel's presence with the client.",
      command: { lang: 'bash', text: 'node scripts/presence-client.mjs snapshot social:general --base "$BFF"' },
      expect: 'a header line with the online and idle counts, then one line per member, sorted by name.',
    },
    {
      do: 'Use the client from your own script when a check needs more than one presence call.',
      command: { lang: 'text', text: "import { PresenceClient } from './scripts/presence-client.mjs';\nconst client = new PresenceClient({ base: process.env.BFF, token: process.env.GATEWAY_TOKEN });\nconst snap = await client.snapshot('social:general');" },
      expect: '`snap.online` to be a list of `{ id, name, status, lastSeen }`.',
    },
  ],
  verify: [
    {
      check: 'Replay the recorded response through the client and compare the output.',
      command: { lang: 'bash', text: 'node scripts/presence-client.mjs snapshot social:general --fixture data/presence-snapshot.json | diff - data/expected-output.txt && echo client-ok' },
    },
  ],
  failure_modes: [
    { symptom: '`failed: 401` from the client', cause: 'The realtime token expired', response: 'Redo step 2' },
    { symptom: '`GATEWAY_TOKEN is not set`', cause: 'Step 2 ran in another shell', response: 'Redo step 2 in this shell' },
  ],
  rollback: [],
  notes: "The API's wire shape is undocumented and terse (short field names, epoch-millisecond times); the client normalises it. If the gateway changes it, record a new `data/presence-snapshot.json` from a real response and propose the updated client as an edit.",
};

/**
 * The one open proposal that carries files in the default world: a run found the
 * gateway now sends do-not-disturb, which the client counted as online, and
 * proposed the fixed client with a re-recorded fixture. Its files are real too
 * (mock/runbook-bundles/rb-gateway-presence-client@prop-presence-busy/), and its
 * Verify runs offline in the bundle test.
 */
export const PRESENCE_BUSY_PROPOSAL = {
  id: 'prop-presence-busy',
  bundle: `${PRESENCE_RUNBOOK_ID}@prop-presence-busy`,
  run_ref: 'job-presence-dnd',
  dispatched_by: 'p-011',
  rationale: 'Eli Garcia sent a run to find out why Omar showed as online while he had do-not-disturb on. Since its October release the gateway sends `st: "dnd"`, and the client treated any state it did not know as online. This maps do-not-disturb to busy, lists busy members on their own line, and re-records the fixture with one of them.',
  doc: {
    ...presenceClientDoc,
    steps: presenceClientDoc.steps.map((st, i) => (i === 2
      ? { ...st, expect: 'a header line with the online, idle and busy counts, then one line per member, sorted by name.' }
      : st)),
    failure_modes: [
      ...presenceClientDoc.failure_modes,
      { symptom: 'Someone on do-not-disturb is listed as online', cause: 'An older copy of the client that predates the dnd state', response: 'Sync the skill library and rerun step 3' },
    ],
  } as RunbookDoc,
} as const;

export function bundleFiles(id: string): RunbookFile[] {
  const raw = BUNDLE_FILES[id];
  if (!raw) throw new Error(`no packed bundle for ${id}`);
  return filesOf(raw);
}

export const SEEDED_BUNDLES: ReadonlyArray<{ id: string; doc: RunbookDoc }> = [
  { id: CDP_RUNBOOK_ID, doc: cdpWebsocketDoc },
  { id: PRESENCE_RUNBOOK_ID, doc: presenceClientDoc },
  // Established procedures with their helpers (runbook-bundles-established.ts).
  { id: JOURNEY_WALK_RUNBOOK_ID, doc: journeyWalkDoc },
  { id: LIBRARY_RELEASE_RUNBOOK_ID, doc: libraryReleaseDoc },
];
