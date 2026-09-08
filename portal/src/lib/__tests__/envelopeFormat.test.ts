// Run with:  cd portal && node --test 'src/lib/__tests__/envelopeFormat.test.ts'
//
// The whole point of these is the null. `GET /api/sprints/envelopes` sends
// `spentUsd`/`remainingUsd` as null when nothing records who dispatched a run,
// and the one bug worth spending a suite on is a client that reads that null as
// zero and prints "$0.00 spent" over an envelope whose burn nobody knows.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  usd, hasKnownBurn, envelopeCeilingUsd, remainingLabel, spentLabel,
  envelopeScopeLabel, envelopeWindowLabel, summarizeEnvelopes, preflightEnvelope,
  envelopeForInitiative,
} from '../envelopeFormat.ts';
import type { EnvelopeRow, EnvelopesResponse } from '../envelopeFormat.ts';

// Shaped from a real dev:mock response (u-nora), not from memory — including
// the null window a sprint-less standing grant really comes back with.
function row(over: Partial<EnvelopeRow> = {}): EnvelopeRow {
  return {
    grantId: 'bg-auth-3',
    orgProjectId: 'p-auth-migration',
    orgProjectName: 'Auth Migration',
    sprintId: 'spr-auth-s2',
    sprintName: 'Sprint 42 — Session hygiene',
    sprintStatus: 'active',
    startsOn: null,
    endsOn: null,
    allocatedUsd: 15,
    spentUsd: 0,
    remainingUsd: 15,
    attributionAvailable: true,
    ...over,
  };
}

/** The unattributed variant the server sends on a pre-migration cluster. */
function unattributed(over: Partial<EnvelopeRow> = {}): EnvelopeRow {
  return row({ spentUsd: null, remainingUsd: null, attributionAvailable: false, ...over });
}

function response(over: Partial<EnvelopesResponse> = {}): EnvelopesResponse {
  return {
    personId: 'p-004',
    resolved: true,
    attributionAvailable: true,
    note: 'counts only runs recorded as dispatched by you',
    envelopes: [row()],
    ...over,
  };
}

const summaryArgs = { isLoading: false, error: null, canDispatch: true, role: 'sme' as string | undefined };

// ─── Money and shape guards ──────────────────────────────────────────────────

test('usd matches the server spelling, separators and all', () => {
  assert.equal(usd(0), '$0.00');
  assert.equal(usd(15), '$15.00');
  assert.equal(usd(1234.5), '$1,234.50');
});

test('hasKnownBurn guards on the NUMBER, not on attributionAvailable', () => {
  assert.equal(hasKnownBurn(row()), true);
  assert.equal(hasKnownBurn(unattributed()), false);
  // A server that sent the flag true but the amounts null would still be
  // unknown — the shape is the authority.
  assert.equal(hasKnownBurn(row({ remainingUsd: null, attributionAvailable: true })), false);
  assert.equal(hasKnownBurn(row({ spentUsd: null, attributionAvailable: true })), false);
});

test('a spent-out envelope is known at zero, not unknown', () => {
  const spentOut = row({ spentUsd: 15, remainingUsd: 0 });
  assert.equal(hasKnownBurn(spentOut), true);
  assert.equal(remainingLabel(spentOut), '$0.00');
});

test('envelopeCeilingUsd takes the same branch decideEnvelope takes', () => {
  // Attribution present: the brake compares against what is LEFT.
  assert.equal(envelopeCeilingUsd(row({ spentUsd: 9, remainingUsd: 6 })), 6);
  // Attribution absent: the brake compares against the envelope's FULL size.
  assert.equal(envelopeCeilingUsd(unattributed({ allocatedUsd: 30 })), 30);
});

test('an unknown burn is words, never a dollar amount', () => {
  assert.equal(remainingLabel(unattributed()), 'not attributed');
  assert.equal(spentLabel(unattributed()), 'not attributed');
  assert.doesNotMatch(remainingLabel(unattributed()), /\$/);
  assert.doesNotMatch(spentLabel(unattributed()), /0\.00/);
});

// ─── Naming ──────────────────────────────────────────────────────────────────

test('envelopeScopeLabel degrades to whatever the row actually carries', () => {
  assert.equal(envelopeScopeLabel(row()), 'Auth Migration · Sprint 42 — Session hygiene');
  assert.equal(envelopeScopeLabel(row({ sprintName: null, sprintId: null })), 'Auth Migration');
  assert.equal(
    envelopeScopeLabel(row({ orgProjectName: null, sprintName: null })),
    'p-auth-migration',
  );
});

test('envelopeWindowLabel tells a standing grant from a sprint with no dates', () => {
  // A grant that names a sprint but carries no dates is NOT a standing grant —
  // and the seed data hands you exactly that row.
  assert.equal(envelopeWindowLabel(row()), 'no dates on this sprint');
  assert.equal(
    envelopeWindowLabel(row({ sprintId: null, sprintName: null })),
    'standing grant — no window',
  );
  assert.equal(
    envelopeWindowLabel(row({ startsOn: '2026-08-24', endsOn: '2026-08-30' })),
    '24 Aug → 30 Aug',
  );
  // Half a window is still a window.
  assert.equal(envelopeWindowLabel(row({ startsOn: '2026-08-24' })), '24 Aug → —');
});

