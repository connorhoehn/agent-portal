// Row I4.2 (privacy): the candidate's socket reads the lead's name on the pad and
// nobody else's. The awareness bytes are made and read by y-protocols itself,
// the codec the pad's clients run, so the rewrite is checked on the real format.
jest.mock('../../../../config.js', () => ({
  config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true } },
}));

import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import { PANEL_CARET_NAME, padFrameForGuest, renameAwareness } from '../guest-view.js';

const CHANNEL = 'doc:ivpad:iv-live';
const LEAD = 'lead-user';
const PANEL = 'panel-user';
const guestCtx = { userId: 'guest:abc', role: 'guest' };
const leadCtx = { userId: LEAD, displayName: 'Lead Person' };
const panelCtx = { userId: PANEL, displayName: 'Panel Person' };

function caret(name: string): { update: string; clientID: number } {
  const doc = new Y.Doc();
  const a = new Awareness(doc);
  a.setLocalStateField('user', { name, color: '#123456' });
  a.setLocalStateField('cursor', { anchor: 3 });
  return { update: Buffer.from(encodeAwarenessUpdate(a, [doc.clientID])).toString('base64'), clientID: doc.clientID };
}
function namesIn(update: string): Array<{ name?: string; cursor?: unknown }> {
  const a = new Awareness(new Y.Doc());
  applyAwarenessUpdate(a, Buffer.from(update, 'base64'), 'test');
  return [...a.getStates().values()].filter((s) => s.user).map((s) => ({ name: s.user.name, cursor: s.cursor }));
}

const senders: Record<string, Record<string, unknown>> = { 'c-lead': leadCtx, 'c-panel': panelCtx, 'c-guest': guestCtx };
const deps = { senderContext: (id: string) => senders[id] ?? null, leadOf: async () => LEAD };

function awarenessFrame() {
  return {
    type: 'crdt:awareness', channel: CHANNEL,
    updates: [
      { clientId: 'c-lead', update: caret('Lead Person').update },
      { clientId: 'c-panel', update: caret('Panel Person').update },
      { clientId: 'c-guest', update: caret('Candidate').update },
      { clientId: 'c-gone', update: caret('Someone Gone').update },
    ],
  };
}

describe('the pad as the candidate reads it', () => {
  it('a guest reads the lead\'s name and "Interviewer" for the panel; the cursor survives', async () => {
    const out = await padFrameForGuest(guestCtx, awarenessFrame(), deps) as { updates: Array<{ update: string }> };
    const names = out.updates.map((u) => namesIn(u.update)[0]);
    expect(names.map((n) => n?.name)).toEqual(['Lead Person', PANEL_CARET_NAME, 'Candidate', PANEL_CARET_NAME]);
    expect(names[1]?.cursor).toEqual({ anchor: 3 });
    expect(JSON.stringify(out)).not.toMatch(/Panel Person|Someone Gone/);
  });

  it('staff recipients get the frame unchanged', async () => {
    const frame = awarenessFrame();
    expect(await padFrameForGuest(panelCtx, frame, deps)).toBe(frame);
    expect(await padFrameForGuest(leadCtx, frame, deps)).toBe(frame);
  });

  it('a frame for another document passes untouched; an unreadable pad update is dropped', async () => {
    const other = { ...awarenessFrame(), channel: 'doc:someone-elses-doc' };
    expect(await padFrameForGuest(guestCtx, other, deps)).toBe(other);
    const broken = { type: 'crdt:awareness', channel: CHANNEL, updates: [{ clientId: 'c-panel', update: Buffer.from([5, 1]).toString('base64') }] };
    expect(await padFrameForGuest(guestCtx, broken, deps)).toBeNull();
  });

  it('presence on the pad keeps only the lead and guests for a guest', async () => {
    const frame = {
      type: 'documents:presence',
      documents: [
        { documentId: CHANNEL, users: [{ userId: LEAD, displayName: 'Lead Person' }, { userId: PANEL, displayName: 'Panel Person' }, { userId: 'guest:abc', displayName: 'Candidate' }] },
        { documentId: 'doc:other', users: [{ userId: PANEL, displayName: 'Panel Person' }] },
      ],
    };
    const out = await padFrameForGuest(guestCtx, frame, deps) as { documents: Array<{ users: Array<{ userId: string }> }> };
    expect(out.documents[0]!.users.map((u) => u.userId)).toEqual([LEAD, 'guest:abc']);
    expect(out.documents[1]).toBe(frame.documents[1]);
    expect(await padFrameForGuest(panelCtx, frame, deps)).toBe(frame);
  });

  it('the answer to a presence request is narrowed the same way', async () => {
    const frame = { type: 'crdt', action: 'documentPresence', presence: {
      [CHANNEL]: [{ userId: LEAD }, { userId: PANEL }, { userId: 'guest:abc' }],
      'doc:other': [{ userId: PANEL }],
    } };
    const out = await padFrameForGuest(guestCtx, frame, deps) as { presence: Record<string, Array<{ userId: string }>> };
    expect(out.presence[CHANNEL]!.map((u) => u.userId)).toEqual([LEAD, 'guest:abc']);
    expect(out.presence['doc:other']).toEqual([{ userId: PANEL }]);
  });

  it('a departure (null state) is carried through as it is', () => {
    const doc = new Y.Doc();
    const a = new Awareness(doc);
    a.setLocalState(null);
    const bye = Buffer.from(encodeAwarenessUpdate(a, [doc.clientID])).toString('base64');
    expect(renameAwareness(bye, PANEL_CARET_NAME)).toBe(bye);
  });
});
