// Opt-in SQL acceptance for the work-comment migration and the comment read
// path against a dedicated disposable PostgreSQL container (the
// work-documents-postgres pattern). Only the RDS Data API transport is
// replaced: the migration's exact SQL (CLAIM_SQL / PENDING_SQL /
// MARK_WRITTEN_SQL) and the provider's audit/people reads execute in
// PostgreSQL over the unmodified schema files. This does NOT establish
// Aurora, IAM or Data API binding acceptance.
//
//   REAL_PAGE_THREAD_POSTGRES=1 ORGIQ_PAGE_THREAD_POSTGRES_CONTAINER=<name> \
//   [ORGIQ_DOCKER='colima ssh -- sudo docker'] npx jest … migrate-work-comments-postgres
//
// The container must carry the label orgiq.validation=page-thread-postgres.
jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../config.js', () => ({ config: { mock: { aurora: false } } }));
jest.mock('../../routes/chat-pins.js', () => ({
  historyFloor: async () => null,
  messageVisible: (m: { deletedAt?: string }) => !m.deletedAt,
}));
jest.mock('../../providers/identity.js', () => ({ getUser: jest.fn(async () => null), displayNameForSubject: jest.fn() }));

import { execFile, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { ChatMessage } from '@connorhoehn/realtime-modules/chat';
import { exec } from '../../providers/aurora.js';
import { auroraCommentSource, migrateWorkComments } from '../migrate-work-comments.js';
import { createMemorySocialChatBackend, RowsChatStore, setSocialChatBackend } from '../social-chat.js';
import { createWorkItemComment, getProjectActivity, listWorkItemComments, workThreadSummary } from '../../providers/work-items.js';

const enabled = process.env['REAL_PAGE_THREAD_POSTGRES'] === '1';
const container = process.env['ORGIQ_PAGE_THREAD_POSTGRES_CONTAINER'] ?? '';
const docker = (process.env['ORGIQ_DOCKER'] ?? 'docker').split(' ').filter(Boolean);
const SCHEMA = 'page_thread_acceptance';
const read = (name: string) => readFileSync(`${process.cwd()}/../schema/${name}`, 'utf8');
const ledger = read('work_item_comment_migration_schema.sql');
const parents = ['orgiq_schema.sql', 'orgiq_work_items_schema.sql', 'identity_schema.sql'].map(read).join('\n');
const NULL = '__PG_NULL__';
const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;

function psql(input: string, csv: boolean): Promise<string> {
  const args = [...docker.slice(1), 'exec', '-i', container, 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1',
    ...(csv ? ['--csv', '-P', `null=${NULL}`] : []), '-U', 'postgres', '-d', 'orgiq_validation'];
  return new Promise((resolve, reject) => {
    const child = execFile(docker[0]!, args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout)));
    child.stdin!.end(`SET search_path TO ${SCHEMA}; SET client_min_messages TO warning;\n${input}\n`);
  });
}
async function sql(statement: string): Promise<void> { await psql(statement, false); }

/** RFC-4180 CSV → records; psql prints the header row first. */
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
  const [header, ...data] = rows.filter((r) => !(r.length === 1 && r[0] === '') && r[0] !== 'SET');
  if (!header) return [];
  return data.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] === NULL ? null : r[i] ?? null])));
}

