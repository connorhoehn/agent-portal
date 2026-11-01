// A journey may post only between two fresh clones opened by this walk. Never
// use a copied persona DM: its other member would be a real seed identity.
export function cloneDmChannel(sender, recipient) {
  for (const actor of [sender, recipient]) {
    if (!actor?.clone || actor.clone !== actor.principal?.sub || !/^u-[a-z0-9-]+-clone-[a-z0-9-]+$/.test(actor.clone)
      || actor.principal.tenant !== 'social' || actor.readOnly) throw new Error('DM delivery requires two writable Social clones created by this walk');
  }
  if (sender.clone === recipient.clone) throw new Error('DM delivery requires distinct clones');
  return `social:dm:${[sender.clone, recipient.clone].sort().join(':')}`;
}

export async function sendCloneDm(page, channel, senderId, message, fallbackUrl, timeoutMs = 8000) {
  return page.evaluate(async ({ channel, senderId, message, fallbackUrl, timeoutMs }) => {
    if (!['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) throw new Error('clone DM journeys require a local app');
    const healthResponse = await fetch('/api/health', { signal: AbortSignal.timeout(timeoutMs) });
    const health = healthResponse.ok ? await healthResponse.json() : null;
    if (health?.profile !== 'local-ephemeral' || !health?.mocks?.aurora || health?.realtime?.store !== 'memory' || health?.realtime?.chatStore !== 'memory') throw new Error('clone DM journeys require the local mock memory chat and inbox stores');
    const me = await fetch('/api/session/me', { signal: AbortSignal.timeout(timeoutMs) });
    if (!me.ok || (await me.json()).sub !== senderId) throw new Error('DM sender session changed');
    const response = await fetch('/api/session/realtime-token', { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`realtime token request answered ${response.status}`);
    const { token, gatewayUrl } = await response.json();
    if (!(gatewayUrl ?? fallbackUrl)) throw new Error('no local gateway URL');
    const url = new URL(gatewayUrl ?? fallbackUrl);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password
      || !['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) throw new Error('clone DM journeys require a local gateway');
    url.protocol = ['https:', 'wss:'].includes(url.protocol) ? 'wss:' : 'ws:';
    url.pathname = `${url.pathname.replace(/\/$/, '').replace(/\/ws$/, '')}/ws`;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url.href, ['bearer-token-v1', token]);
      let sent = false;
      const finish = (error, id) => {
        clearTimeout(deadline);
        ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
        ws.close();
        if (error) reject(new Error(error));
        else resolve({ channel, sender: senderId, messageId: id, acknowledged: true });
      };
      const deadline = setTimeout(() => finish('clone DM delivery timed out'), timeoutMs);
      ws.onerror = () => finish('clone DM socket failed');
      ws.onclose = () => finish('clone DM socket closed before acknowledgement');
      ws.onopen = () => ws.send(JSON.stringify({ service: 'chat', action: 'join', channel }));
      ws.onmessage = ({ data }) => {
        let frame;
        try { frame = JSON.parse(String(data)); } catch { finish('malformed gateway frame'); return; }
        if (frame.channel !== channel) return;
        if (frame.type === 'error') { finish('gateway refused the clone DM'); return; }
        if (!sent && frame.type === 'chat' && frame.action === 'joined') {
          sent = true;
          ws.send(JSON.stringify({ service: 'chat', action: 'send', channel, message }));
        }
        if (sent && frame.type === 'chat' && frame.action === 'message' && frame.message?.userId === senderId
          && frame.message?.message === message && frame.message?.id) finish(null, frame.message.id);
      };
    });
  }, { channel, senderId, message, fallbackUrl, timeoutMs });
}
