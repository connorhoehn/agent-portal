// The social tenant's channel directory (docs/social-tenant-design.md §4.4):
// the name, description and privacy of each `social:ch:<slug>` channel.
//
// Aurora `social_channels` (schema/social_schema.sql) live; the registered
// fixture `social.channels` (mock/social-channels.ts) under MOCK_AURORA.
// Membership and messages are chat state (lib/social-chat.ts), never here.

import { config } from '../config.js';
import { clock } from '../mock/core/index.js';
import { socialChannelsFixture, type SocialChannelPrivacy, type SocialChannelRow } from '../mock/social-channels.js';
import { exec } from './aurora.js';

export type { SocialChannelPrivacy, SocialChannelRow };

const str = (name: string, value: string | null) =>
  value === null ? { name, value: { isNull: true } } : { name, value: { stringValue: value } };
const COLUMNS = `slug, name, description, privacy, created_by, created_at::text AS created_at`;

/** The Data API returns TIMESTAMPTZ as a naive UTC string ("2026-09-29 18:00:00.123+00" or without zone). */
function utcIso(raw: unknown): string {
  const s = String(raw ?? '');
  if (!s) return new Date(0).toISOString();
  const withT = s.includes('T') ? s : s.replace(' ', 'T');
  const zoned = /([zZ]|[+-]\d{2}(:?\d{2})?)$/.test(withT) ? withT.replace(/([+-]\d{2})$/, '$1:00') : `${withT}Z`;
  const d = new Date(zoned);
  return Number.isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString();
}

function fromRow(row: Record<string, unknown>): SocialChannelRow {
  return {
    tenant: 'social',
    slug: String(row['slug']),
    name: String(row['name']),
    description: row['description'] == null ? null : String(row['description']),
    privacy: row['privacy'] === 'private' ? 'private' : 'public',
    createdBy: String(row['created_by']),
    createdAt: utcIso(row['created_at']),
  };
}

export async function listChannels(): Promise<SocialChannelRow[]> {
  if (config.mock.aurora) return structuredClone(socialChannelsFixture.rows());
  return (await exec(`SELECT ${COLUMNS} FROM social_channels WHERE tenant = 'social' ORDER BY slug`)).map(fromRow);
}

export async function getChannel(slug: string): Promise<SocialChannelRow | null> {
  if (config.mock.aurora) {
    const row = socialChannelsFixture.rows().find((r) => r.slug === slug);
    return row ? structuredClone(row) : null;
  }
  const rows = await exec(`SELECT ${COLUMNS} FROM social_channels WHERE tenant = 'social' AND slug = :slug`, [str('slug', slug)]);
  return rows[0] ? fromRow(rows[0]) : null;
}

export class DuplicateChannelError extends Error {
  constructor(readonly slug: string) {
    super(`a channel named #${slug} already exists`);
  }
}

/** Insert; throws DuplicateChannelError when the slug is taken. */
export async function createChannel(input: { slug: string; name: string; description: string | null; privacy: SocialChannelPrivacy; createdBy: string }): Promise<SocialChannelRow> {
  if (config.mock.aurora) {
    const rows = socialChannelsFixture.rows();
    if (rows.some((r) => r.slug === input.slug)) throw new DuplicateChannelError(input.slug);
    const row: SocialChannelRow = { tenant: 'social', ...input, createdAt: clock.nowIso() };
    rows.push(row);
    return structuredClone(row);
  }
  const rows = await exec(
    `INSERT INTO social_channels (tenant, slug, name, description, privacy, created_by)
     VALUES ('social', :slug, :name, :description, :privacy, :createdBy)
     ON CONFLICT (tenant, slug) DO NOTHING
     RETURNING ${COLUMNS}`,
    [str('slug', input.slug), str('name', input.name), str('description', input.description), str('privacy', input.privacy), str('createdBy', input.createdBy)],
  );
  if (!rows[0]) throw new DuplicateChannelError(input.slug);
  return fromRow(rows[0]);
}
