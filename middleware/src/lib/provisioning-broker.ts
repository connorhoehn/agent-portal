// provisioning-broker.ts
// In-process pub/sub for KB provisioning step events.
//
// provisionKb() publishes events to `kb:<id>` topics.
// The SSE handler in kb-admin.ts subscribes and forwards them to the browser.
// Events are ephemeral — if no SSE client is listening, they're dropped.
// The DB status is the source of truth for durable state.

import { EventEmitter } from 'node:events';

export interface StepEvent {
  type: 'step';
  step: string;
  stepStatus: 'running' | 'done' | 'error';
  message?: string;
}

export interface CompleteEvent {
  type: 'complete';
  kbId: string;
}

export interface FailedEvent {
  type: 'failed';
  message: string;
}

export type ProvisioningBrokerEvent = StepEvent | CompleteEvent | FailedEvent;

class ProvisioningBroker extends EventEmitter {}
export const provisioningBroker = new ProvisioningBroker();
provisioningBroker.setMaxListeners(200); // one listener per open SSE connection
