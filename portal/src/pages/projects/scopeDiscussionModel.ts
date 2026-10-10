// The orgiq initiative / work-item discussion (gateway families
// `orgiq:initiative:<id>` and `orgiq:work:<id>`, middleware lib/tenant-channels.ts:
// read = any orgiq session, content publish = DispatchAgentRun).

import { scopePresenceChannel } from './scopePresenceModel.ts';

/** The discussion thread shares the channel the header presence joins. */
export const scopeDiscussionChannel = scopePresenceChannel;
