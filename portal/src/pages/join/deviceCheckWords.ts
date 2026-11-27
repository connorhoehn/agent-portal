// What the device check says (gap audit 2026-11-20 §11): a blocked or missing microphone is said plainly, with how to allow it,
// and Continue says what will happen instead of reading as if all is well. The candidate may still go on (some join to listen
// and type). Pure, so both states are tested without a browser (__tests__/deviceCheckWords.test.ts).
//
// No connection check: the step makes no request of its own, and a real one would need a new route or a media test, so it
// is left out rather than faked.

export type MediaPermission = 'prompt' | 'granted' | 'denied' | 'unavailable';
export interface DevicePermissions { camera: MediaPermission; microphone: MediaPermission }

export interface DeviceCheckWords {
  /** The one sentence about a blocked device, or null. */
  blocked: string | null;
  /** The one sentence about a device that is not there (and not blocked), or null. */
  missing: string | null;
  continueLabel: string;
}

const HOW = 'allow it in your browser’s site settings (the icon beside the web address), then turn it on again here.';

export function deviceCheckWords(p: DevicePermissions): DeviceCheckWords {
  const micBlocked = p.microphone === 'denied';
  const camBlocked = p.camera === 'denied';
  const micMissing = p.microphone === 'unavailable';
  const camMissing = p.camera === 'unavailable';
  const noMic = micBlocked || micMissing;
  const noCam = camBlocked || camMissing;
  const blocked = micBlocked && camBlocked
    ? 'Your browser is blocking your camera and microphone, so the interviewers will not see or hear you: allow them in your browser’s site settings (the icon beside the web address), then turn them on again here.'
    : micBlocked ? `Your browser is blocking your microphone, so the interviewers will not hear you: ${HOW}`
    : camBlocked ? `Your browser is blocking your camera, so the interviewers will not see you: ${HOW}`
    : null;
  const missing = micMissing && camMissing ? 'No camera or microphone was found. Plug one in, then turn them on again.'
    : micMissing && !micBlocked ? 'No microphone was found, so the interviewers will not hear you. Plug one in, then turn it on again.'
    : camMissing && !camBlocked ? 'No camera was found, so the interviewers will not see you. Plug one in, then turn it on again.'
    : null;
  const continueLabel = noMic && noCam ? 'Continue without a camera or microphone' : noMic ? 'Continue without a microphone' : noCam ? 'Continue without a camera' : 'Continue';
  return { blocked, missing, continueLabel };
}
