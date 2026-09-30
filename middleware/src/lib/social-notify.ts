// The header activity indicator's single producer seam
// (docs/social-tenant-design.md §3.4).
//
//   notify(userIds, input)  →  handle.services.notification.notifyUser(id, …)
//
// Every item is addressed to a USER, and belongs to a TENANT: `payload.tenant`
// names it, `payload.category` carries the tenant's label (the bell's category
// line), and `action.href` must be a portal path inside that tenant. The rule
// that keeps the shared header honest across products:
//
//   an item is delivered only to a user who holds a grant in payload.tenant
//
// read from the identity store (providers/identity.ts `getUser`, the same rows
// `mintSession` reads; the in-memory fallback under MOCK_AURORA), with the
// authoritative flag, so an identity outage delivers nothing rather than
// reviving a revoked grant. An href outside the item's tenant refuses the item.
//
// Never throws, and nothing awaits it on a request path that could get slower:
// no gateway (REALTIME_GATEWAY=off), no identity store, a failed delivery — all
// are a logged no-op. The gateway wires the sink at attach (lib/realtime-gateway.ts).
//
// The producers that live at a write path (design §3.4 rows 1–3 and 8) are the
// `notify*` helpers below; the socket producers (row 4, DMs; row 6, missed
// calls) live in the gateway, which is the only thing that sees those frames.

import { getUser, listUsers } from '../providers/identity.js';

/** What the library's `NotificationService.notifyUser` accepts (its `NotificationInput`). */
export interface NotificationInputLike {
  id?: string;
  type: string;
  title: string;
  body?: string;
  timestamp?: string;
  channel?: string;
  payload?: Record<string, unknown>;
  action?: { label: string; href?: string };
}

/** The slice of `NotificationService` this seam uses. */
export interface NotificationSink {
  notifyUser(userId: string, input: NotificationInputLike): Promise<unknown>;
}

/** An item this seam will send: the tenant is required, the rest is the library's input. */
export interface SocialNotifyInput extends Omit<NotificationInputLike, 'payload'> {
  payload: { tenant: string; [key: string]: unknown };
}

let sink: NotificationSink | null = null;

/** Wired by attachRealtimeGateway; `null` on dispose (and in tests). */
export function setNotificationSink(next: NotificationSink | null): void {
  sink = next;
}

export function notificationSinkActive(): boolean {
  return sink !== null;
}

/** The bell's category line — the tenant as the header names it. */
const TENANT_LABELS: Record<string, string> = {
  orgiq: 'OrgIQ',
  assessment: 'Assessment',
  social: 'Social',
  pipelines: 'Pipelines',
};

export function tenantLabel(tenant: string): string {
  return TENANT_LABELS[tenant] ?? (tenant ? tenant.charAt(0).toUpperCase() + tenant.slice(1) : 'Activity');
}

/**
 * The portal paths each tenant owns. orgiq owns `/admin/*` as well — the
 * platform pages an orgiq org-leader/hr-admin session reaches (the approval
 * queue lives at /admin/observability/approvals; the API behind it is
 * requireTenant('orgiq')).
 */
const TENANT_PATHS: Record<string, readonly string[]> = {
  orgiq: ['/iq/', '/admin/'],
  assessment: ['/assessment/'],
  social: ['/social/'],
  pipelines: ['/pipelines/'],
};

export function hrefInsideTenant(tenant: string, href: string | undefined): boolean {
  if (href === undefined) return true;
  const prefixes = TENANT_PATHS[tenant];
  if (!prefixes || !href.startsWith('/') || href.startsWith('//')) return false;
  return prefixes.some((p) => href.startsWith(p));
}

/** Does `userId` hold any role in `tenant`? False on any doubt. */
export async function holdsGrant(userId: string, tenant: string): Promise<boolean> {
  try {
    const user = await getUser(userId, { authoritative: true });
    return !!user && (user.grants[tenant]?.length ?? 0) > 0;
  } catch {
    return false;
  }
}

/** Fill in the category from the tenant, so every producer's item has the same shape. */
export function shapeNotification(input: SocialNotifyInput): NotificationInputLike {
  const tenant = input.payload.tenant;
  return { ...input, payload: { ...input.payload, tenant, category: tenantLabel(tenant) } };
}

