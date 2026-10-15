// The RunbookStore contract: ONE suite, run against RowsRunbookStore always and
// against DynamoRunbookStore when RUNBOOK_DYNAMODB_ENDPOINT is set (DynamoDB
// Local or the managed-nosql-store). The Dynamo leg gets a fresh uniquely
// named table per test and drops it afterwards.
import { randomBytes } from 'node:crypto';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { Runbook, RunbookApplication, RunbookProposal, SessionBrief } from '../types.js';
import { versionOf } from '../version.js';
import { assembleBrief } from '../brief.js';
import { RowsRunbookStore, privateRowSources } from '../store-rows.js';
import { DynamoRunbookStore, createRunbookDynamoClient, dropRunbookTable, ensureRunbookTable, runbookStoreConfig } from '../store-dynamo.js';
import {
  AlreadyExistsError, BriefExistsError, InvalidWriteError, ProposalClosedError, SelfAcceptError, VersionConflictError,
  type RunbookStore,
} from '../store.js';
import { flakyRerunDiff, ssoNewOrigin, tenantCutoverV1, tenantCutoverV2 } from './fixtures/good.js';

const T0 = '2026-10-01T00:00:00.000Z';
const T1 = '2026-10-02T00:00:00.000Z';
const T2 = '2026-10-03T00:00:00.000Z';

const runbook = (id: string, over: Partial<Runbook> = {}): Runbook => ({
  id, scope: { kind: 'initiative', ref: 'p-auth-migration' }, owner_person_id: 'p-001', status: 'published', current_version: 1,
  created_at: T0, updated_at: T0, ...over,
});
const v = (id: string, n: number, doc = tenantCutoverV1) => versionOf({ runbook_id: id, version: n, doc, author: { kind: 'person', id: 'p-001' } });
const proposal = (id: string, over: Partial<RunbookProposal> = {}): RunbookProposal => ({
  id, kind: 'edit', runbook_id: 'rb-a', base_version: 1, proposed: tenantCutoverV2, rationale: 'because', source: { kind: 'person', person_id: 'p-002', lab_experience_ids: [] },
  lint: [], similar: [], status: 'open', decided_by: null, decided_at: null, note: null, merged_into: null, created_at: T0, ...over,
});
const app = (id: string, at: string, over: Partial<RunbookApplication> = {}): RunbookApplication => ({
  id, runbook_id: 'rb-a', version: 1, run_ref: `run-${id}`, brief_id: `brief-run-${id}`, outcome: 'followed', failed_at_step: null, note: null, at, ...over,
});
const brief = (runRef: string, at = T0, framing = ''): SessionBrief =>
  assembleBrief({ run_ref: runRef, assembled_at: at, framing, work_item: null, initiative: null, repo: null, decisions: [], runbooks: [] });

jest.setTimeout(30_000); // the Dynamo leg creates a table per test

interface Backend { name: string; open(): Promise<{ store: RunbookStore; close(): Promise<void> }> }

const backends: Backend[] = [{
  name: 'RowsRunbookStore',
  open: async () => ({ store: new RowsRunbookStore(privateRowSources()), close: async () => undefined }),
}];
const endpoint = process.env['RUNBOOK_DYNAMODB_ENDPOINT']?.trim();
if (endpoint) {
  backends.push({
    name: 'DynamoRunbookStore',
    open: async () => {
      const cfg = { ...runbookStoreConfig({ ...process.env, RUNBOOK_STORE: 'dynamo' }), table: `rbtest-${randomBytes(5).toString('hex')}-runbooks` };
      const client: DynamoDBClient = createRunbookDynamoClient(cfg);
      await ensureRunbookTable(client, cfg.table);
      return { store: new DynamoRunbookStore(client, cfg.table), close: async () => { await dropRunbookTable(client, cfg.table); client.destroy(); } };
    },
  });
}