// ─── The lens headline ───────────────────────────────────────────────────────

test('a reader who cannot dispatch is never shown an envelope tile', () => {
  assert.equal(
    summarizeEnvelopes({ ...summaryArgs, canDispatch: false, role: 'member', data: response() }),
    null,
  );
});

test('one envelope: the number left, and what it is left of', () => {
  const s = summarizeEnvelopes({ ...summaryArgs, data: response() })!;
  assert.equal(s.kind, 'known');
  assert.equal(s.value, '$15.00');
  assert.match(s.hint, /of \$15\.00 on Auth Migration$/);
  assert.equal(s.openable, true);
  assert.equal(s.count, 1);
});

test('several envelopes total, and say how many they are spread over', () => {
  const s = summarizeEnvelopes({
    ...summaryArgs,
    data: response({ envelopes: [row(), row({ grantId: 'g2', allocatedUsd: 30, remainingUsd: 20, spentUsd: 10 })] }),
  })!;
  assert.equal(s.kind, 'known');
  assert.equal(s.value, '$35.00');
  assert.match(s.hint, /of \$45\.00 across 2 sprint envelopes/);
  assert.equal(s.count, 2);
});

test('a spent-out envelope reads danger at exactly $0.00, not "unknown"', () => {
  const s = summarizeEnvelopes({
    ...summaryArgs, data: response({ envelopes: [row({ spentUsd: 15, remainingUsd: 0 })] }),
  })!;
  assert.equal(s.kind, 'known');
  assert.equal(s.value, '$0.00');
  assert.equal(s.tone, 'danger');
});

test('ONE unattributed row makes the whole total unknown — never a partial sum', () => {
  const s = summarizeEnvelopes({
    ...summaryArgs, data: response({ envelopes: [row(), unattributed({ grantId: 'g2', allocatedUsd: 30 })] }),
  })!;
  assert.equal(s.kind, 'unknown-burn');
  assert.equal(s.value, 'unknown');
  // The grant total is still knowable and still said; only the burn is not.
  assert.match(s.hint, /\$45\.00 granted across 2 sprint envelopes — burn not attributed/);
  // The $15 we do know must not leak out as if it were the answer.
  assert.notEqual(s.value, '$15.00');
});

test('empty and unresolved are different states with different copy', () => {
  const empty = summarizeEnvelopes({ ...summaryArgs, data: response({ envelopes: [] }) })!;
  assert.equal(empty.kind, 'none');
  assert.equal(empty.value, 'none');
  assert.equal(empty.tone, 'danger');
  assert.match(empty.hint, /no active sprint grant/);
  // Openable: the consequence is a sentence, and a tile hint is one clipped
  // line — the breakdown behind it is where the sentence fits.
  assert.equal(empty.openable, true);

  const unresolved = summarizeEnvelopes({
    ...summaryArgs,
    role: 'admin',
    data: {
      personId: null, resolved: false, attributionAvailable: null, envelopes: [],
      reason: 'this account is not linked to a person in the org graph, so it holds no sprint envelopes',
    },
  })!;
  assert.equal(unresolved.kind, 'unresolved');
  assert.equal(unresolved.value, 'unknown');
  assert.match(unresolved.hint, /not linked to a person/);
  assert.notEqual(unresolved.value, empty.value);
});

test('"no grant" is only an alarm for the role that is actually grant-scoped', () => {
  // sme: refused at dispatch, so say so.
  assert.equal(summarizeEnvelopes({ ...summaryArgs, data: response({ envelopes: [] }) })!.kind, 'none');
  // org-leader dispatches without a grant by design — no tile at all.
  assert.equal(
    summarizeEnvelopes({ ...summaryArgs, role: 'org-leader', data: response({ envelopes: [] }) }),
    null,
  );
});

test('loading and error say which they are, and claim no money', () => {
  const loading = summarizeEnvelopes({ ...summaryArgs, isLoading: true, data: null })!;
  assert.equal(loading.kind, 'loading');
  assert.equal(loading.openable, false);

  const errored = summarizeEnvelopes({ ...summaryArgs, error: '500 Internal Server Error', data: null })!;
  assert.equal(errored.kind, 'error');
  assert.equal(errored.value, 'unavailable');
  assert.match(errored.hint, /500/);
});

// ─── The dispatch pre-flight ─────────────────────────────────────────────────

const P = { costUsdP25: 2, costUsdP75: 6 };

test('envelopeForInitiative matches on the initiative, never on the sprint', () => {
  const data = response({ envelopes: [row(), row({ grantId: 'g2', orgProjectId: 'p-observability' })] });
  assert.equal(envelopeForInitiative(data, 'p-observability')!.grantId, 'g2');
  assert.equal(envelopeForInitiative(data, 'p-nothing'), null);
  // A standing grant carries no sprint id and must still be found.
  const standing = response({ envelopes: [row({ sprintId: null, sprintName: null })] });
  assert.equal(envelopeForInitiative(standing, 'p-auth-migration')!.grantId, 'bg-auth-3');
});

