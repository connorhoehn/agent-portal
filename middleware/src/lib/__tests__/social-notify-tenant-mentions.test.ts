// Mentions in orgiq / pipelines / assessment discussion channels: notified only
// when the mentioned user can read the channel NOW, never the sender, deduped,
// tenant-scoped, with a link that opens the exact discussion.
jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', aurora: {}, auth: {}, mock: { aurora: true } },
}));

// The real Cedar seeds, parsed the way role-registry.ts does (its module-scope
// import.meta.url cannot load under ts-jest's CommonJS transform).
jest.mock('../role-registry.js', () => {
  const fs = jest.requireActual('node:fs') as typeof import('node:fs');
  const path = jest.requireActual('node:path') as typeof import('node:path');
  const permitted = (cedar: string): string[] => {
    const acts = new Set<string>();
    for (const block of cedar.replace(/\/\/[^\n]*/g, '').split(/\bpermit\b/).slice(1)) {
      const stmt = block.split(';')[0] ?? '';
      if (/,\s*action\s*,/.test(stmt)) return ['*'];
      for (const m of stmt.matchAll(/OrgIQ::Action::"([^"]+)"/g)) acts.add(m[1]!);
    }
    return [...acts];
  };
  return {
    roleRegistry: () => {
      const dir = path.join(process.cwd(), 'seeds', 'roles');
      const out: Array<{ id: string; tenant: string | null; label: string; summary: string; capabilities: string[] }> = [];
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isFile() && e.name.endsWith('.cedar')) out.push({ id: e.name.slice(0, -6), tenant: null, label: '', summary: '', capabilities: permitted(fs.readFileSync(path.join(dir, e.name), 'utf8')) });
        else if (e.isDirectory()) for (const f of fs.readdirSync(path.join(dir, e.name))) if (f.endsWith('.cedar')) out.push({ id: f.slice(0, -6), tenant: e.name, label: '', summary: '', capabilities: permitted(fs.readFileSync(path.join(dir, e.name, f), 'utf8')) });
      }
      return out;
    },
  };
});


const rows: { current: Array<{ userId: string; removedAt: string | null }> } = { current: [] };
jest.mock('../social-chat.js', () => ({
  socialChat: () => ({ ready: Promise.resolve(), membershipStore: { listMembers: async () => rows.current } }),
}));

import { notifyTenantChannelMention, setNotificationSink, type NotificationInputLike } from '../social-notify.js';
import { notifyChannelMessage } from '../realtime-gateway.js';
import { tenantMentionNotifyPlugin } from '../gateway/notify-plugins.js';
import * as identity from '../../providers/identity.js';

type Sent = { userId: string; input: NotificationInputLike };
let sent: Sent[];
beforeEach(() => {
  rows.current = [];
  sent = [];
  setNotificationSink({ notifyUser: async (userId, input) => { sent.push({ userId, input }); return {}; } });
});
afterEach(() => { setNotificationSink(null); jest.restoreAllMocks(); });
const ids = () => sent.map((s) => s.userId).sort();

