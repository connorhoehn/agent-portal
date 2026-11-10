// Who owns which part of the documents bucket: the declared map is the
// shared file's (tenants/kb-prefixes.json, from which the infra creates one
// knowledge-base data source per prefix), ownership is the longest prefix, and
// each document's tenant metadata sidecar names that owner.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DECLARED_KB_PREFIXES, HOME_KB_PREFIXES, HOME_KB_TENANT, ownerOfKey, tenantMetadataSidecar, withHomePrefixes,
} from '../kb-prefixes.js';

const FILE = join(__dirname, '..', '..', '..', '..', 'tenants', 'kb-prefixes.json');

describe('declared knowledge-base prefixes', () => {
  it('match tenants/kb-prefixes.json', () => {
    const file = JSON.parse(readFileSync(FILE, 'utf8')) as { homeTenant: string; tenants: Record<string, string[]> };
    expect(DECLARED_KB_PREFIXES).toEqual(file.tenants);
    expect(HOME_KB_TENANT).toBe(file.homeTenant);
    expect(HOME_KB_PREFIXES).toEqual(file.tenants[file.homeTenant]);
  });

  it('every declared prefix counts as its tenant’s beside the registered ones', () => {
    const all = withHomePrefixes([{ tenant: 'orgiq', s3Prefix: 'orgiq-legacy/' }]);
    expect(all).toEqual(expect.arrayContaining([
      { tenant: 'orgiq', s3Prefix: 'orgiq-legacy/' },
      { tenant: 'orgiq', s3Prefix: 'uploads/' },
      { tenant: 'assessment', s3Prefix: 'assessment/' },
    ]));
  });
});

describe('ownerOfKey', () => {
  it('takes the longest matching prefix, registered or declared', () => {
    expect(ownerOfKey('uploads/2026-11-10/a.md')).toBe('orgiq');
    expect(ownerOfKey('assessment/evidence/a.pdf')).toBe('assessment');
    expect(ownerOfKey('orgiq/hr/a.md', [{ tenant: 'hr', s3Prefix: 'orgiq/hr' }])).toBe('hr');
    expect(ownerOfKey('/uploads/a.md')).toBe('orgiq');
  });

  it('answers null for a key no prefix holds', () => {
    expect(ownerOfKey('elsewhere/a.md')).toBeNull();
    expect(ownerOfKey('uploadsX/a.md')).toBeNull();
  });
});

describe('tenantMetadataSidecar', () => {
  it('is the Bedrock metadata file beside the document', () => {
    const s = tenantMetadataSidecar('uploads/2026-11-10/a.md', 'orgiq');
    expect(s.key).toBe('uploads/2026-11-10/a.md.metadata.json');
    expect(JSON.parse(s.body)).toEqual({ metadataAttributes: { tenant: 'orgiq' } });
  });
});
