// The knowledge-base write surface offline — registry, upload links, S3.
//
// Eight pairs on `scripts/mock-write-route-budget.txt` lived here: registering
// a knowledge base, renaming one, minting an upload link, revoking one,
// resolving a drop token, accepting a file through it, and the two S3 writes
// underneath (`uploadToLandingZone`, `initLandingZone`). Every one of them
// reached the RDS Data API or S3 with no `config.mock` branch, so the whole
// surface 500'd in `dev:mock` while its READS were mocked — the arrangement
// docs/mock-floor.md calls the worst one, because the page appears to work.
//
// The clock is frozen in every test that asserts a stamp, so these are exact
// values rather than "roughly now". That is the point of the clock existing:
// `uploadToLandingZone` files an object under a `<YYYY-MM-DD>/` key segment it
// composes itself, and the only way to assert that key is to know the day.

jest.mock('../../config.js', () => ({
  config: {
    region: 'us-east-1',
    mock: { aurora: true, agentcore: true, guardrails: true, cloudwatch: true },
    aurora: { clusterArn: '', secretArn: '', database: 'orgiq' },
    foundation: { documentsBucket: '', artifactsBucket: '' },
    knowledgeBase: { serviceRoleArn: '' },
  },
}));
// Reaching Aurora at all is a missing branch, not a slow test.
jest.mock('../../providers/aurora.js', () => ({
  exec: jest.fn(() => { throw new Error('exec() must not be reached offline'); }),
}));

import { freezeClock } from '../core/clock.js';
import { kbRegistry } from '../kb-registry.js';
import { landingZoneObjects, MOCK_DOCUMENTS_BUCKET } from '../landing-zone.js';
import { uploadLinks, uploadLinkFiles, MOCK_LIVE_DROP_TOKEN } from '../upload-links.js';
import {
  createKbEntry,
  updateKbEntry,
  deleteKbEntry,
  getKb,
  listKbs,
} from '../../providers/kb-registry.js';
import {
  createUploadLink,
  describeLinkForRecipient,
  listLinkFiles,
  listUploadLinks,
  revokeUploadLink,
  uploadViaLink,
} from '../../providers/upload-links.js';
import {
  getLandingZoneStats,
  initLandingZone,
  listLandingZoneFiles,
  uploadToLandingZone,
} from '../../providers/landing-zones.js';

const AT = '2026-09-06T09:15:00.000Z';

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
  kbRegistry.reset();
  uploadLinks.reset();
  uploadLinkFiles.reset();
  landingZoneObjects.reset();
});

describe('the KB registry writes offline', () => {
  it('inserts a row the reads immediately serve, stamped from the clock', async () => {
    restore = freezeClock(AT);
    const before = (await listKbs()).length;

    const entry = await createKbEntry({
      name: 'Security Runbooks',
      slug: 'orgiq-security',
      tenant: 'orgiq',
      purpose: 'security',
      s3Prefix: 'orgiq-security/',
    });

    expect(entry.status).toBe('CREATING');
    expect(entry.bedrockKbId).toBeNull();
    // The INSERT hard-codes the embedding model; the fixture must not drift.
    expect(entry.embeddingModel).toBe('amazon.titan-embed-text-v2:0');
    expect(entry.auroraTable).toBe('bedrock_kb_orgiq_security');
    expect(entry.createdAt).toBe(AT);
    expect(entry.updatedAt).toBe(AT);

    expect((await listKbs()).length).toBe(before + 1);
    expect(await getKb(entry.id)).toEqual(entry);
  });

  it('patches in place and re-stamps updatedAt', async () => {
    restore = freezeClock(AT);
    const entry = await createKbEntry({
      name: 'Security Runbooks', slug: 'orgiq-security', tenant: 'orgiq',
      purpose: 'security', s3Prefix: 'orgiq-security/',
    });
    restore();
    restore = freezeClock('2026-09-06T11:00:00.000Z');

    await updateKbEntry(entry.id, { name: 'IR Runbooks' });

    const after = await getKb(entry.id);
    expect(after?.name).toBe('IR Runbooks');
    expect(after?.createdAt).toBe(AT);
    expect(after?.updatedAt).toBe('2026-09-06T11:00:00.000Z');
  });

  it('deletes the row rather than tombstoning it', async () => {
    const entry = await createKbEntry({
      name: 'Temp', slug: 'orgiq-temp', tenant: 'orgiq',
      purpose: 'scratch', s3Prefix: 'orgiq-temp/',
    });
    await deleteKbEntry(entry.id);
    expect(await getKb(entry.id)).toBeNull();
  });
});