/** The Data API transport, replaced: bind string parameters, run the exact statement, return rows. */
async function rows(statement: string, params: Parameters<typeof exec>[1] = []) {
  const bindings = new Map<string | undefined, string | { int: number }>(params?.map((p) => {
    if (p.value?.longValue !== undefined) return [p.name, { int: p.value.longValue }] as const;
    if (p.value?.stringValue === undefined) throw new Error('Acceptance transport supports string and long parameters only');
    return [p.name, p.value.stringValue] as const;
  }));
  const bound = statement.replace(/(?<!:):([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, name: string) => {
    if (!bindings.has(name)) throw new Error(`Unbound parameter ${name}`);
    const v = bindings.get(name)!;
    return typeof v === 'string' ? literal(v) : String(Math.trunc(Number(v.int)));
  });
  return parseCsv(await psql(`${bound};`, true)) as Record<string, unknown>[];
}

function countingStore() {
  const messages: ChatMessage[] = [];
  const store = new RowsChatStore(() => messages);
  let puts = 0;
  return { messages, get puts() { return puts; }, target: {
    getMessage: (c: string, id: string) => store.getMessage(c, id),
    putMessage: async (m: ChatMessage) => { puts++; await store.putMessage(m); },
  } };
}

async function seedComments(n: number): Promise<void> {
  const values = Array.from({ length: n }, (_, i) => {
    const id = `wic-${String(i).padStart(3, '0')}`;
    const author = i % 3 === 0 ? "'p-linked'" : i % 3 === 1 ? "'p-unlinked'" : 'NULL';
    return `('${id}', 'work-${i % 2}', ${author}, 'Body ${i} with a comma, a "quote" and an '' apostrophe', FALSE, TIMESTAMPTZ '2026-09-01T00:00:00Z' + INTERVAL '${i} minutes')`;
  });
  await sql(`INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system, created_at) VALUES ${values.join(',\n')};
    INSERT INTO work_item_comments (id, work_item_id, author_id, body, is_system) VALUES ('wic-sys', 'work-0', 'p-linked', 'Status changed from Open to Done', TRUE);`);
}

(enabled ? describe : describe.skip)('work-comment migration with real PostgreSQL', () => {
  jest.setTimeout(120_000);

  beforeAll(async () => {
    if (!container) throw new Error('ORGIQ_PAGE_THREAD_POSTGRES_CONTAINER is required');
    const owned = execFileSync(docker[0]!, [...docker.slice(1), 'inspect', '--format', '{{index .Config.Labels "orgiq.validation"}}', container], { encoding: 'utf8' });
    if (owned.trim() !== 'page-thread-postgres') throw new Error('Refusing a container without the dedicated acceptance label');
    await sql(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}; SET search_path TO ${SCHEMA}, public;
      ${parents}\n${ledger}`);
    jest.mocked(exec).mockImplementation(rows as never);
  });
  beforeEach(async () => {
    setSocialChatBackend(createMemorySocialChatBackend({ fixtures: false }));
    await sql(`TRUNCATE projects, work_items, people, app_users, work_item_comments, work_item_comment_migrations CASCADE;
      INSERT INTO projects (id, name) VALUES ('project-1', 'Acceptance project');
      INSERT INTO work_items (id, project_id, type, title) VALUES ('work-0', 'project-1', 'story', 'W0'), ('work-1', 'project-1', 'bug', 'W1');
      INSERT INTO people (id, name, title) VALUES ('p-linked', 'Linked Person (directory)', 'Staff Engineer'), ('p-unlinked', 'Unlinked Person', 'Analyst');
      INSERT INTO app_users (id, display_name, person_id) VALUES ('u-b-second', 'Second Login', 'p-linked'), ('u-a-first', 'First Login', 'p-linked');`);
  });
  afterAll(() => setSocialChatBackend(null));

  it('reapplies the ledger migration and migrates every human comment once with directory-stamped senders', async () => {
    await sql(ledger);
    await seedComments(9);
    const s = countingStore();
    const report = await migrateWorkComments({ source: auroraCommentSource(exec as never), target: s.target, batchSize: 4, migrator: 'solo' });
    expect(report).toMatchObject({ claimed: 9, written: 9, alreadyInStore: 0, batches: 3, failures: [], unlinkedAuthors: ['p-unlinked'], removedAuthors: 3,
      perWorkItem: { 'work-0': 5, 'work-1': 4 } });
    expect(s.messages.some((m) => m.message === 'Status changed from Open to Done')).toBe(false);
    const first = s.messages.find((m) => m.metadata?.['commentId'] === 'wic-000')!;
    // Several logins link one person: the lowest id, deterministically; its display name, not the directory's.
    expect(first).toMatchObject({ userId: 'u-a-first', channel: 'orgiq:work:work-0', timestamp: '2026-09-01T00:00:00.000Z',
      message: 'Body 0 with a comma, a "quote" and an \' apostrophe', metadata: { displayName: 'First Login', authorPersonId: 'p-linked' } });
    expect(s.messages.find((m) => m.metadata?.['commentId'] === 'wic-001')).toMatchObject({ metadata: { displayName: 'Unlinked Person', unlinkedAuthor: true } });
    expect(s.messages.find((m) => m.metadata?.['commentId'] === 'wic-001')!.userId).toBeUndefined();
    expect(s.messages.find((m) => m.metadata?.['commentId'] === 'wic-002')!.metadata).toEqual({ migratedFrom: 'work_item_comments', commentId: 'wic-002', unlinkedAuthor: true });
    const led = await rows('SELECT count(*) AS n, count(written_at) AS w, count(DISTINCT message_id) AS m FROM work_item_comment_migrations');
    expect(led[0]).toEqual({ n: '9', w: '9', m: '9' });
    // Re-running inserts nothing.
    const again = await migrateWorkComments({ source: auroraCommentSource(exec as never), target: s.target, migrator: 'again' });
    expect(again).toMatchObject({ claimed: 0, written: 0 });
    expect(s.puts).toBe(9);
  });

  it('two migrators racing over the same rows insert each comment exactly once', async () => {
    await seedComments(30);
    const s = countingStore();
    const [a, b] = await Promise.all(['racer-a', 'racer-b'].map((migrator) =>
      migrateWorkComments({ source: auroraCommentSource(exec as never), target: s.target, batchSize: 4, migrator })));
    expect(a!.claimed + b!.claimed).toBe(30);
    expect(a!.written + b!.written + a!.alreadyInStore + b!.alreadyInStore).toBe(30);
    expect(s.puts).toBe(30);
    expect(new Set(s.messages.map((m) => m.id)).size).toBe(30);
    const led = await rows('SELECT migrator, count(*) AS n FROM work_item_comment_migrations WHERE written_at IS NOT NULL GROUP BY migrator ORDER BY migrator');
    expect(led.reduce((sum, r) => sum + Number(r['n']), 0)).toBe(30);
    // Record the split for the acceptance note.
    console.log(`race split: ${JSON.stringify(led)}`);
  });

  it('a stale unwritten claim is taken over; a fresh one is not stolen', async () => {
    await seedComments(3);
    await sql(`INSERT INTO work_item_comment_migrations (comment_id, work_item_id, migrator, claimed_at) VALUES
      ('wic-000', 'work-0', 'dead', NOW() - INTERVAL '10 minutes'), ('wic-001', 'work-1', 'alive', NOW());`);
    const s = countingStore();
    const report = await migrateWorkComments({ source: auroraCommentSource(exec as never), target: s.target, migrator: 'next' });
    expect(report.claimed).toBe(2);
    expect(s.messages.map((m) => m.metadata?.['commentId']).sort()).toEqual(['wic-000', 'wic-002']);
    const led = await rows("SELECT comment_id, migrator, written_at IS NOT NULL AS written FROM work_item_comment_migrations ORDER BY comment_id");
    expect(led).toEqual([
      { comment_id: 'wic-000', migrator: 'next', written: 't' },
      { comment_id: 'wic-001', migrator: 'alive', written: 'f' },
      { comment_id: 'wic-002', migrator: 'next', written: 't' },
    ]);
  });

  it('dry run reads the exact pending SQL and claims nothing', async () => {
    await seedComments(5);
    const s = countingStore();
    const report = await migrateWorkComments({ source: auroraCommentSource(exec as never), target: s.target, batchSize: 2, dryRun: true });
    expect(report).toMatchObject({ dryRun: true, claimed: 5, written: 0, batches: 3 });
    expect((await rows('SELECT count(*) AS n FROM work_item_comment_migrations'))[0]).toEqual({ n: '0' });
  });

  it('the provider read and write paths: thread for humans, the table only for audit rows, no human row written', async () => {
    await seedComments(3);
    const posted = await createWorkItemComment('work-0', { userId: 'u-a-first', displayName: 'First Login', personId: 'p-linked' }, 'Posted after the migration.');
    expect(posted).toMatchObject({ authorTitle: 'Staff Engineer', authorName: 'First Login' });
    expect((await rows('SELECT count(*) AS n FROM work_item_comments'))[0]).toEqual({ n: '4' });
    const { comments, total } = await listWorkItemComments('work-0');
    // Unmigrated human rows are NOT read from the table: the thread is the one store (migrate first).
    expect(comments).toHaveLength(2);
    expect(comments.filter((c) => c.isSystem).map((c) => c.body)).toEqual(['Status changed from Open to Done']);
    expect(comments.filter((c) => !c.isSystem).map((c) => c.body)).toEqual(['Posted after the migration.']);
    expect(comments.find((c) => c.isSystem)!.authorTitle).toBe('Staff Engineer');
    expect(Number.isFinite(Date.parse(comments.find((c) => c.isSystem)!.createdAt))).toBe(true);
    expect(total).toBe(1);
  });

  it('v_work_item_summary keeps comment_count (bigint, NULL = not known here) and replaces the table-counting definition in place', async () => {
    const work = read('orgiq_work_items_schema.sql');
    const view = /CREATE OR REPLACE VIEW v_work_item_summary AS[\s\S]*?;/.exec(work)![0];
    expect(view).not.toMatch(/work_item_comments/);
    // The pre-change definition, then the shipped one over it: CREATE OR REPLACE must accept the same name/type/position.
    const old = view.replace(/NULL::bigint AS comment_count/, '(SELECT COUNT(*) FROM work_item_comments wic WHERE wic.work_item_id = wi.id AND NOT wic.is_system) AS comment_count');
    await sql(old);
    await seedComments(3);
    expect((await rows("SELECT comment_count FROM v_work_item_summary WHERE id = 'work-0'"))[0]).toEqual({ comment_count: '2' });
    await sql(view);
    expect(await rows("SELECT id, comment_count, pg_typeof(comment_count)::text AS t FROM v_work_item_summary ORDER BY id"))
      .toEqual([{ id: 'work-0', comment_count: null, t: 'bigint' }, { id: 'work-1', comment_count: null, t: 'bigint' }]);
    const cols = await rows("SELECT column_name FROM information_schema.columns WHERE table_schema = 'page_thread_acceptance' AND table_name = 'v_work_item_summary' ORDER BY ordinal_position");
    expect(cols.at(-1)).toEqual({ column_name: 'comment_count' });
  });

  it('the activity feed and the comment summary read the thread: migrated history and a later post, the table only for audit rows', async () => {
    await seedComments(4);
    await migrateWorkComments({ source: auroraCommentSource(exec as never), target: (await import('../social-chat.js')).socialChat().chatStore as never, migrator: 'feed' });
    const posted = await createWorkItemComment('work-0', { userId: 'u-a-first', displayName: 'First Login', personId: 'p-linked' }, 'Posted after the migration.');
    jest.mocked(exec).mockClear();
    const summary = await workThreadSummary('work-0', null);
    // wic-000, wic-002 migrated onto work-0, plus the post; the is_system row is not a comment.
    expect(summary).toEqual({ commentCount: 3, lastCommentAt: posted.createdAt });
    expect(jest.mocked(exec).mock.calls.filter(([q]) => /work_item_comments/.test(String(q)))).toEqual([]);

    const feed = await getProjectActivity('project-1', { limit: 50 });
    const comments = feed.filter((e) => e.kind === 'comment');
    expect(comments.map((e) => e.id).sort()).toEqual([posted.id, 'wic-000', 'wic-001', 'wic-002', 'wic-003'].sort());
    expect(comments.find((e) => e.id === 'wic-000')).toMatchObject({ actorId: 'p-linked', actorName: 'First Login', workItemId: 'work-0', subject: 'W0' });
    expect(comments.find((e) => e.id === 'wic-001')).toMatchObject({ actorId: 'p-unlinked', actorName: 'Unlinked Person', workItemId: 'work-1' });
    expect(comments.find((e) => e.id === 'wic-002')).toMatchObject({ actorId: null, actorName: null });
    expect(feed.filter((e) => e.kind === 'status' && e.subject === 'Status changed from Open to Done')).toHaveLength(1);
    const tableReads = jest.mocked(exec).mock.calls.map(([q]) => String(q)).filter((q) => /work_item_comments/.test(q));
    expect(tableReads).toHaveLength(1);
    expect(tableReads[0]).toMatch(/AND c\.is_system/);
  });
});
