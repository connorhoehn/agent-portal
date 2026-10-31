// Read-only tenant isolation proof: ask for subscriptions/history, never send a
// message. Keep tokens and any accidentally disclosed content out of the log.
export async function gatewayRefusal(page, channel, timeoutMs = 8000, fallbackUrl) {
  return page.evaluate(async ({ channel, timeoutMs, fallbackUrl }) => {
    const response = await fetch('/api/session/realtime-token', { credentials: 'include', signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`realtime token request answered ${response.status}`);
    const { token, gatewayUrl } = await response.json();
    // Match the portal: the token endpoint wins over its public Vite setting.
    const endpoint = gatewayUrl ?? fallbackUrl;
    if (!endpoint) throw new Error('no gatewayUrl in the token response or portal configuration');
    const url = new URL(endpoint);
    if (!['https:', 'http:', 'ws:', 'wss:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid gateway URL');
    url.protocol = ['https:', 'wss:'].includes(url.protocol) ? 'wss:' : 'ws:';
    url.pathname = `${url.pathname.replace(/\/$/, '').replace(/\/ws$/, '')}/ws`;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url.href, ['bearer-token-v1', token]);
      const denied = [];
      let leaked = 0;
      let grace;
      const finish = (error) => {
        clearTimeout(deadline); clearTimeout(grace);
        ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
        ws.close();
        if (error) reject(new Error(error));
        else resolve({ channel, denied, leaked });
      };
      const deadline = setTimeout(() => finish(`gateway refusal timed out (denials: ${denied.join(', ') || 'none'}; disclosed frames: ${leaked})`), timeoutMs);
      ws.onerror = () => finish('gateway socket refused');
      ws.onclose = () => finish('gateway socket closed before the refusal proof');
      ws.onopen = () => {
        ws.send(JSON.stringify({ service: 'chat', action: 'join', channel }));
        ws.send(JSON.stringify({ service: 'chat', action: 'history', channel, limit: 20 }));
        ws.send(JSON.stringify({ service: 'presence', action: 'subscribe', channel }));
      };
      ws.onmessage = ({ data }) => {
        let frame;
        try { frame = JSON.parse(String(data)); } catch { finish('gateway sent a malformed frame'); return; }
        if (frame.channel !== channel) return;
        if ((frame.type === 'chat' && ['history', 'message', 'joined'].includes(frame.action)) || frame.type === 'presence') leaked++;
        if (frame.type === 'error' && frame.code === 'AUTHZ_CHANNEL_DENIED') denied.push(`${frame.service}/${frame.kind}`);
        // Chat's join can refuse a nonmember before reaching channel authority.
        // History and presence must still prove AUTHZ_CHANNEL_DENIED themselves.
        if (frame.type === 'error' && frame.service === 'chat' && frame.error?.code === 'not-a-member') denied.push('chat/not-a-member');
        if (!grace && denied.includes('chat/subscribe') && denied.filter(x => x === 'chat/subscribe' || x === 'chat/not-a-member').length >= 2 && denied.includes('presence/subscribe')) {
          grace = setTimeout(() => finish(), 300);
        }
      };
    });
  }, { channel, timeoutMs, fallbackUrl });
}