describe.each(backends)('$name (RunbookStore contract)', ({ open }) => {
  let store: RunbookStore;
  let close: () => Promise<void>;
  beforeEach(async () => { ({ store, close } = await open()); });
  afterEach(async () => { await close(); });

  describe('runbooks and versions', () => {
    it('creates a runbook with its v1 and reads both back as copies', async () => {
      await store.createRunbook(runbook('rb-a'), v('rb-a', 1));
      const r = await store.getRunbook('rb-a');
      expect(r).toEqual(runbook('rb-a'));
      r!.owner_person_id = 'mutated';
      expect((await store.getRunbook('rb-a'))!.owner_person_id).toBe('p-001');
      const got = await store.getVersion('rb-a', 1);
      expect(got!.sha256).toBe(v('rb-a', 1).sha256);
      expect(await store.getVersion('rb-a', 2)).toBeNull();
      expect(await store.getRunbook('nope')).toBeNull();
    });

    it('refuses a duplicate create and a v1 that is not version 1', async () => {
      await store.createRunbook(runbook('rb-a'), v('rb-a', 1));
      await expect(store.createRunbook(runbook('rb-a'), v('rb-a', 1))).rejects.toBeInstanceOf(AlreadyExistsError);
      await expect(store.createRunbook(runbook('rb-b'), v('rb-b', 2))).rejects.toBeInstanceOf(InvalidWriteError);
    });

    it('appends the next version and moves the runbook; ascending history', async () => {
      await store.createRunbook(runbook('rb-a'), v('rb-a', 1));
      await store.putVersion(v('rb-a', 2, tenantCutoverV2), 1, T1);
      const r = await store.getRunbook('rb-a');
      expect(r!.current_version).toBe(2);
      expect(r!.updated_at).toBe(T1);
      expect((await store.listVersions('rb-a')).map((x) => x.version)).toEqual([1, 2]);
    });

    it('fails a stale putVersion and writes nothing', async () => {
      await store.createRunbook(runbook('rb-a'), v('rb-a', 1));
      await store.putVersion(v('rb-a', 2, tenantCutoverV2), 1, T1);
      await expect(store.putVersion(v('rb-a', 2, tenantCutoverV2), 1, T2)).rejects.toBeInstanceOf(VersionConflictError);
      await expect(store.putVersion(v('rb-a', 3), 1, T2)).rejects.toBeInstanceOf(VersionConflictError);
      expect((await store.getRunbook('rb-a'))!.updated_at).toBe(T1);
      expect(await store.listVersions('rb-a')).toHaveLength(2);
      await expect(store.putVersion(v('rb-a', 5), 2, T2)).rejects.toBeInstanceOf(InvalidWriteError);
    });

    it('lets exactly one of two concurrent putVersion calls win', async () => {
      await store.createRunbook(runbook('rb-a'), v('rb-a', 1));
      const results = await Promise.allSettled([
        store.putVersion(v('rb-a', 2, tenantCutoverV2), 1, T1),
        store.putVersion(v('rb-a', 2, ssoNewOrigin), 1, T1),
      ]);
      expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
      expect((await store.listVersions('rb-a')).map((x) => x.version)).toEqual([1, 2]);
    });

    it('putRunbook is conditional on updated_at and cannot move current_version', async () => {
      await store.createRunbook(runbook('rb-a'), v('rb-a', 1));
      await store.putRunbook(runbook('rb-a', { owner_person_id: 'p-009', updated_at: T1 }), T0);
      expect((await store.getRunbook('rb-a'))!.owner_person_id).toBe('p-009');
      await expect(store.putRunbook(runbook('rb-a', { owner_person_id: 'p-010', updated_at: T2 }), T0)).rejects.toBeInstanceOf(VersionConflictError);
      await expect(store.putRunbook(runbook('rb-a', { current_version: 4, updated_at: T2 }), T1)).rejects.toBeInstanceOf(InvalidWriteError);
      await expect(store.putRunbook(runbook('rb-zz'), T0)).rejects.toMatchObject({ code: 'not_found' });
    });

    it('lists by scope, status and text, newest first, with paging', async () => {
      await store.createRunbook(runbook('rb-a', { updated_at: T0 }), v('rb-a', 1, tenantCutoverV1));
      await store.createRunbook(runbook('rb-b', { scope: { kind: 'repo', ref: 'orgiq-auth-service' }, updated_at: T2 }), v('rb-b', 1, ssoNewOrigin));
      await store.createRunbook(runbook('rb-c', { scope: { kind: 'repo', ref: 'orgiq-auth-service' }, status: 'retired', updated_at: T1 }), v('rb-c', 1, flakyRerunDiff));
      expect((await store.listRunbooks()).items.map((r) => r.id)).toEqual(['rb-b', 'rb-c', 'rb-a']);
      expect((await store.listRunbooks({ scope: { kind: 'repo', ref: 'orgiq-auth-service' } })).items.map((r) => r.id)).toEqual(['rb-b', 'rb-c']);
      expect((await store.listRunbooks({ status: ['published'] })).items.map((r) => r.id)).toEqual(['rb-b', 'rb-a']);
      expect((await store.listRunbooks({ text: 'flaky' })).items.map((r) => r.id)).toEqual(['rb-c']);
      expect((await store.listRunbooks({ text: 'saml cognito' })).items.map((r) => r.id)).toEqual(['rb-a']);
      const p1 = await store.listRunbooks({ limit: 2 });
      expect(p1.items.map((r) => r.id)).toEqual(['rb-b', 'rb-c']);
      const p2 = await store.listRunbooks({ limit: 2, cursor: p1.next! });
      expect(p2.items.map((r) => r.id)).toEqual(['rb-a']);
      expect(p2.next).toBeNull();
    });
  });

  describe('proposals', () => {
    beforeEach(async () => { await store.createRunbook(runbook('rb-a'), v('rb-a', 1)); });
    const editInput = (id: string, by = 'p-001', at = T1) => ({ proposal_id: id, decided_by: by, at, version: v('rb-a', 2, tenantCutoverV2) });

    it('stores a proposal, replaces it while open, lists newest first by status and runbook', async () => {
      await store.putProposal(proposal('prop-1', { created_at: T0 }));
      await store.putProposal(proposal('prop-1', { created_at: T0, rationale: 'revised' }));
      await store.putProposal(proposal('prop-2', { created_at: T1, runbook_id: 'rb-other' }));
      expect((await store.getProposal('prop-1'))!.rationale).toBe('revised');
      expect((await store.listProposals()).items.map((p) => p.id)).toEqual(['prop-2', 'prop-1']);
      expect((await store.listProposals({ status: ['open'] })).items).toHaveLength(2);
      expect((await store.listProposals({ status: ['accepted'] })).items).toHaveLength(0);
      expect((await store.listProposals({ runbook_id: 'rb-a' })).items.map((p) => p.id)).toEqual(['prop-1']);
    });

    it('accepts an edit: new version, moved runbook, decided proposal, all stamped', async () => {
      await store.putProposal(proposal('prop-1'));
      const out = await store.acceptProposal({ ...editInput('prop-1'), note: 'ship it' });
      expect(out.proposal).toMatchObject({ status: 'accepted', decided_by: 'p-001', decided_at: T1, note: 'ship it' });
      expect(out.version).toMatchObject({ version: 2, proposal_id: 'prop-1', accepted_by: 'p-001', accepted_at: T1 });
      expect(await store.getRunbook('rb-a')).toMatchObject({ current_version: 2, updated_at: T1 });
      expect((await store.getVersion('rb-a', 2))!.accepted_by).toBe('p-001');
      expect((await store.getProposal('prop-1'))!.status).toBe('accepted');
    });

    it('fails an accept against a stale version (409) and changes nothing', async () => {
      await store.putProposal(proposal('prop-1'));
      await store.putVersion(v('rb-a', 2, ssoNewOrigin), 1, T1); // someone else moved the runbook on
      await expect(store.acceptProposal(editInput('prop-1', 'p-001', T2))).rejects.toBeInstanceOf(VersionConflictError);
      expect((await store.getProposal('prop-1'))!.status).toBe('open');
      expect(await store.listVersions('rb-a')).toHaveLength(2);
      expect((await store.getVersion('rb-a', 2))!.sha256).toBe(v('rb-a', 2, ssoNewOrigin).sha256);
    });

    it('accepts once: the second accept fails, even raced', async () => {
      await store.putProposal(proposal('prop-1'));
      await store.acceptProposal(editInput('prop-1'));
      await expect(store.acceptProposal(editInput('prop-1', 'p-003', T2))).rejects.toBeInstanceOf(ProposalClosedError);

      await store.putProposal(proposal('prop-2', { base_version: 2 }));
      const raced = await Promise.allSettled([
        store.acceptProposal({ proposal_id: 'prop-2', decided_by: 'p-001', at: T2, version: v('rb-a', 3, ssoNewOrigin) }),
        store.acceptProposal({ proposal_id: 'prop-2', decided_by: 'p-003', at: T2, version: v('rb-a', 3, ssoNewOrigin) }),
      ]);
      expect(raced.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect((await store.listVersions('rb-a')).map((x) => x.version)).toEqual([1, 2, 3]);
    });

    it('lets one of two proposals on the same base win; the other conflicts', async () => {
      await store.putProposal(proposal('prop-1'));
      await store.putProposal(proposal('prop-2'));
      const raced = await Promise.allSettled([
        store.acceptProposal(editInput('prop-1')),
        store.acceptProposal({ ...editInput('prop-2'), version: v('rb-a', 2, ssoNewOrigin) }),
      ]);
      expect(raced.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const loser = raced.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(loser.reason).toBeInstanceOf(VersionConflictError);
      expect(await store.listVersions('rb-a')).toHaveLength(2);
    });

    it('never lets a proposer accept their own proposal', async () => {
      await store.putProposal(proposal('prop-1', { source: { kind: 'person', person_id: 'p-002', lab_experience_ids: [] } }));
      await expect(store.acceptProposal(editInput('prop-1', 'p-002'))).rejects.toBeInstanceOf(SelfAcceptError);
      expect((await store.getProposal('prop-1'))!.status).toBe('open');
      await store.acceptProposal(editInput('prop-1', 'p-001')); // someone else can
    });

    it('accepts a new-runbook proposal and a retire proposal', async () => {
      await store.putProposal(proposal('prop-n', { kind: 'new', runbook_id: null, base_version: null }));
      const out = await store.acceptProposal({
        proposal_id: 'prop-n', decided_by: 'p-001', at: T1,
        runbook: runbook('rb-new', { updated_at: T1, created_at: T1 }), version: v('rb-new', 1, flakyRerunDiff),
      });
      expect(out.runbook.id).toBe('rb-new');
      expect(await store.getVersion('rb-new', 1)).toMatchObject({ proposal_id: 'prop-n', accepted_by: 'p-001' });

      await store.putProposal(proposal('prop-r', { kind: 'retire', proposed: null, runbook_id: 'rb-new', base_version: 1 }));
      await store.acceptProposal({ proposal_id: 'prop-r', decided_by: 'p-001', at: T2, retire: { reason: 'superseded', superseded_by: 'rb-a' } });
      expect(await store.getRunbook('rb-new')).toMatchObject({ status: 'retired', retired: { by: 'p-001', reason: 'superseded', superseded_by: 'rb-a' } });
      // a retired runbook keeps its history
      expect(await store.listVersions('rb-new')).toHaveLength(1);
    });

    it('rejects or merges once, and a decided proposal is neither acceptable nor rewritable', async () => {
      await store.putProposal(proposal('prop-1'));
      await store.putProposal(proposal('prop-2'));
      const rej = await store.decideProposal({ proposal_id: 'prop-1', decision: 'rejected', decided_by: 'p-001', at: T1, note: 'no' });
      expect(rej).toMatchObject({ status: 'rejected', decided_by: 'p-001', note: 'no' });
      await expect(store.decideProposal({ proposal_id: 'prop-1', decision: 'rejected', decided_by: 'p-001', at: T2 })).rejects.toBeInstanceOf(ProposalClosedError);
      await expect(store.acceptProposal(editInput('prop-1', 'p-003'))).rejects.toBeInstanceOf(ProposalClosedError);
      await expect(store.putProposal(proposal('prop-1'))).rejects.toBeInstanceOf(AlreadyExistsError);
      const merged = await store.decideProposal({ proposal_id: 'prop-2', decision: 'merged', decided_by: 'p-001', at: T1, merged_into: 'prop-1' });
      expect(merged).toMatchObject({ status: 'merged', merged_into: 'prop-1' });
      await expect(store.decideProposal({ proposal_id: 'nope', decision: 'rejected', decided_by: 'p-001', at: T1 })).rejects.toMatchObject({ code: 'not_found' });
    });
  });

  describe('applications', () => {
    it('lists oldest first, filtered by version, and refuses a duplicate id', async () => {
      await store.appendApplication(app('a2', T2, { version: 2 }));
      await store.appendApplication(app('a1', T1));
      await store.appendApplication(app('a0', T0, { runbook_id: 'rb-other' }));
      expect((await store.listApplications('rb-a')).map((a) => a.id)).toEqual(['a1', 'a2']);
      expect((await store.listApplications('rb-a', 2)).map((a) => a.id)).toEqual(['a2']);
      expect(await store.listApplications('rb-none')).toEqual([]);
      await expect(store.appendApplication(app('a1', T2))).rejects.toBeInstanceOf(AlreadyExistsError);
    });
  });

  describe('session briefs', () => {
    it('freezes a brief per run: same bytes are a no-op, different bytes fail', async () => {
      const b = brief('run-1');
      await store.putBrief(b);
      await store.putBrief(brief('run-1'));
      expect(await store.getBrief('run-1')).toEqual(b);
      await expect(store.putBrief(brief('run-1', T0, 'a different framing'))).rejects.toBeInstanceOf(BriefExistsError);
      expect((await store.getBrief('run-1'))!.sha256).toBe(b.sha256);
      expect(await store.getBrief('run-2')).toBeNull();
    });

    it('lists briefs newest first with paging', async () => {
      await store.putBrief(brief('run-1', T0));
      await store.putBrief(brief('run-2', T2));
      await store.putBrief(brief('run-3', T1));
      const p1 = await store.listBriefs({ limit: 2 });
      expect(p1.items.map((b) => b.run_ref)).toEqual(['run-2', 'run-3']);
      expect((await store.listBriefs({ limit: 2, cursor: p1.next! })).items.map((b) => b.run_ref)).toEqual(['run-1']);
    });
  });
});
