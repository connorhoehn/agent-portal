export interface CanvasRecovery {
  version: 1;
  savedAt: string;
  snapshot: string;
}
export function canvasRecoveryKey(tenant: string, subject: string, documentId: string): string {
  return `assessment.canvasRecovery:${JSON.stringify([tenant, subject, documentId])}`;
}
export function encodeCanvasRecovery(bytes: Uint8Array): CanvasRecovery {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return { version: 1, savedAt: new Date().toISOString(), snapshot: btoa(binary) };
}
export function decodeCanvasRecovery(value: unknown): Uint8Array | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Partial<CanvasRecovery>;
  if (record.version !== 1 || typeof record.snapshot !== 'string' || !record.snapshot || typeof record.savedAt !== 'string') return null;
  try { return Uint8Array.from(atob(record.snapshot), char => char.charCodeAt(0)); } catch { return null; }
}
