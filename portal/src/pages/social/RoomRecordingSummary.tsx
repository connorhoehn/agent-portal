// A room recording's private summary card, drawn by the Recordings pane because a
// room has no conversation (slice 7). It is the same rich card the thread draws for
// a DM call (ConversationSummaryCard, `social-summary-*` test ids). "Post to
// conversation" sends to the channel or DM the requester chooses here; nothing is
// sent before that press.

import { useEffect, useMemo, useRef, useState } from 'react';
import { FormField, InlineAlert, Select, Stack } from '@connorhoehnslalom/ui-components/shared';
import { useChat, useGatewayOptional } from '@connorhoehnslalom/realtime-modules/client';
import ConversationSummaryCard from '../../components/chat/ConversationSummaryCard';
import { inputWiring } from '../identity/identityFormat';
import { sendAndWaitForSocialChatAck } from './socialChatDelivery';
import { roomSummarizeApi, type RoomSummaryTarget } from './socialRoomSummary';

type Send = (text: string, metadata: Record<string, unknown>) => Promise<void>;

/** Joins the chosen target (the gateway admits members only) and exposes a confirmed send. Renders nothing. */
function PostBridge({ channel, userId, displayName, sendRef }: { channel: string; userId: string; displayName: string; sendRef: { current: Send | null } }) {
  const chat = useChat(channel);
  const gateway = useGatewayOptional();
  const listen = gateway?.onMessage;
  const [joined, setJoined] = useState(false);
  useEffect(() => { setJoined(false); }, [channel, gateway?.sessionEpoch]);
  useEffect(() => listen?.((frame) => {
    if (frame.type === 'chat' && frame.channel === channel && frame.action === 'joined') setJoined(true);
  }), [listen, channel]);
  const live = joined && gateway?.connectionState === 'connected' && !!listen;
  const chatRef = useRef(chat); chatRef.current = chat;
  useEffect(() => {
    if (!live || !listen) { sendRef.current = null; return undefined; }
    sendRef.current = async (text, metadata) => {
      const deliveryId = crypto.randomUUID();
      await sendAndWaitForSocialChatAck({ channel, deliveryId, userId, listen, signal: new AbortController().signal,
        send: () => chatRef.current.sendMessage(text.trim(), { displayName, clientDeliveryId: deliveryId, ...metadata }) });
    };
    return () => { sendRef.current = null; };
  }, [live, listen, channel, userId, displayName, sendRef]);
  return null;
}

export default function RoomRecordingSummary({ runId, instruction, userId, displayName, targets, onDismiss }: {
  runId: string; instruction: string; userId: string; displayName: string; targets: readonly RoomSummaryTarget[]; onDismiss: () => void;
}) {
  const [target, setTarget] = useState<string>('');
  const targetRef = useRef<string>(''); targetRef.current = target;
  const sendRef = useRef<Send | null>(null);
  const api = useMemo(() => roomSummarizeApi(() => targetRef.current || null), []);
  const options = useMemo(() => [{ value: '', label: 'Choose where to post…' }, ...targets.map(t => ({ value: t.channel, label: t.label }))], [targets]);

  return (
    <Stack gap="sm" data-testid="social-room-summary">
      <FormField label="Post it to" layout="inline">
        {(wiring) => <Select {...inputWiring(wiring)} className="min-w-[220px]" options={options} value={target}
          onChange={e => setTarget(e.target.value)} data-testid="social-room-summary-target" />}
      </FormField>
      {targets.length === 0 && <InlineAlert tone="info">You have no channel or direct message to post to yet.</InlineAlert>}
      {target && <PostBridge key={target} channel={target} userId={userId} displayName={displayName} sendRef={sendRef} />}
      <ConversationSummaryCard runId={runId} instruction={instruction} requestedBy={displayName} api={api} onDismiss={onDismiss}
        onPost={async (message) => {
          const send = sendRef.current;
          if (!send) throw new Error('That conversation is still connecting. Try again in a moment.');
          await send(message.text, message.metadata);
        }}
        testIdPrefix="social-summary" />
    </Stack>
  );
}
