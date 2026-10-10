// The tenant mark in the shell header. ChannelHeader draws a hashed-colour
// initial when it has no avatarUrl — a random hue that has nothing to do
// with the tenant's brand. This builds the mark as an SVG data URI from the
// brand gradient's stops, read from the tenant element's computed tokens,
// so the mark IS the brand and follows the theme.

/** Two-letter mark for a tenant label ("Work" → "Or", "Assessment" → "As"). */
export function brandInitials(label: string): string {
  const s = label.trim();
  if (!s) return '?';
  return s.length >= 2 ? s.slice(0, 2) : s.toUpperCase();
}

/** The first and last colour stops of a CSS linear-gradient(), or null. */
export function gradientStops(gradient: string): [string, string] | null {
  const stops = gradient.match(/#[0-9a-fA-F]{6}\b|rgba?\([^)]*\)/g);
  if (!stops || stops.length < 2) return null;
  return [stops[0]!, stops[stops.length - 1]!];
}

/** An SVG data URI: rounded square in the brand gradient with the initials. */
export function brandMarkUri(label: string, from: string, to: string): string {
  const initials = brandInitials(label);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/>` +
    `</linearGradient></defs>` +
    `<rect width="64" height="64" rx="14" fill="url(#g)"/>` +
    `<text x="32" y="40" text-anchor="middle" font-family="system-ui,-apple-system,sans-serif" ` +
    `font-size="26" font-weight="700" fill="#ffffff">${initials}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