describe('tenant discussion mentions', () => {
  it('notifies a mentioned reader of an initiative discussion with the exact link', async () => {
    await notifyTenantChannelMention({ channel: 'orgiq:initiative:p-zero-trust', sender: 'u-theo', text: 'ping @Vera Green and @Vera Green' });
    expect(ids()).toEqual(['u-vera']);
    expect(sent[0]!.input).toMatchObject({ type: 'mention', payload: { tenant: 'orgiq', kind: 'mention', category: 'OrgIQ', channel: 'orgiq:initiative:p-zero-trust' }, action: { href: '/iq/projects/p-zero-trust' } });
  });

  it('links a work item discussion to its initiative, item and Discussion tab', async () => {
    await notifyTenantChannelMention({ channel: 'orgiq:work:wi-zt-e1-s1', sender: 'u-theo', text: '@Vera Green look' });
    expect(sent[0]!.input.action?.href).toBe('/iq/projects/p-zero-trust?tab=work&item=wi-zt-e1-s1&view=comments');
  });

  it('links pipeline run and definition discussions and an assessment document chat', async () => {
    await notifyTenantChannelMention({ channel: 'pipelines:run:r-1', sender: 'u-ines', text: '@Kofi Mensah' });
    await notifyTenantChannelMention({ channel: 'pipelines:def:d-1', sender: 'u-ines', text: '@Kofi Mensah' });
    await notifyTenantChannelMention({ channel: 'assessment:doc:page:100002', sender: 'u-asha', text: '@Jonas Lindqvist' });
    expect(sent.map((s) => s.input.action?.href)).toEqual([
      '/pipelines/runs/r-1', '/pipelines/definitions?open=d-1', '/assessment/workspace?doc=page%3A100002',
    ]);
    expect(sent.map((s) => s.input.payload?.['tenant'])).toEqual(['pipelines', 'pipelines', 'assessment']);
  });

  it('never notifies the sender', async () => {
    await notifyTenantChannelMention({ channel: 'orgiq:initiative:p-zero-trust', sender: 'u-vera', text: '@Vera Green' });
    expect(sent).toEqual([]);
  });

  it('never notifies someone who cannot read the channel now (closed conversation rows)', async () => {
    rows.current = [{ userId: 'u-theo', removedAt: null }];
    await notifyTenantChannelMention({ channel: 'orgiq:initiative:p-zero-trust', sender: 'u-theo', text: '@Vera Green' });
    expect(sent).toEqual([]);
  });

  it('never notifies across tenants (no grant in the channel tenant)', async () => {
    await notifyTenantChannelMention({ channel: 'pipelines:run:r-1', sender: 'u-ines', text: '@Helen Desai @Vera Green' });
    await notifyTenantChannelMention({ channel: 'assessment:doc:x', sender: 'u-asha', text: '@Helen Desai' });
    expect(sent).toEqual([]);
  });

  it('ignores Social channels and unknown families', async () => {
    await notifyTenantChannelMention({ channel: 'social:ch:general', sender: 'u-mira', text: '@Sana Iqbal' });
    await notifyTenantChannelMention({ channel: 'orgiq:deck:d1', sender: 'u-theo', text: '@Vera Green' });
    expect(sent).toEqual([]);
  });
});

// Exercise the gateway dispatch, rather than only the helper: Assessment team
// chat was supported by the helper/read gate but dropped by the plugin's filter.
describe('Assessment team mention dispatch', () => {
  const channel = 'assessment:team:TEAM-005';
  const plugin = tenantMentionNotifyPlugin(() => null);
  const publish = (text: string, target = channel, stampedSender = 'u-asha') => plugin.onMessage({
    clientId: 'fixture-publisher', userId: 'u-asha', channelId: target,
    message: { type: 'chat', action: 'message', message: {
      userId: stampedSender, message: text, metadata: { displayName: 'Asha Nair' },
    } },
  });

  it('delivers one mention to the current reader and opens the exact team discussion', async () => {
    await publish('@Jonas Lindqvist please review. @Jonas Lindqvist @Asha Nair @Vera Green');
    expect(ids()).toEqual(['u-jonas']);
    expect(sent[0]!.input).toMatchObject({ type: 'mention', channel,
      payload: { tenant: 'assessment', kind: 'mention', channel, actorId: 'u-asha' },
      action: { label: 'Open the team discussion', href: '/assessment/teams/TEAM-005?tab=discussion' },
    });
  });

  it('does not notify a removed or unlisted reader when the conversation has explicit membership', async () => {
    rows.current = [
      { userId: 'u-asha', removedAt: null },
      { userId: 'u-jonas', removedAt: '2026-10-09T00:00:00Z' },
    ];
    await publish('@Jonas Lindqvist @Farah Osei');
    expect(sent).toEqual([]);
  });

  it('rechecks a recipient grant instead of trusting the mention directory', async () => {
    const realGetUser = identity.getUser;
    jest.spyOn(identity, 'getUser').mockImplementation(async (id, options) => {
      const user = await realGetUser(id, options);
      return user && id === 'u-jonas' ? { ...user, grants: { ...user.grants, assessment: [] } } : user;
    });
    await publish('@Jonas Lindqvist');
    expect(sent).toEqual([]);
  });

  it('does not notify for a missing team or a forged sender frame', async () => {
    await publish('@Jonas Lindqvist', 'assessment:team:TEAM-NOT-FOUND');
    await publish('@Jonas Lindqvist', channel, 'u-jonas');
    expect(sent).toEqual([]);
  });
});

describe('Social is unchanged', () => {
  it('a Social channel mention still notifies a member with the channel link', async () => {
    await notifyChannelMessage({ channel: 'social:ch:general', slug: 'general', sender: 'u-mira', name: 'Mira Okafor', text: '@Sana Iqbal hi', audience: ['u-sana'], live: null });
    expect(sent[0]!.input).toMatchObject({ type: 'mention', action: { href: '/social/channels/general' } });
  });
});