test('a fitting forecast is reported with the ledger, not just a thumbs up', () => {
  const p = preflightEnvelope({
    data: response({ envelopes: [row({ spentUsd: 3, remainingUsd: 12 })] }),
    orgProjectId: 'p-auth-migration', forecast: P, role: 'sme',
  })!;
  assert.equal(p.kind, 'fits');
  assert.equal(p.tone, 'info');
  assert.match(p.body, /\$3\.00 of your \$15\.00 envelope on Sprint 42/);
  assert.match(p.body, /leaving \$12\.00/);
  assert.match(p.body, /only runs recorded as dispatched by you/);
  assert.match(p.confirmLine, /\$12\.00 left/);
});

test('the pre-flight predicts the 409 the brake is about to raise', () => {
  const p = preflightEnvelope({
    data: response({ envelopes: [row({ spentUsd: 11, remainingUsd: 4 })] }),
    orgProjectId: 'p-auth-migration', forecast: P, role: 'sme',
  })!;
  assert.equal(p.kind, 'over');
  assert.equal(p.tone, 'warning');
  assert.match(p.body, /over the \$4\.00 left/);
  assert.match(p.confirmLine, /asked to confirm/);
});

test('the fit boundary is the brake\'s: p75 over the remaining, not the estimate midpoint', () => {
  const at = preflightEnvelope({
    data: response({ envelopes: [row({ spentUsd: 9, remainingUsd: 6 })] }),
    orgProjectId: 'p-auth-migration', forecast: P, role: 'sme',
  })!;
  assert.equal(at.kind, 'fits', 'p75 == remaining proceeds, exactly as decideEnvelope does');
  const justOver = preflightEnvelope({
    data: response({ envelopes: [row({ spentUsd: 9.01, remainingUsd: 5.99 })] }),
    orgProjectId: 'p-auth-migration', forecast: P, role: 'sme',
  })!;
  assert.equal(justOver.kind, 'over');
});

test('an unattributed burn compares against the envelope SIZE, as the brake does', () => {
  const data = response({ envelopes: [unattributed({ allocatedUsd: 30 })], attributionAvailable: false });
  const fits = preflightEnvelope({ data, orgProjectId: 'p-auth-migration', forecast: P, role: 'sme' })!;
  assert.equal(fits.kind, 'unknown-burn');
  assert.match(fits.body, /unknown, not zero/);
  assert.doesNotMatch(fits.body, /left of/);
  assert.doesNotMatch(fits.confirmLine, /\$0\.00/);

  const over = preflightEnvelope({
    data, orgProjectId: 'p-auth-migration', forecast: { costUsdP25: 20, costUsdP75: 40 }, role: 'sme',
  })!;
  assert.equal(over.kind, 'unknown-burn-over');
  assert.equal(over.tone, 'warning');
  assert.match(over.body, /does not fit it at all/);
});

test('no forecast yet still reports the envelope, and invents no range', () => {
  const p = preflightEnvelope({
    data: response(), orgProjectId: 'p-auth-migration', forecast: null, role: 'sme',
  })!;
  assert.equal(p.kind, 'fits');
  assert.doesNotMatch(p.body, /forecast at/);
});

test('an sme with no grant here is warned about the 403 before filling the form', () => {
  const p = preflightEnvelope({
    data: response({ envelopes: [] }), orgProjectId: 'p-auth-migration', forecast: P, role: 'sme',
  })!;
  assert.equal(p.kind, 'no-grant');
  assert.equal(p.tone, 'warning');
  assert.match(p.body, /cannot be confirmed through/);
});

test('a role that is not grant-scoped is told nothing when it holds no envelope', () => {
  assert.equal(
    preflightEnvelope({
      data: response({ envelopes: [] }), orgProjectId: 'p-auth-migration', forecast: P, role: 'org-leader',
    }),
    null,
  );
});

test('an unresolved read never becomes "you hold no grant"', () => {
  const p = preflightEnvelope({
    data: {
      personId: 'p-004', resolved: false, attributionAvailable: null, envelopes: [],
      reason: 'your sprint envelopes could not be read just now',
    },
    orgProjectId: 'p-auth-migration', forecast: P, role: 'sme',
  })!;
  assert.equal(p.kind, 'unresolved');
  assert.doesNotMatch(p.body, /no active sprint grant/);
  assert.match(p.body, /could not be read/);
});

test('the pre-flight stays silent until the host page knows the initiative', () => {
  assert.equal(
    preflightEnvelope({ data: response(), orgProjectId: null, forecast: P, role: 'sme' }),
    null,
  );
  assert.equal(
    preflightEnvelope({ data: null, orgProjectId: 'p-auth-migration', forecast: P, role: 'sme' }),
    null,
  );
});
