// DM references store only allowlisted resource identity. Titles and routes
// are resolved on read under the recipient's current resource authority.
import { defineFeature, type RealtimeFeature } from '@connorhoehn/realtime-modules/server';
import { AppError, ValidationError } from './async-handler.js';
import { canonicalCallPage, type CallPageDescriptor } from './call-pages.js';
import { currentLiveSession, currentSocialMembershipProof, getLivePrincipal } from './live-principal.js';
import { currentSocialActionSession } from './social-authority.js';
import { dmChannelFor, dmMembers, socialChat } from './social-chat.js';
import type { Session } from './session.js';
import { recordUserId } from './record-owner.js';

export function dmPageDescriptor(value: unknown): CallPageDescriptor | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !['kind', 'id'].includes(key))
    || !['initiative', 'work-item'].includes(String(row.kind))
    || typeof row.id !== 'string' || !/^[a-zA-Z0-9:_-]{1,256}$/.test(row.id)) return null;
  return { kind: row.kind as CallPageDescriptor['kind'], id: row.id };
}
function orgAccess(session: Session): boolean {
  // Initiative/work reads are tenant-open. An explicit current OrgIQ grant
  // is required when resolving through Social without switching workspace.
  return (session.grants.orgiq?.length ?? 0) > 0;
}
export function directMessageMembers(channel: string): string[] {
  const members = dmMembers(channel);
  if (!members || members.length !== 2 || new Set(members).size !== 2
    || dmChannelFor(members) !== channel || channel.length > 256) throw new ValidationError('Name a canonical two-person Social direct message');
  return members;
}
async function membership(channel: string, session: Session) {
  // A clone is in its own copies of its persona's DMs (lib/clone-dms.ts), and still in the persona's.
  const members = directMessageMembers(channel);
  const self = members.includes(session.sub) ? session.sub : recordUserId(session.sub);
  if (!directMessageMembers(channel).includes(self)) throw new AppError(403, 'Not a member of this direct message');
  const proof = await currentSocialMembershipProof(channel, self);
  if (!proof.allows()) { proof.dispose(); throw new AppError(403, 'Not a member of this direct message'); }
  return proof;
}

/** Compose around the public chat service; preserve its storage, ack and lifecycle. */
export function withDmPageReferences(feature: RealtimeFeature): RealtimeFeature {
  return defineFeature({ ...feature, create(context) {
    const service = feature.create(context);
    const handle = service.handleAction.bind(service);
    service.handleAction = async (clientId, action, data) => {
      const metadata = data.metadata;
      const row = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata as Record<string, unknown> : null;
      // Other namespaces retain the chat service's admission rules, including
      // the protected huddle channel denial before any reference processing.
      if (typeof data.channel !== 'string' || !data.channel.startsWith('social:dm:')
        || !['send', 'edit'].includes(action) || !row || !Object.hasOwn(row, 'pageReference')) return handle(clientId, action, data);
      const captured = context.router.getClientData?.(clientId)?.userContext;
      let proof: Awaited<ReturnType<typeof membership>> | null = null;
      try {
        const page = dmPageDescriptor(row.pageReference);
        if (!page) throw new ValidationError('A page reference contains only initiative/work-item kind and id');
        const principal = await getLivePrincipal(captured ?? null);
        let session = await currentSocialActionSession(principal.session, 'PostMessage');
        proof = await membership(data.channel, session);
        if (!orgAccess(session)) throw new AppError(403, 'OrgIQ access is required to attach this page');
        await canonicalCallPage(page);
        session = await currentSocialActionSession(session, 'PostMessage');
        if (!orgAccess(session) || !proof.allows()) throw new AppError(403, 'Page or conversation access changed');
        if (!context.router.isClientLive?.(clientId)
          || context.router.getClientData?.(clientId)?.userContext !== captured) return;
        // Nothing resource-derived crosses into chat metadata. The built-in
        // service rechecks publish authority and membership before persistence.
        await handle(clientId, action, { ...data, metadata: { ...row, pageReference: page } });
      } catch (error) {
        if (context.router.getClientData?.(clientId)?.userContext !== captured) return;
        const status = error instanceof AppError ? error.status : 503;
        const message = error instanceof AppError ? error.message : 'Page reference verification is unavailable';
        context.router.sendToClient(clientId, { type: 'error', service: 'chat', action, channel: data.channel,
          code: 'DM_PAGE_REFERENCE_DENIED', error: { code: 'DM_PAGE_REFERENCE_DENIED', message }, status });
      } finally { proof?.dispose(); }
    };
    return service;
  } });
}

export async function resolveDmPageReference(channel: string, messageId: string, source: Session) {
  let session = await currentSocialActionSession(source, 'ViewSocial');
  const proof = await membership(channel, session);
  try {
    const chat = socialChat();
    if (!chat.chatStore.getMessage) throw new AppError(503, 'Message lookup is unavailable');
    const message = await chat.chatStore.getMessage(channel, messageId);
    const member = await chat.membershipStore.getMember(channel, session.sub);
    const floor = member?.historyFrom ? Date.parse(member.historyFrom) : null;
    if (!message || message.deletedAt || message.metadata?.['deleted'] === true
      || (floor !== null && (!Number.isFinite(floor) || !Number.isFinite(Date.parse(message.timestamp)) || Date.parse(message.timestamp) <= floor))) {
      throw new AppError(404, 'Message reference is unavailable');
    }
    const page = dmPageDescriptor(message.metadata?.['pageReference']);
    if (!page) throw new AppError(404, 'Message has no supported page reference');
    let reference: Record<string, unknown> = { ...page, status: 'unavailable' };
    session = await currentLiveSession(session);
    if (orgAccess(session)) {
      try { reference = { ...await canonicalCallPage(page), status: 'available' }; }
      catch (error) { if (!(error instanceof AppError) || ![403, 404].includes(error.status)) throw error; }
    }
    // Directory, policy and message lookup can all outlive a revocation.
    session = await currentSocialActionSession(session, 'ViewSocial');
    if (!proof.allows()) throw new AppError(403, 'Direct message access changed');
    if (!orgAccess(session)) reference = { ...page, status: 'unavailable' };
    const latest = await chat.chatStore.getMessage(channel, messageId);
    const latestPage = dmPageDescriptor(latest?.metadata?.['pageReference']);
    if (!latest || latest.deletedAt || latest.metadata?.['deleted'] === true
      || latestPage?.kind !== page.kind || latestPage.id !== page.id || latest.timestamp !== message.timestamp) {
      throw new AppError(404, 'Message reference changed or is unavailable');
    }
    session = await currentSocialActionSession(session, 'ViewSocial');
    if (!proof.allows()) throw new AppError(403, 'Direct message access changed');
    if (!orgAccess(session)) reference = { ...page, status: 'unavailable' };
    return { channel, messageId, pageReference: reference };
  } finally { proof.dispose(); }
}
