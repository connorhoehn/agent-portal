// Native PostgreSQL contracts for the interviews tenant's SQL stores (docs/interviews-tenant-plan.md; the `sql` lines of the
// hardening pass), against a dedicated disposable PostgreSQL 16 container. Only the RDS Data API transport is replaced: the
// unmodified schema files load in order, and every store runs its exact statements through `pgExec` below, which binds the
// Data API's `:name` parameters as literals and hands rows back in the Data API's shapes (JSONB and NUMERIC as text, integers
// as numbers, booleans, TEXT[] as arrays, TIMESTAMPTZ as 'YYYY-MM-DD HH:MM:SS' in UTC). Each call is its own psql process,
// so the parallel calls below are real concurrent transactions. This does NOT establish Aurora, IAM or Data API binding.
//
//   REAL_INTERVIEWS_POSTGRES=1 ORGIQ_INTERVIEWS_POSTGRES_CONTAINER=<name> \
//   [ORGIQ_DOCKER='colima ssh -- sudo docker'] npx jest src/lib/interviews/__tests__/interviews-postgres.test.ts --runInBand
//
// The container must carry the label orgiq.validation=interviews-postgres. The suite drops and recreates the database
// `interviews_validation` inside it and creates the cluster's service roles there (schema/service_roles.sql).
// NOTHING ELSE may run jest against that Postgres while this suite runs: no second copy of this suite, no other gated
// *-postgres suite pointed at the same container. Run it alone, with --runInBand.
//
// The container needs the vector extension (the schema creates it): pgvector/pgvector:pg16, not the plain postgres image.
// Written by the hardening pass on a machine without Docker; first run green with Milo's interview tools. Each describe
// names the OWED line it answers.
jest.mock('../../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: false }, meetingAssistant: { enabled: true } } }));
jest.mock('../../../providers/identity.js', () => ({
  ...jest.requireActual('../../../providers/identity.js'),
  listUsers: jest.fn(async () => [
    { id: 'u-greta', displayName: 'Greta Lindqvist' }, { id: 'u-hugo', displayName: 'Hugo Marchetti' },
    { id: 'u-wen', displayName: 'Wen Zhao' }, { id: 'u-amara', displayName: 'Amara Okafor' },
  ]),
}));

import { execFile, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { SqlParameter } from '@aws-sdk/client-rds-data';

const enabled = process.env['REAL_INTERVIEWS_POSTGRES'] === '1';
const container = process.env['ORGIQ_INTERVIEWS_POSTGRES_CONTAINER'] ?? '';
const docker = (process.env['ORGIQ_DOCKER'] ?? 'docker').split(' ').filter(Boolean);
const DB = 'interviews_validation';
const read = (name: string) => readFileSync(`${process.cwd()}/../schema/${name}`, 'utf8');
const NULL = '__PG_NULL__';
const MARK = '__interviews_pg_rows__';

/** The schema files in the order a cluster takes them: every repeatable entry of schema/manifest.json in its load order
 * (what schema/load_schema.py applies), with the demo identities after the identity schema as the seed run puts them. A
 * hand-picked subset hid that spend_holds.initiative_id is nullable only after user_budgets_schema.sql. */
const MANIFEST = JSON.parse(read('manifest.json')) as { entries: Array<{ file: string; kind: string }> };
const SCHEMA_FILES = MANIFEST.entries.filter((e) => e.kind === 'repeatable').map((e) => e.file)
  .flatMap((f) => (f === 'identity_schema.sql' ? [f, 'seed_demo_identities.sql'] : [f]));
const INTERVIEW_TABLES = [
  'interview_runs', 'interview_pad_events', 'interview_board_snapshots', 'interview_panel_notices', 'interview_deletions', 'interview_invites', 'interview_said_log', 'interview_milo_settings',
  'interview_coach_log', 'interview_scorecards', 'interview_recap_opens', 'interview_recap_attempts', 'interview_recaps', 'interview_suggestions', 'interview_consents',
  'interviews', 'interview_applications', 'interview_resumes', 'interview_candidates', 'interview_openings',
];

const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;

function psql(input: string, db = DB): Promise<string> {
  const args = [...docker.slice(1), 'exec', '-i', container, 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '--csv', '-P', `null=${NULL}`, '-U', 'postgres', '-d', db];
  return new Promise((resolve, reject) => {
    const child = execFile(docker[0]!, args, { maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout)));
    child.stdin!.end(`SET TimeZone TO 'UTC'; SET client_min_messages TO warning;\n${input}\n`);
  });
}

function parseCsv(text: string): Record<string, string | null>[] {
  const rows: string[][] = []; let row: string[] = []; let field = ''; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (ch === '"') quoted = false; else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [header, ...data] = rows.filter((r) => !(r.length === 1 && r[0] === ''));
  if (!header) return [];
  return data.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] === NULL ? null : r[i] ?? null])));
}

/** The Data API's parameters, bound as literals (each store uses only these four kinds). */
function bindParams(statement: string, params: readonly SqlParameter[] = []): string {
  const byName = new Map(params.map((p) => [p.name!, p.value!]));
  return statement.replace(/(?<!:):([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, name: string) => {
    const v = byName.get(name);
    if (!v) throw new Error(`Unbound parameter ${name}`);
    if (v.isNull) return 'NULL';
    if (v.stringValue !== undefined) return literal(v.stringValue);
    if (v.longValue !== undefined) return String(Math.trunc(v.longValue));
    if (v.booleanValue !== undefined) return v.booleanValue ? 'TRUE' : 'FALSE';
    throw new Error(`Parameter ${name} has a kind the stores do not send`);
  });
}

/** `{a,"b c"}` → ['a', 'b c']. */
function pgArray(text: string): string[] {
  const inner = text.slice(1, -1);
  if (!inner) return [];
  const out: string[] = []; let field = ''; let quoted = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (quoted) { if (ch === '\\') { field += inner[++i]; } else if (ch === '"') quoted = false; else field += ch; }
    else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(field); field = ''; }
    else field += ch;
  }
  out.push(field);
  return out;
}

/** One cell as the Data API's `readField` would hand it back (providers/aurora.ts). */
function asDataApi(value: string | null, type: string): unknown {
  if (value === null) return null;
  if (/^(integer|bigint|smallint)$/.test(type)) return Number(value);
  if (type === 'boolean') return value === 't';
  if (type.endsWith('[]')) return pgArray(value);
  if (type.startsWith('timestamp')) return value.replace(/\+00$/, '');
  return value; // text, numeric, jsonb, json, uuid: the Data API's stringValue
}

