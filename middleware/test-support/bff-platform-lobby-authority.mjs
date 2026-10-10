// Full-process contract: platform-api's per-resource lobby admission
// (LOBBY_AUTHORITY_REQUIRED, platform-api docs/lobby-authority.md) against two
// real BFFs. Two sessions hold a real page huddle across both BFFs, then use
// a dedicated platform-api (PLATFORM_API_URL, never the shared :23001) that
// asks BFF a's POST /api/realtime/lobby-access. Their page lobby is admitted
// and reaches the SFU; a forged or unlisted lobby is refused (404) at
// platform-api with the same valid tenant token, and so is the real lobby once
// the directory retires the token's session epoch.
//   ORGIQ_BFF_CLUSTER_ACCEPTANCE=1 PLATFORM_API_URL=http://127.0.0.1:23011 \
//     node --test test-support/bff-platform-lobby-authority.mjs
// LOBBY_AUTHORITY_EXPECT=open runs the control against a platform-api with the
// flag off: the same forged lobbies are then admitted by the prefix rule alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { db, login, connect, call, joinHuddle, sendHuddle, receivedHuddle, until, close } from './bff-cluster-fixture.mjs';

const platform = process.env.PLATFORM_API_URL;
if (!platform || /:23001\b/.test(platform)) throw new Error('Set PLATFORM_API_URL to a dedicated platform-api (not the shared :23001)');
const expectOpen = process.env.LOBBY_AUTHORITY_EXPECT === 'open';
const LOBBY = 'orgiq:initiative:cluster-project';

async function video(principal, path, body) {
  const response = await fetch(platform + '/api/video' + path, { method: 'POST',
    headers: { authorization: `Bearer ${principal.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await response.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: response.status, body: json };
}

test('a two-session page huddle is admitted at platform-api; forged and unlisted lobbies are refused with a valid tenant token', { timeout: 60000 }, async () => {
  const alice = await connect(await login(0, 'u-theo')), bob = await connect(await login(1, 'u-vera'));
  const sessions = [];
  try {
    const callId = await call(alice, bob, LOBBY);
    for (const peer of [alice, bob]) await joinHuddle(peer, callId);
    const said = await sendHuddle(alice, callId, 'platform-api lobby authority');
    await until(() => receivedHuddle(bob, said.id), 'peer huddle delivery across BFFs');

    // Both sessions open the page lobby's media at platform-api.
    for (const peer of [alice, bob]) {
      const opened = await video(peer, '/sessions', { lobbyName: LOBBY, findOrCreate: true });
      console.log(`[lobby-authority] ${peer.userId} ${LOBBY} -> ${opened.status} ${opened.body?.sessionId ?? ''}`);
      assert.ok(opened.status === 200 || opened.status === 201, `admitted page lobby (${opened.status} ${JSON.stringify(opened.body)?.slice(0, 200)})`);
      assert.ok(opened.body?.sessionId, 'a real SFU session');
      sessions.push(opened.body.sessionId);
    }
    assert.equal(sessions[0], sessions[1], 'both sessions converge on one call');
    const joined = await video(bob, `/sessions/${sessions[0]}/join`, { lobbyName: LOBBY });
    assert.equal(joined.status, 200, `participant token for the admitted lobby (${joined.status})`);

    // Valid, unexpired tenant tokens; names the prefix rule alone admits.
    // (`orgiq:initiative:<any id>` is not here: that family's read gate is
    // tenant-only with no resource check, so the BFF itself admits any id.)
    const claims = JSON.parse(Buffer.from(alice.token.split('.')[1], 'base64url').toString());
    assert.ok(claims.tenants.includes('social'), 'the token lists social, so the prefix rule admits social:ch:*');
    const forged = ['orgiq:forged-huddle', 'orgiq:work:cluster-work', `orgiq:huddle:${callId}`, 'social:ch:lobby-authority-not-a-member'];
    for (const lobbyName of forged) {
      const res = await video(alice, '/sessions', { lobbyName, findOrCreate: true });
      console.log(`[lobby-authority] u-theo ${lobbyName} -> ${res.status}`);
      if (expectOpen) assert.notEqual(res.status, 404, `control: prefix rule alone admits ${lobbyName}`);
      else assert.equal(res.status, 404, `refused at platform-api: ${lobbyName}`);
      if (expectOpen && res.body?.sessionId) await video(alice, `/sessions/${res.body.sessionId}/end`, { lobbyName });
    }
    if (!expectOpen) {
      // A participant token for the real session under a forged lobby name.
      const sideways = await video(bob, `/sessions/${sessions[0]}/join`, { lobbyName: 'orgiq:forged-huddle' });
      assert.equal(sideways.status, 404, 'join under an unlisted lobby name is refused');

      // The same still-valid token once the directory retires its session.
      const [{ session_epoch: original }] = (await db.query('SELECT session_epoch FROM app_users WHERE id=$1', ['u-theo'])).rows;
      await db.query('UPDATE app_users SET session_epoch=session_epoch+1 WHERE id=$1', ['u-theo']);
      try {
        const retired = await video(alice, '/sessions', { lobbyName: LOBBY, findOrCreate: true });
        console.log(`[lobby-authority] u-theo (retired epoch) ${LOBBY} -> ${retired.status}`);
        assert.equal(retired.status, 404, 'a retired session is refused at platform-api');
      } finally { await db.query('UPDATE app_users SET session_epoch=$2 WHERE id=$1', ['u-theo', original]); }
    }
  } finally {
    if (sessions[0]) await video(alice, `/sessions/${sessions[0]}/end`, { lobbyName: LOBBY }).catch(() => undefined);
    close(alice, bob);
  }
});
