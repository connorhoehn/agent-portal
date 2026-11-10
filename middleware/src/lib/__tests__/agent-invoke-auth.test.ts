// The invoke auth block is signed so the supervisor can tell the middleware's
// word from a direct caller's (agents/_shared/invoke_auth.py verifies it).
import { verifyServiceRequest } from '@connorhoehn/service-runtime';
import {
  AGENT_INVOKE_AUDIENCE, AGENT_INVOKE_SERVICE_ID, canonicalInvokeAuth, signInvokeAuth, signedAuthFields,
} from '../agent-invoke-auth.js';

const SECRET = 'invoke-secret-for-tests-0123456789';
const auth = { tenant: 'orgiq', sub: 'u-lead', role: 'org-leader', ignored: 42 };

// The same literal is asserted by agents/tests/test_supervisor_invoke_auth.py,
// so a change to either side's canonical form fails both suites.
const CANONICAL = '{"auth":{"role":"org-leader","sub":"u-lead","tenant":"orgiq"},"conversationId":"conv-1"}';

const verify = (sig: string, body: string) => verifyServiceRequest(sig, { method: 'POST', target: '/invocations', body }, {
  secret: SECRET, allowedServices: [AGENT_INVOKE_SERVICE_ID], audience: AGENT_INVOKE_AUDIENCE,
});

describe('agent invoke auth', () => {
  it('canonicalises string fields in sorted order with the conversation id', () => {
    expect(canonicalInvokeAuth(auth, 'conv-1')).toBe(CANONICAL);
  });

  it('signs the block and conversation together, verifiable with the shared envelope', () => {
    const sig = signInvokeAuth(auth, 'conv-1', { AGENT_INVOKE_SECRET: SECRET })!;
    expect(sig).toMatch(/^v1\.orgiq-middleware\.\d+\./);
    expect(verify(sig, CANONICAL).ok).toBe(true);
    expect(verify(sig, canonicalInvokeAuth({ ...auth, role: 'hr-admin' }, 'conv-1')).ok).toBe(false);
    expect(verify(sig, canonicalInvokeAuth(auth, 'conv-2')).ok).toBe(false);
  });

  it('signs nothing without a secret (a dev agent trusts the block only under its own dev flag)', () => {
    expect(signInvokeAuth(auth, 'conv-1', {})).toBeNull();
  });

  it('signs the block the agent will read, from the payload or the structured input', () => {
    const prior = process.env['AGENT_INVOKE_SECRET'];
    process.env['AGENT_INVOKE_SECRET'] = SECRET;
    try {
      const direct = signedAuthFields({ auth: { sub: 'u-1', role: 'member' }, sessionId: 's-1' });
      expect(direct.auth).toEqual({ sub: 'u-1', role: 'member' });
      expect(verify(direct.authSig!, canonicalInvokeAuth(direct.auth!, 's-1')).ok).toBe(true);
      const structured = signedAuthFields({ structuredInput: { auth: { tenant: 'social', sub: 'u-2' } } });
      expect(verify(structured.authSig!, canonicalInvokeAuth({ tenant: 'social', sub: 'u-2' }, '')).ok).toBe(true);
      expect(signedAuthFields({ structuredInput: { mode: 'x' } })).toEqual({});
    } finally {
      if (prior === undefined) delete process.env['AGENT_INVOKE_SECRET']; else process.env['AGENT_INVOKE_SECRET'] = prior;
    }
  });
});