/**
 * Send `input` to each of `userIds` that holds a grant in its tenant. Resolves
 * to the ids it was handed to (after the grant rule), never rejects.
 */
export async function notify(userIds: readonly string[], input: SocialNotifyInput): Promise<string[]> {
  try {
    const active = sink;
    if (!active) return [];
    const tenant = input?.payload?.tenant;
    if (typeof tenant !== 'string' || !tenant || !input.title) return [];
    if (!hrefInsideTenant(tenant, input.action?.href)) {
      console.warn(`[social-notify] refused a ${tenant} item whose href leaves the tenant: ${String(input.action?.href)}`);
      return [];
    }
    const shaped = shapeNotification(input);
    const unique = [...new Set(userIds.filter((u): u is string => typeof u === 'string' && !!u))];
    const allowed: string[] = [];
    for (const userId of unique) {
      if (!(await holdsGrant(userId, tenant))) continue;
      allowed.push(userId);
      try {
        await active.notifyUser(userId, shaped);
      } catch (err) {
        console.warn(`[social-notify] delivery to ${userId} failed: ${(err as Error).message}`);
      }
    }
    return allowed;
  } catch (err) {
    console.warn(`[social-notify] notify failed: ${(err as Error).message}`);
    return [];
  }
}

// ── Mentions ────────────────────────────────────────────────────────────────

/**
 * `@<display name>` in `text`, resolved against the users holding a grant in
 * `tenant`. A mention that names nobody on the roster notifies nobody; the
 * longest name wins where one is a prefix of another ("@Mia" vs "@Mia Singh").
 */
export async function resolveMentions(text: string, tenant: string): Promise<string[]> {
  if (!text.includes('@')) return [];
  let roster: Array<{ id: string; displayName: string }>;
  try {
    roster = (await listUsers()).filter((u) => (u.grants[tenant]?.length ?? 0) > 0);
  } catch {
    return [];
  }
  const lower = text.toLowerCase();
  const found = new Set<string>();
  const byLength = [...roster].sort((a, b) => b.displayName.length - a.displayName.length);
  const claimed: Array<[number, number]> = [];
  for (const user of byLength) {
    const needle = `@${user.displayName.toLowerCase()}`;
    for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, at + 1)) {
      const end = at + needle.length;
      const next = lower.charAt(end);
      if (next && /[\p{L}\p{N}_]/u.test(next)) continue;
      if (claimed.some(([s, e]) => at >= s && at < e)) continue;
      claimed.push([at, end]);
      found.add(user.id);
    }
  }
  return [...found];
}

// ── Producers at existing write paths ───────────────────────────────────────