describe('the landing zone offline', () => {
  it('files an upload under the key the provider composes, from the clock', async () => {
    restore = freezeClock(AT);

    const result = await uploadToLandingZone(
      'orgiq-onboarding', 'Q4 plan (final).md', Buffer.from('# plan\n'), 'text/markdown',
    );

    expect(result.key).toBe('orgiq-onboarding/2026-09-06/Q4_plan__final_.md');
    expect(result.bucket).toBe(MOCK_DOCUMENTS_BUCKET);
    expect(result.s3Uri).toBe(`s3://${MOCK_DOCUMENTS_BUCKET}/${result.key}`);
    expect(result.size).toBe(7);

    const page = await listLandingZoneFiles('orgiq-onboarding/');
    expect(page.files.map((f) => f.key)).toContain(result.key);
    expect(page.prefix).toBe('orgiq-onboarding/');
  });

  it('does not list the .keep marker it writes', async () => {
    restore = freezeClock(AT);
    await initLandingZone('orgiq-fresh');
    const page = await listLandingZoneFiles('orgiq-fresh/');
    expect(page.files).toEqual([]);
    // ...but the object IS there, so the prefix exists.
    expect(landingZoneObjects.rows().some((o) => o.key === 'orgiq-fresh/.keep')).toBe(true);
  });

  it('counts stats from the rows rather than reporting a stored total', async () => {
    restore = freezeClock(AT);
    await uploadToLandingZone('orgiq-onboarding', 'a.txt', Buffer.alloc(100), 'text/plain');
    await uploadToLandingZone('orgiq-onboarding', 'b.txt', Buffer.alloc(50), 'text/plain');

    const stats = await getLandingZoneStats('orgiq-onboarding/');
    const rows = landingZoneObjects.rows().filter((o) => o.key.startsWith('orgiq-onboarding/'));
    expect(stats.objectCount).toBe(rows.length);
    expect(stats.totalBytes).toBe(rows.reduce((n, o) => n + o.size, 0));
    expect(stats.bucket).toBe(MOCK_DOCUMENTS_BUCKET);
  });

  it('a second upload of the same filename replaces the object, as PutObject does', async () => {
    restore = freezeClock(AT);
    const first = await uploadToLandingZone('orgiq-onboarding', 'dup.txt', Buffer.alloc(10), 'text/plain');
    await uploadToLandingZone('orgiq-onboarding', 'dup.txt', Buffer.alloc(20), 'text/plain');
    const matching = landingZoneObjects.rows().filter((o) => o.key === first.key);
    expect(matching).toHaveLength(1);
    expect(matching[0]?.size).toBe(20);
  });
});

