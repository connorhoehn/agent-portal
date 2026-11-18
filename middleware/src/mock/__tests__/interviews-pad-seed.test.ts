// The live round's pad opens with its code (E4 finding 44): the mock world's snapshot store holds it.
import { gunzipSync } from 'node:zlib';
import * as Y from 'yjs';
import { padChannel } from '../../lib/interviews/pad/channel.js';
import { LIVE_INTERVIEW_ID } from '../interviews.js';
import { K_FIXED } from '../interviews-pad-log.js';
import { seededPadSnapshots } from '../interviews-pad-seed.js';
import { interviewRunsFixture } from '../interviews-runs.js';

describe('the live round\'s pad', () => {
  it('opens on the pad log\'s last snapshot, in Python, and the last run ran that code', async () => {
    const hit = await seededPadSnapshots().getLatestSnapshot(padChannel(LIVE_INTERVIEW_ID)!);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, new Uint8Array(gunzipSync(hit!.bytes)));
    expect(doc.getText('code').toString()).toBe(K_FIXED);
    expect(doc.getMap('pad').get('language')).toBe('python');
    const runs = interviewRunsFixture.rows('default').filter((r) => r.interviewId === LIVE_INTERVIEW_ID);
    expect(runs.at(-1)!.source[0]!.content.startsWith(K_FIXED)).toBe(true);
  });

  it('no other pad is seeded', async () => {
    expect(await seededPadSnapshots().getLatestSnapshot(padChannel('iv-k1p5w8ra')!)).toBeNull();
  });
});
