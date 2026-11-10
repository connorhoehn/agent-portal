// Which plane a conversation channel belongs to, and the guard every request
// builder for the conversation commands runs before it fetches.
//
// The same thread component draws a tenant conversation (`orgiq:initiative:<id>`,
// a run's, a document's, a huddle's) and, on an initiative bound to a channel,
// a Social channel (`social:ch:<slug>`). The command routes are mounted twice:
// Social's under /api/chat/commands, the tenant conversations' under
// /api/conversations. A Social channel sent to a tenant route is refused with a
// 400 on every poll (the second regression walk, 10 November), so the builders
// refuse it here, before any request leaves the page.
//
// Pure: no React, so node:test covers it.

export type ChannelPlane = 'social' | 'tenant';

/** `social:*` is Social's; every other conversation channel is a tenant conversation. */
export const channelPlane = (channel: string): ChannelPlane => (channel.startsWith('social:') ? 'social' : 'tenant');

/** Thrown by a tenant-conversation request builder handed a Social channel. */
export const SOCIAL_ON_TENANT_ROUTE = 'This is a Social channel. Its commands run on the Social routes, not the tenant conversation routes.';

/** A tenant-conversation route never receives a Social channel. */
export function assertTenantConversation(channel: string): void {
  if (channelPlane(channel) === 'social') throw new Error(SOCIAL_ON_TENANT_ROUTE);
}
