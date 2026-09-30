// lib/social-notify.ts — the activity indicator's producer seam
// (docs/social-tenant-design.md §3.4), against the identity fallback
// (MOCK_AURORA). Pinned:
//   - the grant rule: an item reaches only users holding a grant in
//     payload.tenant — u-hr (orgiq hr-admin only) gets nothing from a social
//     or an assessment item, u-jonas gets the assessment one;
//   - every delivered item carries payload.tenant and the tenant's label as
//     payload.category; an href outside the tenant refuses the item;
//   - no sink (gateway off) is a no-op, a throwing sink never throws out;
//   - @mentions resolve against the tenant roster only, longest name first;
//   - the comment producer: reply → parent author, root → other commenters,
//     mention wins over both, never the author;
//   - the approval producer reaches exactly the roles whose Cedar permits
//     ApproveTransaction (org-leader, admin), not the ones that forbid it.

jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', aurora: {}, mock: { aurora: true } },
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

import {
  assessmentDocumentHref, hrefInsideTenant, notify, notifyApprovalRequested, notifyDocumentComment,
  parseDmLobby, resolveMentions, setNotificationSink, tenantLabel, usersHoldingAction,
  type NotificationInputLike,
} from '../social-notify.js';

type Sent = { userId: string; input: NotificationInputLike };
let sent: Sent[];

beforeEach(() => {
  sent = [];
  setNotificationSink({ notifyUser: async (userId, input) => { sent.push({ userId, input }); return {}; } });
});
afterEach(() => setNotificationSink(null));

const recipients = () => sent.map((s) => s.userId).sort();

describe('the grant rule', () => {
  it('delivers a social item to nobody without a social grant — u-hr included', async () => {
    const out = await notify(['u-hr'], {
      type: 'message', title: 'Sana Iqbal sent you a message',
      payload: { tenant: 'social' }, action: { label: 'Open', href: '/social/dms/social%3Adm%3Au-hr%3Au-sana' },
    });
    expect(out).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('delivers the same social item to a social grant holder (the control)', async () => {
    const out = await notify(['u-hr', 'u-sana'], {
      type: 'message', title: 'Mira Okafor sent you a message',
      payload: { tenant: 'social' }, action: { label: 'Open', href: '/social/dms/social%3Adm%3Au-mira%3Au-sana' },
    });
    expect(out).toEqual(['u-sana']);
    expect(sent[0]!.input.payload).toMatchObject({ tenant: 'social', category: 'Social' });
  });

  it('delivers an assessment item to the assessment grant holder and refuses u-hr, who holds none', async () => {
    const out = await notify(['u-jonas', 'u-hr', 'u-jonas'], {
      type: 'reply', title: 'Farah Osei replied to your comment',
      payload: { tenant: 'assessment' }, action: { label: 'Open', href: assessmentDocumentHref('page:100002') },
    });
    expect(out).toEqual(['u-jonas']);
    expect(recipients()).toEqual(['u-jonas']);
    expect(sent[0]!.input.payload).toMatchObject({ tenant: 'assessment', category: 'Assessment' });
  });

  it('refuses an unknown user and the cookie-less demo identity', async () => {
    await notify(['demo-user', 'u-nobody'], { type: 'system', title: 't', payload: { tenant: 'orgiq' } });
    expect(sent).toEqual([]);
  });
});

describe('tenant-scoped hrefs', () => {
  it.each([
    ['assessment', '/assessment/workspace?doc=x', true],
    ['assessment', '/iq/projects', false],
    ['orgiq', '/iq/projects/p-auth-migration', true],
    ['orgiq', '/admin/observability/approvals', true],
    ['social', '/social/dms/x', true],
    ['social', '/iq/projects', false],
    ['orgiq', '//evil.example/iq/', false],
    ['orgiq', 'https://evil.example', false],
    ['unknown', '/unknown/x', false],
  ])('%s %s → %s', (tenant, href, ok) => expect(hrefInsideTenant(tenant, href)).toBe(ok));

  it('refuses an item whose href leaves its tenant', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await notify(['u-jonas'], { type: 'reply', title: 't', payload: { tenant: 'assessment' }, action: { label: 'x', href: '/iq/projects' } });
    expect(sent).toEqual([]);
    warn.mockRestore();
  });

  it('labels tenants', () => {
    expect(tenantLabel('orgiq')).toBe('OrgIQ');
    expect(tenantLabel('social')).toBe('Social');
  });
});

describe('never throws', () => {
  it('is a no-op with no gateway', async () => {
    setNotificationSink(null);
    await expect(notify(['u-jonas'], { type: 'reply', title: 't', payload: { tenant: 'assessment' } })).resolves.toEqual([]);
  });

  it('swallows a failing delivery', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    setNotificationSink({ notifyUser: async () => { throw new Error('socket gone'); } });
    await expect(notify(['u-jonas'], { type: 'reply', title: 't', payload: { tenant: 'assessment' } })).resolves.toEqual(['u-jonas']);
    warn.mockRestore();
  });
});

