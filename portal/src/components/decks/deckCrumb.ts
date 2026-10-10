// The entity a deck was built from, named the way the deck's own title names it
// ("Auth Migration — status" → "Auth Migration") so a breadcrumb never prints a raw id.
export function deckSubject(title: string, fallback: string): string {
  const head = title.split(' — ')[0]?.trim();
  return head && head !== title.trim() ? head : fallback;
}
