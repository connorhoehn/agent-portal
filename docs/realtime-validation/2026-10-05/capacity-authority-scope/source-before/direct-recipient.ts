// User-addressed frames do not pass through a channel subscription. Keep
// stored inbox data intact and recheck each socket before it receives data.
import type { ClientMessageFilter } from '@connorhoehnslalom/realtime-modules/server';
import { isAllowed } from './authz.js';
import { authorizeLiveGatewayCallRecipient, currentSocialMembershipProof, getLivePrincipal, type LiveCallGuards, type SocialMembershipProof } from './live-principal.js';
import { hrefInsideTenant } from './social-notify.js';

const object = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
function notificationHref(tenant: string, href: unknown): boolean {
  if (href === undefined) return true;
  if (typeof href !== 'string' || /[\x00-\x20\\]/.test(href) || !hrefInsideTenant(tenant, href)) return false;
  try { return hrefInsideTenant(tenant, new URL(href, 'https://notification.invalid').pathname); }
  catch { return false; }
}
export function directRecipientFilter(guards: LiveCallGuards, protectedFrames?: ClientMessageFilter): ClientMessageFilter {
  return ({ clientId, message, ctx }) => {
    const frame = object(message);
    if (frame && (frame.type === 'call-page' || frame.type === 'call-chat' || (frame.type === 'chat' && typeof frame.callId === 'string'))) {
      return protectedFrames ? protectedFrames({ clientId, message, ctx }) : message;
    }
    // Other services own their read/recipient fences. Keep their synchronous
    // send boundary rather than adding an unnecessary awaited filter.
    if (!frame || !['call', 'notification:new', 'notification:bulk-update', 'notification:read'].includes(frame.type as string)) return message;
    return (async () => {
      if (frame.type === 'call') {
        const data = object(frame.data);
        if (!data) return null;
        // This is a receipt for the requesting user, after its indexes have
        // been forgotten; there may no longer be a call to resolve.
        if (frame.action === 'forgotten') {
          try { await getLivePrincipal(ctx); return message; } catch { return null; }
        }
        return await authorizeLiveGatewayCallRecipient(ctx, data, guards) ? message : null;
      }
      if (frame.type !== 'notification:new' && frame.type !== 'notification:bulk-update' && frame.type !== 'notification:read') return message;
      const proofs = new Map<string, SocialMembershipProof>();
      try {
        const principal = await getLivePrincipal(ctx);
        if (frame.type === 'notification:read') return message;
        const payload = object(frame.payload);
        if (!payload) return null;
        const bulk = frame.type === 'notification:bulk-update';
        const records: unknown[] = bulk ? Array.isArray(payload.notifications) ? payload.notifications : [] : [payload];
        const candidates: Array<{ record: Record<string, unknown>; tenant: string; role: string | null; channel: string | null }> = [];
        const roles = new Map<string, string | null>();
        for (const value of records) {
          const record = object(value), info = object(record?.payload), action = object(record?.action);
          const tenant = info?.tenant;
          if (!record || typeof tenant !== 'string' || !principal.session.grants[tenant]?.length
            || !notificationHref(tenant, action?.href)) continue;
          const origin = record.channel ?? info?.channel;
          if (record.channel !== undefined && info?.channel !== undefined && record.channel !== info.channel) continue;
          // Missed calls retain both their call lobby and an originating page.
          // Scope their contents to the lobby; old OrgIQ seeds use the page key.
          const raw = info?.kind === 'call-missed' && typeof info.lobbyName === 'string' ? info.lobbyName
            : tenant === 'orgiq' && typeof origin === 'string' && origin.startsWith('initiative:') ? `orgiq:${origin}` : origin;
          const channel = typeof raw === 'string' ? raw : null;
          if (raw !== undefined && (!channel || !channel.startsWith(`${tenant}:`))) continue;
          let role: string | null = null;
          const permission = tenant === 'social' ? 'ViewSocial' : tenant === 'orgiq' && info?.kind === 'approval' ? 'ApproveTransaction' : null;
          if (permission) {
            const key = `${tenant}:${permission}`;
            if (!roles.has(key)) {
              let allowedRole: string | null = null;
              for (const candidate of principal.session.grants[tenant] ?? []) {
                if (await isAllowed({ sub: principal.session.sub, tenant, role: candidate }, permission)) { allowedRole = candidate; break; }
              }
              roles.set(key, allowedRole);
            }
            role = roles.get(key) ?? null;
            if (!role) continue;
          }
          candidates.push({ record, tenant, role, channel });
        }
        // A full inbox can hold 200 records from one conversation. One fresh
        // resource proof covers that single reply; repeated records do not
        // each enqueue another durable membership read. Resolve after the
        // policy work, retain its pending-read fences, and discard on return.
        for (const channel of new Set(candidates.map(row => row.channel).filter((channel): channel is string => !!channel?.startsWith('social:')))) {
          proofs.set(channel, await currentSocialMembershipProof(channel, principal.session.sub));
        }
        // A cold peer has no synchronous resource mirror until the reads
        // above hydrate it. Apply the guard only now, with fresh identity and
        // every pending resource fence together at the send boundary.
        const latest = await getLivePrincipal(ctx);
        const allowed = candidates.filter(row => {
          const proof = row.channel ? proofs.get(row.channel) : null;
          return latest.session.grants[row.tenant]?.length
            && (!row.role || latest.session.grants[row.tenant]?.includes(row.role))
            && (!row.channel || guards.guard(latest.auth, row.channel)) && (!proof || proof.allows());
        }).map(row => row.record);
        return bulk ? { ...frame, payload: { ...payload, notifications: allowed } } : allowed.length ? message : null;
      } catch { return null; }
      finally { proofs.forEach(proof => proof.dispose()); }
    })();
  };
}