function snippet(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

async function displayName(userId: string, fallback?: string): Promise<string> {
  if (fallback && fallback !== userId) return fallback;
  try {
    return (await getUser(userId))?.displayName ?? userId;
  } catch {
    return userId;
  }
}

/** Where an assessment document opens, with its Comments tab showing. */
export function assessmentDocumentHref(docId: string, tab: 'comments' | 'editor' = 'comments'): string {
  const mode = docId.startsWith('prompt:') ? 'prompts' : 'workspace';
  return `/assessment/${mode}?doc=${encodeURIComponent(docId)}${tab === 'comments' ? '&tab=comments' : ''}`;
}

export interface DocumentCommentEvent {
  tenant: string;
  docId: string;
  docTitle: string;
  href: string;
  commentId: string;
  authorId: string;
  authorName?: string;
  text: string;
  /** The parent comment's author when this is a reply. */
  parentAuthorId?: string | null;
  /** Every author of an earlier comment on the document (any order, may repeat). */
  priorAuthorIds: readonly string[];
}

/**
 * Rows 1–3 of design §3.4, for one new comment:
 *   - a reply → the parent's author (`reply`);
 *   - a top-level comment → every other commenter on the document (`reply`,
 *     "commented on");
 *   - `@<name>` in the text → the mentioned users (`mention`), which wins over
 *     the other two for the same person, so nobody gets two items for one comment.
 * Never the author.
 */
export async function notifyDocumentComment(ev: DocumentCommentEvent): Promise<void> {
  try {
    if (!sink) return;
    const author = await displayName(ev.authorId, ev.authorName);
    const mentioned = (await resolveMentions(ev.text, ev.tenant)).filter((u) => u !== ev.authorId);
    const payload = { tenant: ev.tenant, kind: 'comment', documentId: ev.docId, documentTitle: ev.docTitle, commentId: ev.commentId, actorId: ev.authorId, actorName: author };
    const action = { label: 'Open the comments', href: ev.href };
    const body = `On “${ev.docTitle}”: ${snippet(ev.text)}`;
    if (mentioned.length) {
      await notify(mentioned, { type: 'mention', title: `${author} mentioned you`, body, payload: { ...payload, kind: 'mention' }, action });
    }
    const skip = new Set([ev.authorId, ...mentioned]);
    if (ev.parentAuthorId) {
      if (!skip.has(ev.parentAuthorId)) {
        await notify([ev.parentAuthorId], { type: 'reply', title: `${author} replied to your comment`, body, payload: { ...payload, kind: 'reply' }, action });
      }
      return;
    }
    const others = [...new Set(ev.priorAuthorIds)].filter((u) => !skip.has(u));
    if (others.length) {
      await notify(others, { type: 'reply', title: `${author} commented on ${ev.docTitle}`, body, payload, action });
    }
  } catch (err) {
    console.warn(`[social-notify] comment producer failed: ${(err as Error).message}`);
  }
}

/** Every user whose role in `tenant` (or the cross-tenant admin role) permits `action`. */
export async function usersHoldingAction(tenant: string, action: string): Promise<string[]> {
  try {
    // Lazy, like authz.ts's seed matrix: role-registry reads import.meta.url at
    // module scope, which the CommonJS ts-jest transform cannot compile, and a
    // static import here would break every test that imports a producer route.
    const { roleRegistry } = await import('./role-registry.js');
    const roles = new Set(roleRegistry()
      .filter((r) => (r.tenant === tenant || r.tenant === null) && (r.capabilities.includes(action) || r.capabilities.includes('*')))
      .map((r) => r.id));
    return (await listUsers()).filter((u) => (u.grants[tenant] ?? []).some((r) => roles.has(r))).map((u) => u.id);
  } catch {
    return [];
  }
}

export interface ApprovalRequestEvent {
  approvalId: string;
  agentId: string;
  txId: string;
  reason: string | null;
  amount?: number | null;
}

/** Row 8: an agent asked for a human decision — every orgiq user who may give it. */
export async function notifyApprovalRequested(ev: ApprovalRequestEvent): Promise<void> {
  try {
    if (!sink) return;
    const approvers = await usersHoldingAction('orgiq', 'ApproveTransaction');
    if (!approvers.length) return;
    const amount = typeof ev.amount === 'number' && Number.isFinite(ev.amount) ? ` · $${ev.amount.toLocaleString('en-US')}` : '';
    await notify(approvers, {
      type: 'approval-requested',
      title: `${ev.agentId} is waiting on an approval`,
      body: `${ev.reason ? snippet(ev.reason) : `Transaction ${ev.txId}`}${amount}`,
      payload: { tenant: 'orgiq', kind: 'approval', approvalId: ev.approvalId, txId: ev.txId, agentId: ev.agentId },
      action: { label: 'Open the approval queue', href: '/admin/observability/approvals' },
    });
  } catch (err) {
    console.warn(`[social-notify] approval producer failed: ${(err as Error).message}`);
  }
}

// ── Lobby / channel names ───────────────────────────────────────────────────

/** `<tenant>:dm:<a>:<b>…` → { tenant, members }, or null for any other name. */
export function parseDmLobby(name: string): { tenant: string; members: string[] } | null {
  const m = /^([a-z][a-z0-9-]*):dm:(.+)$/.exec(name);
  if (!m) return null;
  const members = m[2]!.split(':').filter(Boolean);
  return members.length ? { tenant: m[1]!, members } : null;
}

/** Where a conversation in `tenant` opens. Social DMs have their own page; elsewhere, the tenant's home. */
export function conversationHref(tenant: string, lobby: string): string {
  if (tenant === 'social') return `/social/dms/${encodeURIComponent(lobby)}`;
  if (tenant === 'assessment') return '/assessment/teams';
  return '/iq/projects';
}
