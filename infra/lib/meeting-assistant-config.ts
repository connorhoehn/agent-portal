// Names the meeting assistant (Milo) shares between OrgIQ-MiddlewareService, which creates them, and
// OrgIQ-SocialMedia, which reads them by name (docs/meeting-assistant-design.md). Kept apart from both stacks
// so neither imports the other.
/** The Milo sink secret's name (created by OrgIQ-MiddlewareService with `-c meetingAssistant=true`). */
export const meetingAssistantSinkSecretName = (prefix: string): string => `${prefix}/meeting-assistant/sink-secret`;

/** SSM parameters the meeting assistant publishes for OrgIQ-SocialMedia. */
export function meetingAssistantParameterNames(prefix: string): { sinkSecretArn: string } {
  return { sinkSecretArn: `/${prefix}/meeting-assistant/sink-secret-arn` };
}

export type MeetingAssistantProvider = 'aws' | 'openai';

/**
 * `-c meetingAssistantProvider`: `aws` (the default in the cloud: Transcribe, Bedrock and Polly, inside this
 * account) or `openai` (the live session the local world uses; needs the `<prefix>/openai/api-key` secret).
 */
export function meetingAssistantProvider(raw: unknown): MeetingAssistantProvider {
  if (raw === undefined || raw === null || raw === '') return 'aws';
  if (raw === 'aws' || raw === 'openai') return raw;
  throw new Error(`--context meetingAssistantProvider must be aws or openai, got ${JSON.stringify(raw)}`);
}