describe('upload links offline', () => {
  it('returns the token exactly once and stores only its hash', async () => {
    restore = freezeClock(AT);

    const { link, token } = await createUploadLink({
      kbSlug: 'orgiq-onboarding', label: 'Design partner', expiresInHours: 48, maxFiles: 3,
    });

    expect(link.status).toBe('live');
    expect(link.filesUsed).toBe(0);
    expect(link.createdAt).toBe(AT);
    expect(link.expiresAt).toBe('2026-09-08T09:15:00.000Z');
    // The token is nowhere in the stored row — the property the whole feature
    // rests on, and one a fixture could quietly have dropped.
    const stored = uploadLinks.rows().find((l) => l.id === link.id);
    expect(JSON.stringify(stored)).not.toContain(token);
    // ...but it resolves, because the lookup is by hash.
    expect((await describeLinkForRecipient(token))?.label).toBe('Design partner');
  });

  it('accepts a file, moves the quota, and records the object once', async () => {
    restore = freezeClock(AT);
    const { token, link } = await createUploadLink({
      kbSlug: 'orgiq-onboarding', label: 'Design partner', maxFiles: 2,
    });

    const out = await uploadViaLink(token, 'notes.md', Buffer.from('hello'), 'text/markdown');
    expect(out).toEqual({ ok: true, key: 'orgiq-onboarding/2026-09-06/notes.md', bytes: 5 });

    const after = (await listUploadLinks('orgiq-onboarding')).find((l) => l.id === link.id);
    expect(after?.filesUsed).toBe(1);
    expect(after?.bytesUsed).toBe(5);
    expect(after?.lastUsedAt).toBe(AT);

    expect(await listLinkFiles(link.id)).toEqual([
      {
        filename: 'notes.md',
        s3Key: 'orgiq-onboarding/2026-09-06/notes.md',
        bytes: 5,
        contentType: 'text/markdown',
        uploadedAt: AT,
      },
    ]);
    // The bytes landed in the bucket too — a link's file list and the object
    // store must not disagree about what arrived.
    expect(landingZoneObjects.rows().map((o) => o.key))
      .toContain('orgiq-onboarding/2026-09-06/notes.md');
  });

  it('enforces the file ceiling on the write, not before it', async () => {
    restore = freezeClock(AT);
    const { token } = await createUploadLink({
      kbSlug: 'orgiq-onboarding', label: 'One shot', maxFiles: 1,
    });
    await uploadViaLink(token, 'a.md', Buffer.from('x'), 'text/markdown');
    const second = await uploadViaLink(token, 'b.md', Buffer.from('y'), 'text/markdown');
    expect(second).toMatchObject({ ok: false, refusal: 'exhausted' });
  });

  it('revokes once and refuses to report a second revoke as success', async () => {
    const { link, token } = await createUploadLink({
      kbSlug: 'orgiq-onboarding', label: 'Revoke me',
    });
    expect(await revokeUploadLink(link.id)).toBe(true);
    expect(await revokeUploadLink(link.id)).toBe(false);
    expect((await describeLinkForRecipient(token))?.status).toBe('revoked');
    expect(await uploadViaLink(token, 'x.md', Buffer.from('x'), 'text/markdown'))
      .toMatchObject({ ok: false, refusal: 'revoked' });
  });

  it('refuses a type Bedrock cannot index without touching the quota', async () => {
    const { link, token } = await createUploadLink({
      kbSlug: 'orgiq-onboarding', label: 'Types',
    });
    const out = await uploadViaLink(token, 'payload.exe', Buffer.from('MZ'), 'application/octet-stream');
    expect(out).toMatchObject({ ok: false, refusal: 'bad-type' });
    expect(uploadLinks.rows().find((l) => l.id === link.id)?.filesUsed).toBe(0);
  });

  it('refuses a name that would land on a metadata sidecar key without touching the quota', async () => {
    const { link, token } = await createUploadLink({
      kbSlug: 'orgiq-onboarding', label: 'Sidecar names',
    });
    const before = landingZoneObjects.rows().length;
    const out = await uploadViaLink(token, 'notes.md.metadata.json', Buffer.from('{}'), 'application/json');
    expect(out).toMatchObject({ ok: false, refusal: 'reserved-name' });
    expect(uploadLinks.rows().find((l) => l.id === link.id)?.filesUsed).toBe(0);
    expect(landingZoneObjects.rows()).toHaveLength(before);
  });

  it('the seeded live link answers to its declared token', async () => {
    const view = await describeLinkForRecipient(MOCK_LIVE_DROP_TOKEN);
    expect(view?.status).toBe('live');
    expect(view?.destination).toBe('orgiq-onboarding');
    // Deliberately not the bucket or the prefix — the recipient learns neither.
    expect(JSON.stringify(view)).not.toContain(MOCK_DOCUMENTS_BUCKET);
  });

  it('the seeded statuses are derived, not stored', async () => {
    const links = await listUploadLinks();
    expect(links.map((l) => l.status).sort()).toEqual(['expired', 'live', 'revoked']);
    for (const row of uploadLinks.rows()) {
      expect(Object.keys(row)).not.toContain('status');
    }
  });
});
