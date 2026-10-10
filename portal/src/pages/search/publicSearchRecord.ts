import { demoPublicProfiles } from '../../components/people/demoPublicProfiles.ts';
import type { SearchRecord } from './searchTypes';

/** Everyday lookup presents profile statements, not inferred specialties. */
export function publicSearchRecord<T extends SearchRecord>(record: T, hr: boolean): T {
  if (hr || record.type !== 'person') return record;
  const profile = demoPublicProfiles[record.id];
  return { ...record, description: profile
    ? [...profile.skills, ...profile.credentials.map(credential => credential.title)].join(' · ')
    : 'No self-disclosed skills or credentials shared yet.' };
}
