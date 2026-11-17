// The invites store (docs/interviews-tenant-plan.md, row I2.1): one row per link a recruiter issued.
//
// Two implementations behind one interface, chosen as lib/interviews/store-select.ts chooses: the memory
// store over the registered fixture (mock/interviews-invites.ts) under the mock providers, the SQL store
// (store-sql.ts, schema/interviews_schema.sql `interview_invites`) otherwise. __tests__/store.test.ts runs
// one contract over both.
//
// The table is the truth about invites.
//
// The store only writes. Who may issue or revoke, and whether an invite is alive, are decided above it
// (the routes, rules.ts). Issuing revokes the interview's live invite in the same write, so there is never
// a moment with two.

import { config } from '../../../config.js';
import type { AdmissionState } from './admission.js';
import { interviewInvitesFixture } from '../../../mock/interviews-invites.js';
import { newInviteId, sameHash } from './token.js';
import { SqlInviteStore } from './store-sql.js';

export interface Invite {
  id: string;
  interviewId: string;
  /** SHA-256 of the token, hex. The token itself is never stored. */
  tokenHash: string;
  issuedBy: string;
  issuedAt: string;
  /** The ceiling (rules.ts INVITE_MAX_DAYS after issue); the live expiry is rules.ts inviteExpiresAt. */
  expiresAt: string;
  revokedAt: string | null;
  revokedBy: string | null;
  firstOpenedAt: string | null;
  lastOpenedAt: string | null;
  openCount: number;
  /** SHA-256 of the current guest session's id: a new exchange replaces it, ending the guest session before. */
  sessionHash: string | null;
  /** The waiting room for the CURRENT guest session (admission.ts): a new exchange starts it again at not-knocked. */
  admissionState: AdmissionState;
  knockedAt: string | null;
  admissionDecidedAt: string | null;
}

export type NewInvite = Pick<Invite, 'interviewId' | 'tokenHash' | 'issuedBy' | 'issuedAt' | 'expiresAt'>;

export interface InviteStore {
  /** Revoke the interview's live invite (at `issuedAt`, by `issuedBy`) and insert this one, in one write. */
  issueInvite(input: NewInvite): Promise<Invite>;
  /** The invite whose token hashes to `tokenHash`, revoked or not; null when none. */
  findInviteByHash(tokenHash: string): Promise<Invite | null>;
  getInvite(id: string): Promise<Invite | null>;
  /** The interview's most recently issued invite, live or not. */
  latestInvite(interviewId: string): Promise<Invite | null>;
  /** Revoke the interview's live invite; answers the latest invite afterwards (null when it never had one). */
  revokeInvite(interviewId: string, at: string, by: string): Promise<Invite | null>;
  /** Record an opening and make `sessionHash` the one live guest session. Null when revoked or gone. */
  recordOpening(id: string, at: string, sessionHash: string): Promise<Invite | null>;
  /**
   * The waiting room's one write (admission.ts): move the live invite's admission from `was` to `next`, only while
   * `sessionHash` is still its guest session and the admission is still `was`. Null when any of that changed.
   */
  setAdmission(id: string, sessionHash: string, was: AdmissionState, next: Pick<Invite, 'admissionState' | 'knockedAt' | 'admissionDecidedAt'>): Promise<Invite | null>;
}

/** Latest first: issued_at DESC, id DESC — the SQL statements' ORDER BY, in code. */
const latestFirst = (a: Invite, b: Invite) => b.issuedAt.localeCompare(a.issuedAt) || b.id.localeCompare(a.id);
const copy = (row: Invite | undefined | null): Invite | null => (row ? structuredClone(row) : null);

export class MemoryInviteStore implements InviteStore {
  private rows(): Invite[] { return interviewInvitesFixture.rows(); }

  async issueInvite(input: NewInvite): Promise<Invite> {
    for (const r of this.rows()) {
      if (r.interviewId === input.interviewId && r.revokedAt === null) { r.revokedAt = input.issuedAt; r.revokedBy = input.issuedBy; }
    }
    const row: Invite = {
      id: newInviteId(), ...structuredClone(input),
      revokedAt: null, revokedBy: null, firstOpenedAt: null, lastOpenedAt: null, openCount: 0, sessionHash: null,
      admissionState: 'not-knocked', knockedAt: null, admissionDecidedAt: null,
    };
    this.rows().push(row);
    return structuredClone(row);
  }

  async findInviteByHash(tokenHash: string): Promise<Invite | null> {
    // Every row is compared, matched or not, so the time does not say how far down the list a hash sat.
    let found: Invite | undefined;
    for (const r of this.rows()) if (sameHash(r.tokenHash, tokenHash)) found = r;
    return copy(found);
  }

  async getInvite(id: string): Promise<Invite | null> { return copy(this.rows().find((r) => r.id === id)); }

  async latestInvite(interviewId: string): Promise<Invite | null> {
    return copy(this.rows().filter((r) => r.interviewId === interviewId).sort(latestFirst)[0]);
  }

  async revokeInvite(interviewId: string, at: string, by: string): Promise<Invite | null> {
    for (const r of this.rows()) if (r.interviewId === interviewId && r.revokedAt === null) { r.revokedAt = at; r.revokedBy = by; }
    return this.latestInvite(interviewId);
  }

  async recordOpening(id: string, at: string, sessionHash: string): Promise<Invite | null> {
    const r = this.rows().find((x) => x.id === id);
    if (!r || r.revokedAt !== null) return null;
    r.firstOpenedAt ??= at;
    r.lastOpenedAt = at;
    r.openCount += 1;
    r.sessionHash = sessionHash;
    r.admissionState = 'not-knocked';
    r.knockedAt = null;
    r.admissionDecidedAt = null;
    return structuredClone(r);
  }

  async setAdmission(id: string, sessionHash: string, was: AdmissionState, next: Pick<Invite, 'admissionState' | 'knockedAt' | 'admissionDecidedAt'>): Promise<Invite | null> {
    const r = this.rows().find((x) => x.id === id);
    if (!r || r.revokedAt !== null || r.sessionHash !== sessionHash || (r.admissionState ?? 'not-knocked') !== was) return null;
    r.admissionState = next.admissionState;
    r.knockedAt = next.knockedAt;
    r.admissionDecidedAt = next.admissionDecidedAt;
    return structuredClone(r);
  }
}

let current: InviteStore | null = null;

export function createInviteStore(): InviteStore {
  if (config.mock?.aurora) return new MemoryInviteStore();
  // Loaded on first use so a mock process never pulls in the AWS client.
  return new SqlInviteStore(async (sql, params) => (await import('../../../providers/aurora.js')).exec(sql, params));
}

export function inviteStore(): InviteStore { return (current ??= createInviteStore()); }
export function setInviteStore(next: InviteStore | null): void { current = next; }
