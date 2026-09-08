// The prompt-library fetch hooks (components/canary/usePromptLibrary.ts)
// surface a failed response's raw body text as `error` — which, for
// canary-library.ts's Bedrock-backed routes, is literally the unformatted
// JSON `{"error":"Bedrock unavailable","detail":"…"}"` those routes 503 with.
// Rendering that verbatim is DEFECTS.md #8's second half: a human-readable
// surface leaking backend JSON. Pull the `detail` (or `error`) field out when
// the text parses as that shape; fall back to the raw string for anything
// else (a network failure, a plain-text 500, etc).
export function friendlyLibraryError(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { error?: unknown; detail?: unknown };
    if (parsed && typeof parsed === 'object') {
      if (typeof parsed.detail === 'string' && parsed.detail.trim()) return parsed.detail;
      if (typeof parsed.error === 'string' && parsed.error.trim()) return parsed.error;
    }
  } catch {
    // Not JSON — already a plain message, use it as-is.
  }
  return raw;
}
