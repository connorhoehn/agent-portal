// The meeting assistant (Nova), package 1: flag, stores, caption intake and the detector.
// docs/meeting-assistant-design.md. Routes: routes/meeting-assistant.ts (+ the mock-only
// injector in routes/meeting-assistant-dev.ts).
import { config } from '../../config.js';
import { LineIntake } from './intake.js';
import { assistantStore } from './store-select.js';

export * from './types.js';
export * from './detector.js';
export { assistantStore, setAssistantStore } from './store-select.js';
export { transcriptSource, setTranscriptSource, theMockTranscriptSource, mockTranscriptEnabled, TranscriptSourceNotConfigured } from './transcript-source.js';
export { sweepTranscripts, startRetentionSweep } from './retention.js';

/** Off by default (MEETING_ASSISTANT_ENABLED=true). Read per request so tests can flip it. */
export function meetingAssistantEnabled(): boolean { return config.meetingAssistant?.enabled === true; }

let intake: LineIntake | null = null;
export function assistantIntake(): LineIntake { return (intake ??= new LineIntake(assistantStore())); }
export function setAssistantIntake(next: LineIntake | null): void { intake?.dispose(); intake = next; }
