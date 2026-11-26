// Names the meeting assistant (Milo) shares between OrgIQ-MiddlewareService, which creates them, and
// OrgIQ-SocialMedia, which reads them by name (docs/meeting-assistant-design.md). Kept apart from both stacks
// so neither imports the other.
/** The Milo sink secret's name (created by OrgIQ-MiddlewareService with `-c meetingAssistant=true`). */
export const meetingAssistantSinkSecretName = (prefix: string): string => `${prefix}/meeting-assistant/sink-secret`;

/** SSM parameters the meeting assistant publishes for OrgIQ-SocialMedia. */
export function meetingAssistantParameterNames(prefix: string): { sinkSecretArn: string } {
  return { sinkSecretArn: `/${prefix}/meeting-assistant/sink-secret-arn` };
}

