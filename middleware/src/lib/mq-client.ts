// Compatibility boundary: message-queue owns HTTP behavior and shared types.
// Queue definitions and the local memory fixture remain application concerns.
export { HttpMessageQueue, MessageQueueError } from '@connorhoehnslalom/message-queue/client';
export type {
  MessageQueue, QueueDefinition, QueueMessage, ReceiveOptions, SendOptions,
  QueueSnapshot, RequestOptions, HttpMessageQueueOptions,
} from '@connorhoehnslalom/message-queue/client';
