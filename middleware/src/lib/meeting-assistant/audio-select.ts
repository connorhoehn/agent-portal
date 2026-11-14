// The process's one AudioIntake (the PCM sink's state), cached; tests inject with setAssistantAudio.
import { AudioIntake } from './audio-intake.js';
import { assistantStore } from './store-select.js';

let audio: AudioIntake | null = null;
export function assistantAudio(): AudioIntake { return (audio ??= new AudioIntake(assistantStore)); }
export function setAssistantAudio(next: AudioIntake | null): void { audio?.dispose(); audio = next; }
