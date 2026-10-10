// The presence-only channel of one Social deck: `social:deck:<deckId>`
// (docs/agentic-flows-migration.md slice 5). The deck page joins it as
// `presence:social:deck:<id>` so collaborators see each other and the slide
// each is on, as pipelines:deck:<id> does for run reports.
//
// Not a tenant-channels.ts family: Social is not a partition tenant there, and
// the Social rules (any grant holder under `social:`) would admit every
// ViewSocial holder to every deck. Authority is the deck's REST read, asked
// FRESH on every subscribe and delivered frame (live-principal.ts
// authorizeSocialDeckChannel): the deck's owner, or a CURRENT member of the
// conversation it was built from, both with ViewSocial now. Services other
// than presence (chat, reactions, cursor, typing, pins, activity) are refused,
// there is no history, and it is never a call lobby.

const CHANNEL = /^social:deck:(sdeck-[0-9a-f-]{36})$/;

/** Any name under `social:deck:`, well-formed or not (the guards refuse the malformed ones). */
export const inSocialDeckNamespace = (name: string): boolean => /^social:deck(?::|$)/.test(name);

/** The deck id of a well-formed `social:deck:<id>`; null otherwise. */
export function parseSocialDeckChannel(name: unknown): { deckId: string } | null {
  if (typeof name !== 'string') return null;
  const m = CHANNEL.exec(name);
  return m ? { deckId: m[1]! } : null;
}

/** `presence:social:deck:<id>` is the one wire name a client may use. */
export const socialDeckPresenceChannel = (deckId: string): string => `presence:social:deck:${deckId}`;
