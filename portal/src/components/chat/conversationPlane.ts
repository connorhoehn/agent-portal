// The command wiring a conversation thread takes from its channel's plane.
//
// `useConversation` (ConversationThread.tsx) runs the tenant conversations and,
// on an initiative bound to a Social channel, that channel itself. Social's
// commands (/summarize, /deck, /diagram, /doc, /agent and the /agent
// waiting-approval poll) live on Social's routes, the tenant conversations' on
// /api/conversations; a thread on `social:ch:<slug>` that used the tenant ones
// got a 400 on every poll (second regression walk, 10 November). This picks
// the set from the channel, the same set SocialConversation.tsx passes.
//
// Pure: node:test asserts that every call of the Social set goes to a Social route.

import type { ChatCommand } from '@connorhoehn/ui-components/social';
import { channelPlane, type ChannelPlane } from './channelPlane.ts';
import { conversationSummarizeApi, type SummarizeApi } from './conversationSummarize.ts';
import { conversationArtifactApi, socialArtifactApi, type ArtifactApi, type ArtifactCommandName } from './conversationArtifact.ts';
import { conversationAgentApi, socialAgentApi, type AgentApi } from './conversationAgent.ts';
import { conversationChatCommands, socialChatCommands } from './chatCommandRegistry.ts';
import { socialSummarizeApi, socialSummarizeCommand } from '../../pages/social/socialSummarize.ts';
import { socialDeckCommand } from '../../pages/social/decks/socialDecksApi.ts';

export interface ConversationPlaneApis {
  plane: ChannelPlane;
  commands: readonly ChatCommand[];
  summarizeApi: SummarizeApi;
  artifactApi: (kind: ArtifactCommandName) => ArtifactApi;
  agentApi: AgentApi;
}

const SOCIAL: Omit<ConversationPlaneApis, 'plane'> = {
  commands: socialChatCommands(socialSummarizeCommand, socialDeckCommand),
  summarizeApi: socialSummarizeApi, artifactApi: socialArtifactApi, agentApi: socialAgentApi,
};

/** The commands and their APIs for `channel`'s plane. */
export function conversationPlaneApis(channel: string): ConversationPlaneApis {
  const plane = channelPlane(channel);
  if (plane === 'social') return { plane, ...SOCIAL };
  return { plane, commands: conversationChatCommands(channel), summarizeApi: conversationSummarizeApi, artifactApi: conversationArtifactApi, agentApi: conversationAgentApi };
}
