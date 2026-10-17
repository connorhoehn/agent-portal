// Deck presence over the gateway: this tab joins `<tenant>:deck:<id>` while the
// editor is mounted. The library's `useDeckPresence` (doc-editor) owns the
// roster -> viewers/participants/slideViewers mapping and the presence
// metadata it publishes (selected slide, unsaved edits); this file is the host
// glue — the tenant-prefixed channel the gateway's channelGuard admits
// (the library's own `doc:<id>` would be refused), the roster, the socket's
// client id and `updateMetadata`. Without a gateway nothing is mounted, so the
// editor works and presence stays hidden.

import { useEffect, type ReactElement } from 'react';
import { useGatewayOptional, usePresence } from '@connorhoehn/realtime-modules/client';
import { EMPTY_DECK_PRESENCE, useDeckPresence, type DeckPresence } from '@connorhoehnslalom/ui-components/doc-editor';

export { EMPTY_DECK_PRESENCE };
export type { DeckPresence };

export const deckPresenceChannel = (deckId: string, tenant: 'assessment' | 'pipelines' | 'orgiq' | 'social' = 'assessment'): string => `${tenant}:deck:${deckId}`;

interface SourceProps {
  deckId: string;
  /** Which tenant's `<tenant>:deck:<id>` channel to join (default assessment). */
  tenant?: 'assessment' | 'pipelines' | 'orgiq' | 'social';
  selectedSlideId: string | null;
  slideTitle?: (slideId: string) => string | undefined;
  /** This tab has unsaved edits: peers' Save warns while it does. */
  editing?: boolean;
  onChange: (presence: DeckPresence) => void;
}

function DeckPresenceBridge({ deckId, tenant, selectedSlideId, slideTitle, editing, onChange }: SourceProps): null {
  const gateway = useGatewayOptional();
  const { roster, updateMetadata } = usePresence(deckPresenceChannel(deckId, tenant), { join: true });
  const presence = useDeckPresence({
    roster, ownClientId: gateway?.clientId ?? null, updateMetadata,
    documentId: deckId, selectedSlideId, ...(slideTitle ? { slideTitle } : {}), editing: !!editing,
  });
  useEffect(() => { onChange(presence); }, [presence, onChange]);
  useEffect(() => () => onChange(EMPTY_DECK_PRESENCE), [onChange]);
  return null;
}

/** Render-nothing: mounts presence only where a gateway exists. */
export function DeckPresenceSource(props: SourceProps): ReactElement | null {
  const gateway = useGatewayOptional();
  return gateway ? <DeckPresenceBridge {...props} /> : null;
}
