// Local read notifications contain no recording bodies or private artifact data.
export const RECORDING_CHANGED_EVENT = 'page-recording-changed';
export function notifyRecordingRead(lobby: string, source: 'postcall' | 'detail') {
  window.dispatchEvent(new CustomEvent(RECORDING_CHANGED_EVENT, { detail: { lobby, source } }));
}