/** The stores' `SqlExec`: run the exact statement on its own connection and return its rows. */
async function pgExec(statement: string, params: SqlParameter[] = []): Promise<Record<string, unknown>[]> {
  const bound = bindParams(statement, params);
  const out = await psql(`${bound} \\gdesc\n\\echo ${MARK}\n${bound};`);
  const at = out.indexOf(`${MARK}\n`);
  const types = new Map(parseCsv(out.slice(0, at)).map((r) => [String(r['Column']), String(r['Type'])]));
  return parseCsv(out.slice(at + MARK.length + 1)).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, asDataApi(v, types.get(k) ?? 'text')])));
}
const q = async (sql: string) => parseCsv(await psql(sql));
const one = async (sql: string) => (await q(sql))[0] ?? {};

// ── the stores under test, each over pgExec ─────────────────────────────────
import { SqlInterviewsStore } from '../store-sql.js';
import { DuplicateCandidateError } from '../store.js';
import { setInterviewsStore } from '../store-select.js';
import { SqlInviteStore } from '../invite/store-sql.js';
import { SqlConsentStore } from '../consent/store-sql.js';
import { SqlSuggestionStore } from '../coach/store-sql.js';
import { setSuggestionStore } from '../coach/store.js';
import { SqlCoachLogStore } from '../milo-notes/store-sql.js';
import { SqlRecapStore } from '../recap/store-sql.js';
import { SqlSaidStore } from '../speak/store-sql.js';
import { SqlMiloSettingsStore } from '../milo-settings.js';
import { SqlPadLogStore } from '../pad/log/store-sql.js';
import { SqlRunStore } from '../runs/store-sql.js';
import { SqlDeletionStore } from '../retention/store-sql.js';
import { SqlRecordStatements, REDACT_CANDIDATE_SQL, REDACT_STAGE_REASONS_SQL } from '../retention/records.js';
import { REDACTED_CONTACT, REDACTED_REASON } from '../retention/rules.js';
import { SqlAssistantStore } from '../../meeting-assistant/store-sql.js';
import { setAssistantStore } from '../../meeting-assistant/store-select.js';
import { recordTranscript } from '../record/transcript.js';
import { fixtureRegistry } from '../../../mock/core/index.js';
import { interviewCandidatesFixture, interviewApplicationsFixture, interviewOpeningsFixture, interviewsFixture, interviewScorecardsFixture } from '../../../mock/interviews.js';
import { interviewConsentsFixture } from '../../../mock/interviews-consents.js';
import { interviewSuggestionsFixture } from '../../../mock/interviews-suggestions.js';
import { interviewCoachLogFixture } from '../../../mock/interviews-coach-log.js';
import { interviewRecapsFixture } from '../../../mock/interviews-recaps.js';
import { interviewPadLogFixture } from '../../../mock/interviews-pad-log.js';
import { interviewRunsFixture } from '../../../mock/interviews-runs.js';
import type { Application, Candidate } from '../types.js';

const interviews = new SqlInterviewsStore(pgExec);
const invites = new SqlInviteStore(pgExec);
const consents = new SqlConsentStore(pgExec);
const suggestions = new SqlSuggestionStore(pgExec);
const coachLog = new SqlCoachLogStore(pgExec);
const recaps = new SqlRecapStore(pgExec);
const said = new SqlSaidStore(pgExec);
const miloSettings = new SqlMiloSettingsStore(pgExec);
const pad = new SqlPadLogStore(pgExec);
const runs = new SqlRunStore(pgExec);
const deletions = new SqlDeletionStore(pgExec);
const records = new SqlRecordStatements(pgExec);
const assistant = new SqlAssistantStore(pgExec);

const MATEO_CODING = 'iv-j6x2d9sb';
const KWAME_LIVE = 'iv-s4e8u2zk';
const T0 = '2026-11-17T10:00:00.000Z';
const at = (minutes: number) => new Date(Date.parse(T0) + minutes * 60_000).toISOString();

/** The mock world's seed, written through the SQL store's own inserts: the same rows both stores start from. */
async function seedWorld(): Promise<void> {
  await psql(`TRUNCATE ${INTERVIEW_TABLES.join(', ')} CASCADE;`);
  fixtureRegistry.resetAll('default');
  for (const o of interviewOpeningsFixture.rows()) {
    const { revision: _r, ...rest } = o;
    expect(await interviews.createOpening(rest)).not.toBeNull();
  }
  const apps = interviewApplicationsFixture.rows();
  for (const c of interviewCandidatesFixture.rows()) {
    const mine = apps.filter((a) => a.candidateId === c.id);
    expect(mine).toHaveLength(1); // the seed gives each candidate one application; createCandidate writes both at once
    expect(await interviews.createCandidate(c, mine[0]!)).not.toBeNull();
  }
  for (const i of interviewsFixture.rows()) expect(await interviews.createInterview({ ...i, revision: 1 })).not.toBeNull();
  for (const s of interviewScorecardsFixture.rows()) expect((await interviews.addScorecardVersion(s)).ok).toBe(true);
}

