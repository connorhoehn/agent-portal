// The chat commands a conversation offers, in one place. Every surface that
// registers `/summarize` takes its list from here, so a command added here
// reaches Social channels and DMs (SocialConversation's ChatCommandProvider)
// and tenant discussions and huddles (useConversationSummarize) together.
//
//   Social conversations   /summarize /deck /diagram /doc /agent
//   tenant conversations   /summarize /diagram /doc /agent, plus /deck where the channel has a tenant deck
//                          (orgiq initiative -> status deck, pipelines run -> run report; useConversationSummarize
//                          offers it only on those channels)
//
// Pure: no React, so node:test can assert the registry.

import type { ChatCommand } from '@connorhoehnslalom/ui-components/social';
import { conversationSummarizeCommand } from './conversationSummarize.ts';
import { artifactCommand, conversationArtifactApi, socialArtifactApi } from './conversationArtifact.ts';
import { tenantDeckCommand } from './tenantDeck.ts';
import { agentCommand, conversationAgentApi, socialAgentApi } from './conversationAgent.ts';

export const socialDiagramCommand: ChatCommand = artifactCommand(socialArtifactApi('diagram'));
export const socialDocCommand: ChatCommand = artifactCommand(socialArtifactApi('doc'));
export const conversationDiagramCommand: ChatCommand = artifactCommand(conversationArtifactApi('diagram'));
export const conversationDocCommand: ChatCommand = artifactCommand(conversationArtifactApi('doc'));

export const socialAgentCommand: ChatCommand = agentCommand(socialAgentApi);
export const conversationAgentCommand: ChatCommand = agentCommand(conversationAgentApi);

/** Tenant discussions and huddles. */
export const CONVERSATION_CHAT_COMMANDS: readonly ChatCommand[] = [conversationSummarizeCommand, tenantDeckCommand, conversationDiagramCommand, conversationDocCommand, conversationAgentCommand];

/** `/agent` plans AND starts flows, so only a reader who may post is offered it (the BFF refuses the rest too). */
export const withoutAgent = (commands: readonly ChatCommand[]): ChatCommand[] => commands.filter(c => c.trigger !== '/agent');

/** Social conversations: `summarize` and `deck` are Social's own (pages/social), passed in to keep this module free of them. */
export const socialChatCommands = (summarize: ChatCommand, deck: ChatCommand): ChatCommand[] =>
  [summarize, deck, socialDiagramCommand, socialDocCommand, socialAgentCommand];
