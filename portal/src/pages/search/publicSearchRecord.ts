import { demoPublicProfiles } from '../../components/people/demoPublicProfiles.ts';
import type { SearchRecord } from './searchTypes';
const EMPTY_PUBLIC_PROFILE = 'No self-disclosed skills or credentials shared yet.';

/** Everyday lookup presents profile statements, not inferred specialties. */
export function publicSearchRecord<T extends SearchRecord>(record: T, hr: boolean): T {
  if (hr || record.type !== 'person') return record;
  const profile = demoPublicProfiles[record.id];
  return { ...record, description: profile
    ? [...profile.skills, ...profile.credentials.map(credential => credential.title)].join(' · ')
    : EMPTY_PUBLIC_PROFILE };
}

/** Compact result rows omit repeated empty-profile prose after the privacy
 * transform. Profile detail and answer evidence keep their explicit empty state. */
export function publicSearchResult<T extends SearchRecord>(record: T, hr: boolean): T {
  const publicRecord = publicSearchRecord(record, hr);
  if (!hr && record.type === 'person' && (publicRecord.description === EMPTY_PUBLIC_PROFILE || !publicRecord.description?.trim())) {
    return { ...publicRecord, description: undefined };
  }
  return publicRecord;
}
