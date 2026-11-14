jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));
import { RowsChatStore, updateThreadMessage } from '../social-chat.js';
import type { ChatMessage } from '@connorhoehn/realtime-modules/chat';

describe('updateThreadMessage with no live service', () => {
  it('finds a message by id however old it is, not only inside the newest 200', async () => {
    const rows: ChatMessage[] = [];
    const store = new RowsChatStore(() => rows);
    const channel = 'orgiq:huddle:c1';
    await store.putMessage({ id: 'old', clientId: 'c', userId: 'nova', channel, message: 'first words', timestamp: new Date(1).toISOString(), metadata: { keep: 1, drop: 2 } });
    for (let i = 0; i < 500; i++) await store.putMessage({ id: `m${i}`, clientId: 'c', userId: 'u', channel, message: `m${i}`, timestamp: new Date(100 + i).toISOString() });
    const out = await updateThreadMessage(channel, 'old', { message: 'gone', metadata: { drop: undefined } }, store);
    expect(out).toMatchObject({ id: 'old', message: 'gone', metadata: { keep: 1 } });
    expect(out?.metadata?.['drop']).toBeUndefined();
    expect((await store.getMessage(channel, 'old'))!.message).toBe('gone');
    expect(await updateThreadMessage(channel, 'nope', { message: 'x' }, store)).toBeNull();
  });
});