describe('mentions', () => {
  it('resolves display names on the tenant roster only', async () => {
    expect(await resolveMentions('cc @Jonas Lindqvist and @farah osei.', 'assessment')).toEqual(expect.arrayContaining(['u-jonas', 'u-farah']));
    // Priya Desai (u-hr) is not on the assessment roster: an unresolved mention notifies nobody.
    expect(await resolveMentions('@Priya Desai please look', 'assessment')).toEqual([]);
    expect(await resolveMentions('@Somebody Else', 'assessment')).toEqual([]);
    expect(await resolveMentions('no mentions here', 'assessment')).toEqual([]);
    expect(await resolveMentions('@Jonas Lindqvistx', 'assessment')).toEqual([]);
  });
});

describe('the comment producer', () => {
  const base = { tenant: 'assessment', docId: 'page:100002', docTitle: 'Rubric Overview', href: assessmentDocumentHref('page:100002'), commentId: 'c1' };

  it('a reply reaches the parent author only, naming the document and the author', async () => {
    await notifyDocumentComment({ ...base, authorId: 'u-farah', authorName: 'Farah Osei', text: 'Good point', parentAuthorId: 'u-jonas', priorAuthorIds: ['u-jonas', 'u-asha', 'u-farah'] });
    expect(recipients()).toEqual(['u-jonas']);
    expect(sent[0]!.input).toMatchObject({
      type: 'reply', title: 'Farah Osei replied to your comment', body: expect.stringContaining('Rubric Overview'),
      action: { href: '/assessment/workspace?doc=page%3A100002&tab=comments' },
      payload: { tenant: 'assessment', category: 'Assessment', documentId: 'page:100002', actorId: 'u-farah' },
    });
  });

  it('a root comment reaches every other commenter, never the author', async () => {
    await notifyDocumentComment({ ...base, authorId: 'u-farah', text: 'New thread', parentAuthorId: null, priorAuthorIds: ['u-jonas', 'u-asha', 'u-farah', 'u-jonas'] });
    expect(recipients()).toEqual(['u-asha', 'u-jonas']);
    expect(sent[0]!.input.title).toBe('Farah Osei commented on Rubric Overview');
  });

  it('a mention wins over the reply for the same person — one item each', async () => {
    await notifyDocumentComment({ ...base, authorId: 'u-farah', text: '@Jonas Lindqvist and @Asha Nair — thoughts?', parentAuthorId: 'u-jonas', priorAuthorIds: ['u-jonas'] });
    expect(recipients()).toEqual(['u-asha', 'u-jonas']);
    expect(sent.every((s) => s.input.type === 'mention')).toBe(true);
  });

  it('a self-mention notifies nobody', async () => {
    await notifyDocumentComment({ ...base, authorId: 'u-farah', text: 'note to @Farah Osei', parentAuthorId: null, priorAuthorIds: ['u-farah'] });
    expect(sent).toEqual([]);
  });
});

describe('the approval producer', () => {
  it('reaches the roles Cedar permits ApproveTransaction, not the ones it forbids', async () => {
    const approvers = await usersHoldingAction('orgiq', 'ApproveTransaction');
    expect(approvers).toEqual(expect.arrayContaining(['u-vera', 'u-release', 'u-rachel', 'u-operator']));
    for (const no of ['u-theo', 'u-hr', 'u-mia', 'u-nora', 'u-jonas']) expect(approvers).not.toContain(no);
    await notifyApprovalRequested({ approvalId: 'a1', agentId: 'orgiq-advisor', txId: 'tx-1', reason: 'Vendor renewal', amount: 18500 });
    expect(recipients()).toEqual([...approvers].sort());
    expect(sent[0]!.input).toMatchObject({ type: 'approval-requested', action: { href: '/admin/observability/approvals' }, payload: { tenant: 'orgiq', category: 'OrgIQ' } });
  });
});

describe('DM lobby names', () => {
  it('parses <tenant>:dm:<ids>', () => {
    expect(parseDmLobby('social:dm:u-hr:u-sana')).toEqual({ tenant: 'social', members: ['u-hr', 'u-sana'] });
    expect(parseDmLobby('orgiq:initiative:p-1')).toBeNull();
    expect(parseDmLobby('dm:u-a:u-b')).toBeNull();
  });
});