(enabled ? describe : describe.skip)('the interviews tenant on native PostgreSQL 16', () => {
  jest.setTimeout(600_000);

  beforeAll(async () => {
    if (!container) throw new Error('ORGIQ_INTERVIEWS_POSTGRES_CONTAINER is required');
    const owned = execFileSync(docker[0]!, [...docker.slice(1), 'inspect', '--format', '{{index .Config.Labels "orgiq.validation"}}', container], { encoding: 'utf8' });
    if (owned.trim() !== 'interviews-postgres') throw new Error('Refusing a container without the dedicated acceptance label');
    await psql(`DROP DATABASE IF EXISTS ${DB}; CREATE DATABASE ${DB};`, 'postgres');
    await psql('CREATE EXTENSION IF NOT EXISTS pgcrypto;');
    for (const file of SCHEMA_FILES) {
      try { await psql(read(file)); } catch (e) { throw new Error(`${file} did not load: ${(e as Error).message.split('\n')[0]}`); }
    }
    for (const file of ['service_roles.sql', 'graph_readonly_role.sql', 'row_level_security.sql']) { // the seed's order (schema/apply_all_seed.py ROLE_FILES)
      try { await psql(read(file)); } catch (e) { throw new Error(`${file} did not load: ${(e as Error).message.split('\n')[0]}`); }
    }
    setInterviewsStore(interviews);
    setSuggestionStore(suggestions);
    setAssistantStore(assistant);
  });
  afterAll(() => { setInterviewsStore(null); setSuggestionStore(null); setAssistantStore(null); });
  beforeEach(seedWorld);

  it('loads the tenant file a second time as a no-op, and the SQL store reads back the world the memory store starts from', async () => {
    await psql(read('interviews_schema.sql'));
    const [o, c, a, i, s] = await Promise.all([interviews.listOpenings(), interviews.listCandidates(), interviews.listApplications(), interviews.listInterviews(), interviews.listScorecards()]);
    expect(o.map((x) => x.id).sort()).toEqual(interviewOpeningsFixture.rows().map((x) => x.id).sort());
    expect(c).toHaveLength(interviewCandidatesFixture.rows().length);
    expect(a.find((x) => x.id === 'app-7b69njmx')!.history).toEqual(interviewApplicationsFixture.rows().find((x) => x.id === 'app-7b69njmx')!.history);
    const live = i.find((x) => x.id === KWAME_LIVE)!;
    expect(live).toMatchObject({ state: 'live', panelIds: interviewsFixture.rows().find((x) => x.id === KWAME_LIVE)!.panelIds, revision: 1 });
    expect(s).toHaveLength(interviewScorecardsFixture.rows().length);
  });

  describe('O-010 the spend source and the cap columns (I0.6)', () => {
    it('holds and the ledger take the source `interviews` and refuse an unknown one', async () => {
      await psql(`INSERT INTO spend_holds (source, source_id, amount_usd, basis, expires_at) VALUES ('interviews', 'iv-x:run-1', 0.0017, 'p75', now() + interval '1 hour');`);
      await expect(psql(`INSERT INTO spend_holds (source, source_id, amount_usd, basis, expires_at) VALUES ('interviewz', 'x', 1, 'p75', now());`)).rejects.toThrow(/check constraint/);
      await psql(`INSERT INTO spend_entries (source, source_id, cost_usd, cost_basis) VALUES ('interviews', 'iv-x:run-1', 0.0017, 'estimated');`);
      await expect(psql(`INSERT INTO spend_entries (source, source_id, cost_usd, cost_basis) VALUES ('interviewz', 'x', 1, 'estimated');`)).rejects.toThrow(/check constraint/);
      await psql(`DELETE FROM spend_entries WHERE source = 'interviews'; DELETE FROM spend_holds WHERE source = 'interviews';`);
    });
    it('an opening\'s two caps round-trip to the cent through NUMERIC(10,2), null means none, and a stale revision writes nothing', async () => {
      const ios = (await interviews.listOpenings()).find((x) => x.id === 'op-ios')!;
      const { id: _i, recruiterId: _r, openedAt: _o, kit: _k, revision, ...details } = ios;
      const w = await interviews.updateOpeningDetails('op-ios', { ...details, budgetCapUsd: 100, interviewCapUsd: 8.5 }, revision);
      expect(w).toMatchObject({ ok: true, row: { budgetCapUsd: 100, interviewCapUsd: 8.5, revision: revision + 1 } });
      expect(await one(`SELECT budget_cap_usd::text AS b, interview_cap_usd::text AS i FROM interview_openings WHERE id = 'op-ios'`)).toEqual({ b: '100.00', i: '8.50' });
      const cleared = await interviews.updateOpeningDetails('op-ios', { ...details, budgetCapUsd: null, interviewCapUsd: null }, revision + 1);
      expect(cleared).toMatchObject({ ok: true, row: { budgetCapUsd: null, interviewCapUsd: null } });
      expect(await interviews.updateOpeningDetails('op-ios', { ...details, budgetCapUsd: 5 }, revision)).toMatchObject({ ok: false, reason: 'stale' });
      await expect(interviews.updateOpeningDetails('op-ios', { ...details, budgetCapUsd: 123456789012 }, revision + 2)).rejects.toThrow(/numeric field overflow/);
    });
  });

  describe('O-020 the assignment statements (jsonb_array_elements_text) (I1.4)', () => {
    it('a panel and the questions travel as JSON text and land as TEXT[] in order; an empty list is an empty array', async () => {
      const base = interviewsFixture.rows().find((x) => x.id === MATEO_CODING)!;
      const made = await interviews.createInterview({ ...base, id: 'iv-pg-assign', panelIds: ['u-wen', 'u-amara'], questionIds: [], state: 'assigned', revision: 1 });
      expect(made).toMatchObject({ panelIds: ['u-wen', 'u-amara'], questionIds: [] });
      expect(await one(`SELECT array_length(panel_ids, 1) AS n, cardinality(question_ids) AS q FROM interviews WHERE id = 'iv-pg-assign'`)).toEqual({ n: '2', q: '0' });
      const moved = await interviews.reassign('iv-pg-assign', { leadId: 'u-wen', panelIds: ['u-hugo'], state: 'assigned', acceptances: [] }, 1);
      expect(moved).toMatchObject({ ok: true, row: { leadId: 'u-wen', panelIds: ['u-hugo'], revision: 2 } });
      const answered = await interviews.answerSeat('iv-pg-assign', { state: 'accepted', panelIds: [], acceptances: [{ userId: 'u-wen', seat: 'lead', at: T0 }], declines: [] } as never, 2);
      expect(answered).toMatchObject({ ok: true, row: { panelIds: [], state: 'accepted', revision: 3 } });
      expect(await interviews.reassign('iv-pg-assign', { leadId: 'u-hugo', panelIds: [], state: 'assigned', acceptances: [] }, 2)).toMatchObject({ ok: false, reason: 'stale' });
      expect(await interviews.reassign('iv-pg-none', { leadId: 'u-hugo', panelIds: [], state: 'assigned', acceptances: [] }, 1)).toEqual({ ok: false, reason: 'not-found' });
    });
  });

  describe('O-037 SET_QUESTIONS_SQL (I1.7)', () => {
    it('sets the chosen questions in order with the state, once per revision', async () => {
      const iv = (await interviews.getInterview('iv-k1p5w8ra'))!;
      const w = await interviews.setQuestions(iv.id, ['q-b', 'q-a', 'q-c'], 'ready', iv.revision);
      expect(w).toMatchObject({ ok: true, row: { questionIds: ['q-b', 'q-a', 'q-c'], state: 'ready', revision: iv.revision + 1 } });
      expect(await interviews.setQuestions(iv.id, ['q-a'], 'ready', iv.revision)).toMatchObject({ ok: false, reason: 'stale', row: { questionIds: ['q-b', 'q-a', 'q-c'] } });
      const [a, b] = await Promise.all([interviews.setQuestions(iv.id, ['q-1'], 'ready', iv.revision + 1), interviews.setQuestions(iv.id, ['q-2'], 'ready', iv.revision + 1)]);
      expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    });
  });

  describe('O-203 the candidate insert and per-opening email uniqueness, case aside (I1.2, UI r2 DESK-B)', () => {
    const cand = (id: string, email: string): Candidate => ({ id, name: 'Test Person', email, headline: '', location: '', source: 'Careers page', resumeFileId: null, notes: '', createdAt: T0 });
    const app = (id: string, candidateId: string): Application => ({ id, candidateId, openingId: 'op-backend', stage: 'applied', appliedAt: T0, history: [{ stage: 'applied', at: T0, by: 'u-greta', reason: null }] });
    it('writes the candidate and the application in one statement; a taken id writes neither', async () => {
      expect(await interviews.createCandidate(cand('cand-pg-1', 'test.person@example.test'), app('app-pg-1', 'cand-pg-1'))).not.toBeNull();
      expect(await interviews.createCandidate(cand('cand-pg-1', 'other@example.test'), app('app-pg-2', 'cand-pg-1'))).toBeNull();
      expect(await one(`SELECT count(*) AS n FROM interview_applications WHERE id = 'app-pg-2'`)).toEqual({ n: '0' });
    });
    // The route checks the address against the opening's candidates, lower-cased, and then inserts (routes/interviews/
    // candidates.ts); two adds at once both pass that check. The schema's unique index on the opening and the lower-cased
    // address (found by hardening H5) lets one land; the other is thrown as DuplicateCandidateError and writes nothing.
    it('two adds of one address on one opening at once (case aside): only one lands', async () => {
      const results = await Promise.allSettled([
        interviews.createCandidate(cand('cand-pg-a', 'same.person@example.test'), app('app-pg-a', 'cand-pg-a')),
        interviews.createCandidate(cand('cand-pg-b', 'Same.Person@Example.test'), app('app-pg-b', 'cand-pg-b')),
      ]);
      const landed = results.filter((r) => r.status === 'fulfilled' && r.value !== null);
      expect(landed).toHaveLength(1);
      const refused = results.filter((r) => r.status === 'rejected');
      expect(refused).toHaveLength(1);
      expect((refused[0] as PromiseRejectedResult).reason).toBeInstanceOf(DuplicateCandidateError);
      expect(await one(`SELECT count(*) AS n FROM interview_candidates WHERE id IN ('cand-pg-a', 'cand-pg-b')`)).toEqual({ n: '1' });
    });
  });

  describe('O-053 issuing an invite (I2.1) and O-061 the admission writes (I2.2)', () => {
    const issue = (n: number, issuedAt = at(n)) => invites.issueInvite({ interviewId: 'iv-k1p5w8ra', tokenHash: n.toString(16).padStart(64, '0'), issuedBy: 'u-greta', issuedAt, expiresAt: at(n + 60 * 24) });
    it('a new link revokes the live one in the same statement; at most one is live, even when two are issued at once', async () => {
      const first = await issue(1);
      const second = await issue(2);
      expect((await invites.getInvite(first.id))!.revokedAt).not.toBeNull();
      expect((await invites.latestInvite('iv-k1p5w8ra'))!.id).toBe(second.id);
      const raced = await Promise.allSettled([issue(3), issue(4)]);
      expect(raced.some((r) => r.status === 'fulfilled')).toBe(true);
      for (const r of raced) if (r.status === 'rejected') expect(String(r.reason)).toMatch(/duplicate key|unique/);
      expect(await one(`SELECT count(*) AS n FROM interview_invites WHERE interview_id = 'iv-k1p5w8ra' AND revoked_at IS NULL`)).toEqual({ n: '1' });
      await expect(issue(5, 'not a time')).rejects.toThrow();
    });
    it('the knock and the lead\'s answer are compare-and-set on the session and the state it was read in', async () => {
      const inv = await issue(10);
      const opened = (await invites.recordOpening(inv.id, at(11), 'a'.repeat(64)))!;
      expect(opened).toMatchObject({ openCount: 1, admissionState: 'not-knocked' });
      const knock = { admissionState: 'waiting' as const, knockedAt: at(12), admissionDecidedAt: null };
      const [k1, k2] = await Promise.all([
        invites.setAdmission(inv.id, 'a'.repeat(64), 'not-knocked', knock),
        invites.setAdmission(inv.id, 'a'.repeat(64), 'not-knocked', knock),
      ]);
      expect([k1, k2].filter(Boolean)).toHaveLength(1);
      expect(await invites.setAdmission(inv.id, 'b'.repeat(64), 'waiting', { admissionState: 'admitted', knockedAt: at(12), admissionDecidedAt: at(13) })).toBeNull();
      expect(await invites.setAdmission(inv.id, 'a'.repeat(64), 'waiting', { admissionState: 'admitted', knockedAt: at(12), admissionDecidedAt: at(13) }))
        .toMatchObject({ admissionState: 'admitted' });
      await invites.revokeInvite('iv-k1p5w8ra', at(14), 'u-greta');
      expect(await invites.setAdmission(inv.id, 'a'.repeat(64), 'admitted', { admissionState: 'waiting', knockedAt: at(15), admissionDecidedAt: null })).toBeNull();
    });
  });

  describe('O-110 the suggestion log (I3.3)', () => {
    it('appends, lists in order, marks shown once, answers once against the stored row, and erases by interview', async () => {
      const seeded = interviewSuggestionsFixture.rows().filter((r) => r.interviewId === MATEO_CODING);
      for (const r of seeded) await suggestions.appendSuggestion(r);
      const listed = await suggestions.listSuggestions(MATEO_CODING);
      expect(listed.map((r) => r.id)).toEqual([...seeded].sort((a, b) => a.madeAt.localeCompare(b.madeAt) || a.id.localeCompare(b.id)).map((r) => r.id));
      await expect(suggestions.appendSuggestion(seeded[0]!)).rejects.toThrow();
      const fresh = { ...seeded[0]!, id: 'sug-pg-1', shownAt: null, answer: null, answeredAt: null, spoken: false, dropped: null };
      await suggestions.appendSuggestion(fresh);
      const shown = await Promise.all([suggestions.markShown(MATEO_CODING, 'sug-pg-1', at(1)), suggestions.markShown(MATEO_CODING, 'sug-pg-1', at(2))]);
      // Shown once: both calls answer the row, and they agree on when it was first shown.
      expect(shown.every((r) => r !== null)).toBe(true);
      expect(shown[0]!.shownAt).toBe(shown[1]!.shownAt);
      const [a, b] = await Promise.all([
        suggestions.answerSuggestion(MATEO_CODING, 'sug-pg-1', 'ask', at(3)),
        suggestions.answerSuggestion(MATEO_CODING, 'sug-pg-1', 'skip', at(3)),
      ]);
      expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
      expect(await suggestions.eraseSuggestions([MATEO_CODING])).toBe(seeded.length + 1);
      expect(await suggestions.listSuggestions(MATEO_CODING)).toEqual([]);
    });
  });

  describe('O-139 recordTranscript against the SQL store (I5.1)', () => {
    it('reads the interview\'s stored call in any state, in line order, with the speakers named and unattributed lines left out', async () => {
      const lobby = `interviews:interview:${MATEO_CODING}`;
      const invitedAt = Date.parse(T0);
      await assistant.create({
        callId: 'call-pg-mateo', tenant: 'interviews', lobby, initiativeId: null, state: 'listening', invitedBy: 'u-hugo', invitedAt, pausedBy: null,
        leftAt: null, leftBy: null, acked: [], attendees: ['u-hugo'], presentAtInvite: [], requests: 0, linesStored: 0, nextSeq: 1, pendingRequests: [],
      });
      const line = (userId: string | null, text: string, s: number) => assistant.appendLine({ callId: 'call-pg-mateo', userId, participantId: 'p', speakerName: 'x', text, at: invitedAt + s * 1000, captionId: `c${s}` });
      await line('u-hugo', 'Tell me about a rate limiter.', 1);
      await line(null, 'unattributed', 2);
      await line(`guest:${MATEO_CODING}`, 'A token bucket per key.', 3);
      await assistant.transition('call-pg-mateo', { from: ['listening'], to: 'left', by: 'u-hugo', at: invitedAt + 60_000 });
      const t = await recordTranscript({ id: MATEO_CODING, callId: null });
      expect(t).toMatchObject({ callId: 'call-pg-mateo', startedAt: T0 });
      expect(t!.lines.map((l) => [l.side, l.speaker, l.text])).toEqual([
        ['panel', 'Hugo Marchetti', 'Tell me about a rate limiter.'],
        ['candidate', interviewCandidatesFixture.rows().find((c) => c.id === 'cand-rx6tcaqj')!.name, 'A token bucket per key.'],
      ]);
      expect(await recordTranscript({ id: 'iv-k1p5w8ra', callId: null })).toBeNull();
      await psql(`DELETE FROM meeting_assistants WHERE call_id = 'call-pg-mateo';`);
    });
  });

  describe('O-149 the after-call rows: the recap and the lead\'s asks (I5.2)', () => {
    it('one recap per interview (a second put returns the first), opens once per interviewer, the asks append and list by kind; both erase', async () => {
      const recap = interviewRecapsFixture.rows()[0]!;
      const first = await recaps.putRecap(recap);
      expect(first.created).toBe(true);
      const [x, y] = await Promise.all([recaps.putRecap({ ...recap, text: 'another' } as never), recaps.putRecap({ ...recap, text: 'a third' } as never)]);
      expect([x.created, y.created]).toEqual([false, false]);
      expect((await recaps.getRecap(recap.interviewId))).toEqual(first.row);
      const open = { interviewId: recap.interviewId, interviewerId: 'u-hugo', openedAt: T0, ratings: [] } as never;
      const opens = await Promise.all([recaps.putOpen(open), recaps.putOpen(open)]);
      expect(opens.filter((o) => o.created)).toHaveLength(1);
      const asks = interviewCoachLogFixture.rows().filter((r) => r.interviewId === interviewCoachLogFixture.rows()[0]!.interviewId);
      for (const r of asks) await coachLog.append(r);
      expect((await coachLog.list(asks[0]!.interviewId)).map((r) => r.id)).toEqual(asks.map((r) => r.id).sort((a, b) => {
        const ra = asks.find((r) => r.id === a)!; const rb = asks.find((r) => r.id === b)!;
        return ra.askedAt.localeCompare(rb.askedAt) || a.localeCompare(b);
      }));
      expect(await coachLog.list(asks[0]!.interviewId, asks[0]!.kind)).toEqual((await coachLog.list(asks[0]!.interviewId)).filter((r) => r.kind === asks[0]!.kind));
      expect(await recaps.eraseRecaps([recap.interviewId])).toBeGreaterThanOrEqual(1);
      expect(await recaps.listOpens(recap.interviewId)).toEqual([]);
      expect(await coachLog.erase([asks[0]!.interviewId])).toBe(asks.length);
    });
  });

  describe('O-157 two hiring managers racing on basedOn (I5.5)', () => {
    it('two decisions against the same history length at once: one lands, the other is stale with the history as it now is', async () => {
      const app = (await interviews.listApplications()).find((a) => a.id === 'app-7b69njmx')!;
      const change = (reason: string) => ({ stage: 'on-hold' as const, at: T0, by: 'u-amara', reason, decision: 'hold', scorecardsMissing: 0 }) as never;
      const [a, b] = await Promise.all([interviews.decideStage(app.id, change('First.'), app.history.length), interviews.decideStage(app.id, change('Second.'), app.history.length)]);
      expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
      const loser = a.ok ? b : a;
      expect(loser).toMatchObject({ ok: false, reason: 'stale' });
      expect((loser as { row: Application }).row.history).toHaveLength(app.history.length + 1);
      const now = (await interviews.listApplications()).find((x) => x.id === app.id)!;
      expect(now.history).toHaveLength(app.history.length + 1);
      expect(now.stage).toBe('on-hold');
    });
  });

  describe('O-178 JSONB, string_to_array, the redaction and the row-level rules (I6.3)', () => {
    it('the deletion log keeps its interview ids as JSONB, coverage reads them back by reason, and an update is compare-and-set', async () => {
      const row = await deletions.insert({ id: 'del-pg-1', candidateId: 'cand-rx6tcaqj', interviewIds: [MATEO_CODING, 'iv-k1p5w8ra'], reason: 'request',
        requestedAt: T0, requestedBy: 'u-greta', dueBy: at(30 * 24 * 60), doneAt: null, removed: [], left: [{ kind: 'recording', why: 'pending', retry: true }], attempts: 0 });
      expect(row).toMatchObject({ interviewIds: [MATEO_CODING, 'iv-k1p5w8ra'], revision: 1 });
      await deletions.insert({ ...row, id: 'del-pg-2', reason: 'media-period', interviewIds: ['iv-d7q4n9xe'] });
      const cov = await deletions.coverage(['request', 'record-period']);
      expect([...cov.keys()].sort()).toEqual([MATEO_CODING, 'iv-k1p5w8ra'].sort());
      expect((await deletions.coverage(['media-period'])).has('iv-d7q4n9xe')).toBe(true);
      const [u1, u2] = await Promise.all([
        deletions.update('del-pg-1', { doneAt: at(1), removed: [{ kind: 'pad-log', count: 3 }], left: [], attempts: 1 }, 1),
        deletions.update('del-pg-1', { doneAt: null, removed: [], left: [{ kind: 'recording', why: 'failed', retry: true }], attempts: 1 }, 1),
      ]);
      expect([u1.ok, u2.ok].filter(Boolean)).toHaveLength(1);
      expect((await deletions.open(10)).map((r) => r.id)).toEqual(u1.ok ? ['del-pg-2'] : ['del-pg-1', 'del-pg-2']);
    });
    it('the erase statements take a comma-joined id list through string_to_array and touch those interviews only', async () => {
      for (const r of interviewPadLogFixture.rows()) if (r.interviewId === MATEO_CODING || r.interviewId === KWAME_LIVE) await pad.append(r.interviewId, [r]);
      const mateo = (await pad.counts(MATEO_CODING)).events;
      expect(await pad.erase([MATEO_CODING, 'iv-none'])).toBe(mateo);
      expect((await pad.counts(KWAME_LIVE)).events).toBeGreaterThan(0);
      expect(await records.eraseConsents([MATEO_CODING])).toBe(0);
    });
    it('the redaction takes the contact details out once and every stage reason, in order, and is a no-op the second time', async () => {
      expect(await records.redactCandidate('cand-rx6tcaqj')).toBe(1);
      expect(await records.redactCandidate('cand-rx6tcaqj')).toBe(0);
      expect(await one(`SELECT name, email, headline, location, notes, source FROM interview_candidates WHERE id = 'cand-rx6tcaqj'`))
        .toMatchObject({ ...REDACTED_CONTACT, source: interviewCandidatesFixture.rows().find((c) => c.id === 'cand-rx6tcaqj')!.source });
      const before = interviewApplicationsFixture.rows().find((a) => a.id === 'app-7b69njmx')!.history;
      expect(await records.redactStageReasons('cand-rx6tcaqj')).toBe(1);
      const after = (await interviews.listApplications()).find((a) => a.id === 'app-7b69njmx')!.history;
      expect(after.map((h) => h.stage)).toEqual(before.map((h) => h.stage));
      expect(after.map((h) => h.reason)).toEqual(before.map((h) => (h.reason === null ? null : REDACTED_REASON)));
      expect(await records.redactStageReasons('cand-rx6tcaqj')).toBe(0);
      expect(REDACT_CANDIDATE_SQL).toContain('NOT (name = :name AND email = :email)');
      expect(REDACT_STAGE_REASONS_SQL).toContain('WITH ORDINALITY');
    });
    it('the middleware\'s role reads the tenant\'s rows only with the interviews tenant set, and cannot write them under another tenant', async () => {
      // SET LOCAL, not SELECT set_config(...): psql would print set_config's own row first and the count after it.
      const as = (tenant: string, sql: string) => psql(`BEGIN; SET LOCAL ROLE orgiq_app_middleware; SET LOCAL app.tenant = ${literal(tenant)}; ${sql}; COMMIT;`);
      // A row in each store this suite writes, so the check below reads real rows and is not 0 = 0 on an empty table.
      for (const r of interviewSuggestionsFixture.rows().slice(0, 1)) await suggestions.appendSuggestion(r);
      for (const r of interviewCoachLogFixture.rows().slice(0, 1)) await coachLog.append(r);
      await recaps.putRecap(interviewRecapsFixture.rows()[0]!);
      await pad.append(MATEO_CODING, [{ ...interviewPadLogFixture.rows().find((r) => r.interviewId === MATEO_CODING)!, at: at(1), clientAt: at(1) }]);
      await runs.insertRun({ ...interviewRunsFixture.rows()[0]!, interviewId: KWAME_LIVE, runId: 'run-pg-rls', status: 'queued', startedAt: null, endedAt: null, result: null, events: [] });
      await said.append({ id: 'said-pg-rls', interviewId: KWAME_LIVE, callId: null, kind: 'question', source: 'kit', questionId: 'q-1', suggestionId: null,
        text: 'Walk me through it.', askedBy: 'u-hugo', saidAt: at(1), posted: false, spoken: false });
      await invites.issueInvite({ interviewId: 'iv-k1p5w8ra', tokenHash: 'c'.repeat(64), issuedBy: 'u-greta', issuedAt: at(1), expiresAt: at(60) });
      // The lead's pad-help switch: set, read back, the last change wins.
      await miloSettings.setCandidateMayAsk(KWAME_LIVE, true, 'u-hugo', at(1));
      expect(await miloSettings.setCandidateMayAsk(KWAME_LIVE, false, 'u-hugo', at(2))).toMatchObject({ candidateMayAsk: false, updatedBy: 'u-hugo' });
      expect((await miloSettings.get(KWAME_LIVE)).candidateMayAsk).toBe(false);
      await deletions.insert({ id: 'del-pg-rls', candidateId: 'cand-rx6tcaqj', interviewIds: [MATEO_CODING], reason: 'request', requestedAt: T0, requestedBy: 'u-greta',
        dueBy: at(30 * 24 * 60), doneAt: null, removed: [], left: [], attempts: 0 });
      const empty: string[] = [];
      for (const table of INTERVIEW_TABLES) {
        // Every table: row-level security on, and the tenant policy for the middleware's role.
        expect([table, await one(`SELECT c.relrowsecurity::text AS rls, (SELECT count(*) FROM pg_policies p WHERE p.tablename = c.relname
          AND p.policyname = 'tenant_isolation' AND 'orgiq_app_middleware' = ANY (p.roles))::text AS policies FROM pg_class c WHERE c.relname = ${literal(table)} AND c.relkind = 'r'`)])
          .toEqual([table, { rls: 'true', policies: '1' }]);
        const seen = parseCsv(await as('interviews', `SELECT count(*) AS n FROM ${table}`)).find((r) => r['n'] !== undefined);
        const hidden = parseCsv(await as('orgiq', `SELECT count(*) AS n FROM ${table}`)).find((r) => r['n'] !== undefined);
        const total = await one(`SELECT count(*) AS n FROM ${table}`);
        expect([table, seen?.['n']]).toEqual([table, total['n']]);
        expect([table, hidden?.['n']]).toEqual([table, '0']);
        if (total['n'] === '0') empty.push(table);
      }
      // Only the tables no store here writes may be read empty (their rule is still checked in the catalog above).
      expect(empty).toEqual(INTERVIEW_TABLES.filter((t) => ['interview_panel_notices', 'interview_recap_opens', 'interview_recap_attempts', 'interview_resumes', 'interview_consents'].includes(t))
        .filter((t) => empty.includes(t)));
      expect(INTERVIEW_TABLES.length - empty.length).toBeGreaterThanOrEqual(13);
      await expect(as('orgiq', `INSERT INTO interview_deletions (id, candidate_id, interview_ids, reason, requested_at, due_by, removed, left_behind, attempts, revision)
        VALUES ('del-pg-x', 'cand-rx6tcaqj', '[]', 'request', now(), now(), '[]', '[]', 0, 1)`)).rejects.toThrow(/row-level security/);
    });
  });

  describe('O-226 the said log (I3.5, UI r2 SPEAK)', () => {
    it('appends once, lists oldest first, marks posted and spoken once, and erases by interview', async () => {
      const row = (id: string, saidAt: string) => ({ id, interviewId: KWAME_LIVE, callId: null, kind: 'question' as const, source: 'kit' as const, questionId: 'q-1',
        suggestionId: null, text: 'Walk me through it.', askedBy: 'u-hugo', saidAt, posted: false, spoken: false });
      await said.append(row('said-pg-2', at(2)));
      await said.append(row('said-pg-1', at(1)));
      await expect(said.append(row('said-pg-1', at(3)))).rejects.toThrow();
      expect((await said.list(KWAME_LIVE)).map((r) => r.id)).toEqual(['said-pg-1', 'said-pg-2']);
      const [m1, m2] = await Promise.all([said.markSpoken(KWAME_LIVE, 'said-pg-1'), said.markSpoken(KWAME_LIVE, 'said-pg-1')]);
      expect(m1?.spoken && m2?.spoken).toBe(true);
      expect(await said.markSpoken(KWAME_LIVE, 'said-none')).toBeNull();
      expect(await said.markPosted(KWAME_LIVE, 'said-pg-2')).toMatchObject({ id: 'said-pg-2', posted: true, spoken: false });
      expect((await said.list(KWAME_LIVE)).map((r) => r.posted)).toEqual([false, true]);
      expect(await said.erase([KWAME_LIVE])).toBe(2);
    });
  });

  describe('O-245 the pad log: two posts at once keep one growing seq (I4.3)', () => {
    it('concurrent appends never repeat or skip a number; the losing post is tried again on the new last seq', async () => {
      const ev = (n: number) => ({ ...interviewPadLogFixture.rows().find((r) => r.interviewId === MATEO_CODING)!, at: at(n), clientAt: at(n) });
      const posts = await Promise.all(Array.from({ length: 6 }, (_, i) => pad.append('iv-k1p5w8ra', [ev(i), ev(i)])));
      const seqs = posts.flat().map((r) => r.seq).sort((a, b) => a - b);
      expect(seqs).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
      expect(await pad.counts('iv-k1p5w8ra')).toMatchObject({ events: 12, lastSeq: 12 });
      expect((await pad.listAfter('iv-k1p5w8ra', 10, 5)).map((r) => r.seq)).toEqual([11, 12]);
    });
  });

  describe("Milo's interview tools: the said sources, spoken_part, the pad's Milo side and kinds, the settings row", () => {
    it('takes the tool sources and refuses an unknown one; a part mark keeps the heard words, bounded, and never lands on a spoken line', async () => {
      const IV = 'iv-r6d1k9wt'; // no other said rows
      const row = (id: string, source: 'tests' | 'imports' | 'helper' | 'ack' | 'intro', n: number) => ({ id, interviewId: IV, callId: null,
        kind: 'answer' as const, source, questionId: null, suggestionId: null, text: `Line ${id}.`, askedBy: 'u-hugo', saidAt: at(n), posted: false, spoken: false });
      const sources = ['tests', 'imports', 'helper', 'ack', 'intro'] as const;
      for (const [i, source] of sources.entries()) await said.append(row(`said-milo-${source}`, source, i + 1));
      await expect(said.append({ ...row('said-milo-bad', 'tests', 9), source: 'bogus' as never })).rejects.toThrow();
      expect((await said.list(IV)).map((r) => r.source)).toEqual([...sources]);
      expect(await said.markSpokenPart(IV, 'said-milo-tests', 'Added twelve')).toMatchObject({ id: 'said-milo-tests', spoken: false, spokenPart: 'Added twelve' });
      expect((await said.markSpokenPart(IV, 'said-milo-imports', 'x'.repeat(2000)))?.spokenPart).toHaveLength(1500);
      await said.markSpoken(IV, 'said-milo-helper');
      expect(await said.markSpokenPart(IV, 'said-milo-helper', 'Added')).toBeNull();
      const byId = new Map((await said.list(IV)).map((r) => [r.id, r]));
      expect(byId.get('said-milo-helper')).toMatchObject({ spoken: true });
      expect(byId.get('said-milo-helper')!.spokenPart).toBeUndefined();
      expect(byId.get('said-milo-ack')!.spokenPart).toBeUndefined();
      expect(await said.erase([IV])).toBe(sources.length);
    });

    it("appends Milo's tests, imports and helper events, and refuses a side or a kind the log does not know", async () => {
      const base = interviewPadLogFixture.rows().find((r) => r.interviewId === MATEO_CODING)!;
      const ev = (kind: string, n: number, side = 'milo') => ({ ...base, side, kind, whoId: 'milo', at: at(n), clientAt: at(n) }) as typeof base;
      const posted = await pad.append('iv-m8t3h6ng', [ev('tests', 1), ev('imports', 2), ev('helper', 3)]);
      expect(posted.map((r) => [r.seq, r.side, r.kind])).toEqual([[1, 'milo', 'tests'], [2, 'milo', 'imports'], [3, 'milo', 'helper']]);
      await expect(pad.append('iv-m8t3h6ng', [ev('solution', 4)])).rejects.toThrow();
      await expect(pad.append('iv-m8t3h6ng', [ev('tests', 4, 'bot')])).rejects.toThrow();
      expect(await pad.counts('iv-m8t3h6ng')).toMatchObject({ events: 3, lastSeq: 3 });
    });

    it("takes the lead's reveal row (kind reveal, side panel, with its question) and names the revealed question once", async () => {
      const base = interviewPadLogFixture.rows().find((r) => r.interviewId === MATEO_CODING)!;
      const reveal = (n: number) => ({ ...base, side: 'panel', kind: 'reveal', whoId: 'u-hugo', at: at(n), clientAt: at(n), from: null, inserted: null,
        deleted: null, length: null, lines: null, via: null, language: null, text: null, questionId: 'q-be-twitter' }) as typeof base;
      const posted = await pad.append('iv-r6d1k9wt', [reveal(1)]);
      expect(posted.map((r) => [r.side, r.kind, r.questionId])).toEqual([['panel', 'reveal', 'q-be-twitter']]);
      expect(await pad.postedQuestionIds('iv-r6d1k9wt', 'reveal')).toEqual(['q-be-twitter']);
      await pad.erase(['iv-r6d1k9wt']);
    });

    it('reads the default with no row, upserts one row per interview, and two sets at once leave one row holding one of them', async () => {
      const id = 'iv-n5z9f2cq'; // no settings row yet
      expect(await miloSettings.get(id)).toEqual({ candidateMayAsk: false, updatedBy: null, updatedAt: null });
      expect(await miloSettings.setCandidateMayAsk(id, true, 'u-hugo', at(1))).toEqual({ candidateMayAsk: true, updatedBy: 'u-hugo', updatedAt: at(1) });
      await Promise.all([miloSettings.setCandidateMayAsk(id, false, 'u-greta', at(2)), miloSettings.setCandidateMayAsk(id, true, 'u-hugo', at(3))]);
      const now = await miloSettings.get(id);
      expect([{ candidateMayAsk: false, updatedBy: 'u-greta', updatedAt: at(2) }, { candidateMayAsk: true, updatedBy: 'u-hugo', updatedAt: at(3) }]).toContainEqual(now);
      expect((await q(`SELECT COUNT(*)::int AS n FROM interview_milo_settings WHERE interview_id = ${literal(id)}`))[0]).toMatchObject({ n: '1' });
    });
  });

  describe('O-256 the runs store: one row per (interview, runId), finished once (I4.4)', () => {
    it('two inserts of one run id at once: one row, the other told it exists; two finishes at once: one result kept', async () => {
      const seeded = interviewRunsFixture.rows()[0]!;
      const run = { ...seeded, interviewId: KWAME_LIVE, runId: 'run-pg-1', status: 'queued' as const, startedAt: null, endedAt: null, result: null, events: [] };
      const [i1, i2] = await Promise.all([runs.insertRun(run), runs.insertRun(run)]);
      expect([i1.ok, i2.ok].filter(Boolean)).toHaveLength(1);
      expect((i1.ok ? i2 : i1)).toMatchObject({ ok: false, reason: 'exists' });
      expect(await runs.countRuns(KWAME_LIVE)).toBe(1);
      expect((await runs.setStatus(KWAME_LIVE, 'run-pg-1', 'running', at(1)))!.startedAt).toBe(new Date(at(1)).toISOString());
      const [f1, f2] = await Promise.all([
        runs.finishRun(KWAME_LIVE, 'run-pg-1', { ...seeded.result!, exitCode: 0 }, at(2), []),
        runs.finishRun(KWAME_LIVE, 'run-pg-1', { ...seeded.result!, exitCode: 1 }, at(3), []),
      ]);
      expect([f1, f2].filter(Boolean)).toHaveLength(1);
      expect(await runs.setStatus(KWAME_LIVE, 'run-pg-1', 'running', at(4))).toBeNull();
      expect(await runs.listUnfinished()).toEqual([]);
      expect(await runs.eraseRuns([KWAME_LIVE])).toBe(1);
    });
  });

  it('cancel (gap audit §1): a compare-and-set to cancelled with the cancellation as JSONB; a live round also gets ended_at', async () => {
    const before = (await interviews.getInterview('iv-r6d1k9wt'))!;
    const cancellation = { reason: 'rescheduling' as const, note: 'Next week.', by: 'u-greta', at: at(1) };
    const out = await interviews.cancelInterview(before.id, cancellation, before.revision);
    expect(out).toMatchObject({ ok: true, row: { state: 'cancelled', endedAt: before.endedAt, cancellation, revision: before.revision + 1 } });
    expect(await interviews.cancelInterview(before.id, cancellation, before.revision)).toMatchObject({ ok: false, reason: 'stale' });
    const live = (await interviews.getInterview(KWAME_LIVE))!;
    const notHeld = { reason: 'no_show' as const, note: null, by: 'u-hugo', at: at(2) };
    expect(await interviews.cancelInterview(live.id, notHeld, live.revision)).toMatchObject({ ok: true, row: { state: 'cancelled', endedAt: new Date(at(2)).toISOString(), cancellation: notHeld } });
  });

  it('every consent write names its revision: two first answers at once insert one row', async () => {
    const c = interviewConsentsFixture.rows()[0]!;
    await psql(`DELETE FROM interview_consents WHERE interview_id = ${literal(c.interviewId)};`);
    const { history: _h, revision: _r, answeredAt: _a, ...rest } = c;
    const write = { ...rest, entry: c.history[0]! };
    const [a, b] = await Promise.all([consents.saveConsent(write, 0), consents.saveConsent(write, 0)]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect((await consents.getConsent(c.interviewId))!.history).toHaveLength(1);
  });
});

// Static, runs by default: every table of the tenant's schema file has its row-level rule. The hardening pass (H5) found
// `interview_runs` (row I4.4) missing from schema/row_level_security.sql; it now carries the interviews predicate.
describe('the row-level rules cover the interviews tables (static)', () => {
  const tables = [...read('interviews_schema.sql').matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]!);
  const rls = read('row_level_security.sql');
  it('names every table the schema file creates', () => {
    expect(tables.length).toBeGreaterThanOrEqual(17);
    expect(new Set(tables)).toEqual(new Set(INTERVIEW_TABLES));
  });
  it('gives each of them the interviews predicate', () => {
    const missing = tables.filter((t) => !rls.includes(`('${t}',`));
    expect(missing).toEqual([]);
  });
  it('the tables it does cover use the interviews predicate', () => {
    for (const t of tables.filter((x) => rls.includes(`('${x}',`))) {
      expect(new RegExp(`\\('${t}',\\s+'public\\.app_tenant_visible\\(''interviews''\\)'\\)`).test(rls)).toBe(true);
    }
  });
});

