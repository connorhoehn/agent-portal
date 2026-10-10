const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

/** Prefer the server's attachment name; retain the saved-version name if absent. */
export function deckDownloadName(disposition: string | null, fallback: string): string {
  const encoded = disposition?.match(/filename\*\s*=\s*UTF-8''([^;]+)/i)?.[1];
  let name: string | undefined;
  if (encoded) {
    try { name = decodeURIComponent(encoded.trim()); } catch { /* use the plain attachment name */ }
  }
  name ||= disposition?.match(/filename\s*=\s*"([^"]+)"/i)?.[1]
    ?? disposition?.match(/filename\s*=\s*([^;]+)/i)?.[1]?.trim();
  // A download name cannot select a directory or contain control characters.
  return (name || fallback).replace(/[\\/\u0000-\u001f\u007f]/g, '_');
}

/** Fetching the attachment keeps the active document (and its huddle) alive. */
export async function downloadDeckFile(fileUrl: string, fallbackName: string, signal: AbortSignal): Promise<void> {
  const url = new URL(fileUrl, window.location.href);
  if (url.origin !== window.location.origin) throw new Error('The presentation file must be downloaded from this workspace.');
  const response = await fetch(url.href, { credentials: 'same-origin', mode: 'same-origin', signal });
  if (!response.ok) {
    throw new Error(response.status === 401 ? 'Your session has expired. Sign in again to download this presentation.'
      : response.status === 403 ? 'You do not have permission to download this presentation.'
        : `The presentation could not be downloaded (${response.status}). Try again.`);
  }
  if (response.headers.get('content-type')?.split(';', 1)[0]?.trim() !== PPTX_MIME) {
    throw new Error('The server did not return a PowerPoint file. Try again.');
  }
  const file = await response.blob();
  signal.throwIfAborted();
  if (!file.size) throw new Error('The presentation file is empty. Try again.');
  const objectUrl = URL.createObjectURL(file);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = deckDownloadName(response.headers.get('content-disposition'), fallbackName);
  anchor.hidden = true;
  try {
    document.body.append(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    // Keep the blob available while the browser starts its download.
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
  }
}
