// The process's one LineIntake (the caption intake and detector), cached; tests inject with setAssistantIntake.
import { LineIntake } from './intake.js';
import { assistantStore } from './store-select.js';

let intake: LineIntake | null = null;
export function assistantIntake(): LineIntake { return (intake ??= new LineIntake(assistantStore())); }
export function setAssistantIntake(next: LineIntake | null): void { intake?.dispose(); intake = next; }
