// Provider registry. Routes import from here so the real-vs-mock switch is
// centralized. Each provider file exports both Real* and Mock* implementations
// and this module picks one based on config.mock.* flags.

import { config } from '../config.js';
import type {
  AuroraProvider,
  AgentCoreProvider,
  GuardrailsProvider,
  CloudWatchProvider,
} from './types.js';

import { realAurora, mockAurora } from './aurora.js';
import { realAgentCore, mockAgentCore } from './agentcore.js';
import { realGuardrails, mockGuardrails } from './guardrails.js';
import { realCloudWatch, mockCloudWatch } from './cloudwatch.js';

export const aurora: AuroraProvider = config.mock.aurora ? mockAurora : realAurora;
export const agentcore: AgentCoreProvider = config.mock.agentcore ? mockAgentCore : realAgentCore;
export const guardrails: GuardrailsProvider = config.mock.guardrails ? mockGuardrails : realGuardrails;
export const cloudwatch: CloudWatchProvider = config.mock.cloudwatch ? mockCloudWatch : realCloudWatch;

export type * from './types.js';
