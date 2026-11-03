import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
test('canonical portrait migration preserves custom identities and is idempotent in PostgreSQL', { skip: process.env.REAL_AVATAR_POSTGRES !== '1', timeout: 30_000 }, async () => {
  const container = `orgiq-avatar-acceptance-${randomUUID().slice(0, 8)}`;
  const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  docker('run', '--detach', '--name', container, '--label', 'orgiq.validation=portrait-backfill', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgres:16-alpine');
  const sql = text => execFileSync('docker', ['exec', '-i', container, 'psql', '-XAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres'], { input: text, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  try {
    for (let i = 0; ; i++) {
      try { docker('exec', container, 'pg_isready', '-U', 'postgres'); break; }
      catch (e) { if (i === 30) throw e; await new Promise(r => setTimeout(r, 200)); }
    }
    sql(`CREATE TABLE people(id text primary key, avatar_url text, updated_at timestamptz);
      CREATE TABLE app_users(id text primary key, person_id text, avatar_url text);
      INSERT INTO people VALUES ('p-001',NULL,NULL),('p-002','/avatars/p-002.png',NULL),('p-003','/custom.jpg',NULL),('p-004','/avatars/photos/p-004.jpg',NULL),('p-005','/avatars/p-005.svg',NULL),('p-006','',NULL),('p-unknown',NULL,NULL);
      INSERT INTO app_users VALUES ('u-operator',NULL,NULL),('u-hr',NULL,'/avatars/u-hr.png'),('u-asha','p-001',NULL),('u-jonas',NULL,'/custom-user.jpg');`);
    const dry = readFileSync(new URL('../../schema/migrations/2026-11-02-canonical-portraits.dry-run.sql', import.meta.url), 'utf8');
    const migration = readFileSync(new URL('../../schema/migrations/2026-11-02-canonical-portraits.sql', import.meta.url), 'utf8');
    assert.equal(sql(dry), 'people|4\napp_users|2');
    // A custom photo changed after the plan is preserved by the apply predicate.
    sql("UPDATE people SET avatar_url='/new-custom.jpg' WHERE id='p-006'");
    sql('BEGIN;\n' + migration + '\nCOMMIT;');
    assert.equal(sql(dry), 'people|0\napp_users|0');
    assert.equal(sql("SELECT avatar_url FROM people WHERE id='p-003'"), '/custom.jpg');
    assert.equal(sql("SELECT avatar_url FROM people WHERE id='p-006'"), '/new-custom.jpg');
    assert.equal(sql("SELECT avatar_url FROM people WHERE id='p-001'"), '/avatars/photos/p-001.jpg');
    assert.equal(sql("SELECT avatar_url IS NULL FROM people WHERE id='p-unknown'"), 't');
    assert.equal(sql("SELECT avatar_url IS NULL FROM app_users WHERE id='u-asha'"), 't');
    assert.equal(sql("SELECT avatar_url FROM app_users WHERE id='u-jonas'"), '/custom-user.jpg');
    assert.equal(sql("SELECT avatar_url FROM app_users WHERE id='u-hr'"), '/avatars/photos/u-hr.jpg');
    sql(migration);
    assert.equal(sql(dry), 'people|0\napp_users|0');
  } finally { docker('rm', '--force', container); }
});
