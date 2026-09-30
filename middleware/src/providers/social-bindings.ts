// Context bindings (docs/social-tenant-design.md §4.4, §4.6 — lane E): which
// `social:` channel is the discussion for a context in another tenant (an
// orgiq initiative; an assessment document later).
//
// Aurora `social_bindings` (schema/social_schema.sql) live; the registered
// fixture `social.bindings` (mock/social-bindings.ts) under MOCK_AURORA. The
// grant rules are the route's (routes/social.ts `/bindings`), not this file's.

import { config } from '../config.js';
import { clock } from '../mock/core/index.js';
import { socialBindingsFixture, type SocialBindingRow } from '../mock/social-bindings.js';
import { exec } from './aurora.js';

export type { SocialBindingRow };

export interface BindingContext { tenant: string; kind: string; id: string }

const str = (name: string, value: string) => ({ name, value: { stringValue: value } });
const COLUMNS = `tenant, context_kind, context_id, channel, created_by, created_at::text AS created_at`;
const WHERE = `tenant = :tenant AND context_kind = :kind AND context_id = :id`;
const params = (c: BindingContext) => [str('tenant', c.tenant), str('kind', c.kind), str('id', c.id)];

/** The Data API returns TIMESTAMPTZ as a naive UTC string. */
function utcIso(raw: unknown): string {
  const s = String(raw ?? '');
  if (!s) return new Date(0).toISOString();
  const withT = s.includes('T') ? s : s.replace(' ', 'T');
  const zoned = /([zZ]|[+-]\d{2}(:?\d{2})?)$/.test(withT) ? withT.replace(/([+-]\d{2})$/, '$1:00') : `${withT}Z`;
  const d = new Date(zoned);
  return Number.isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString();
}

function fromRow(row: Record<string, unknown>): SocialBindingRow {
  return {
    tenant: String(row['tenant']),
    contextKind: String(row['context_kind']),
    contextId: String(row['context_id']),
    channel: String(row['channel']),
    createdBy: String(row['created_by']),
    createdAt: utcIso(row['created_at']),
  };
}

const matches = (c: BindingContext) => (r: SocialBindingRow) => r.tenant === c.tenant && r.contextKind === c.kind && r.contextId === c.id;

export async function getBinding(c: BindingContext): Promise<SocialBindingRow | null> {
  if (config.mock.aurora) {
    const row = socialBindingsFixture.rows().find(matches(c));
    return row ? structuredClone(row) : null;
  }
  const rows = await exec(`SELECT ${COLUMNS} FROM social_bindings WHERE ${WHERE}`, params(c));
  return rows[0] ? fromRow(rows[0]) : null;
}

/** Bind (or re-bind) the context to `channel`. */
export async function putBinding(c: BindingContext, channel: string, createdBy: string): Promise<SocialBindingRow> {
  if (config.mock.aurora) {
    const rows = socialBindingsFixture.rows();
    const i = rows.findIndex(matches(c));
    const row: SocialBindingRow = { tenant: c.tenant, contextKind: c.kind, contextId: c.id, channel, createdBy, createdAt: clock.nowIso() };
    if (i >= 0) rows.splice(i, 1, row); else rows.push(row);
    return structuredClone(row);
  }
  const rows = await exec(
    `INSERT INTO social_bindings (tenant, context_kind, context_id, channel, created_by)
     VALUES (:tenant, :kind, :id, :channel, :createdBy)
     ON CONFLICT (tenant, context_kind, context_id)
     DO UPDATE SET channel = EXCLUDED.channel, created_by = EXCLUDED.created_by, created_at = now()
     RETURNING ${COLUMNS}`,
    [...params(c), str('channel', channel), str('createdBy', createdBy)],
  );
  return fromRow(rows[0]!);
}

/** Unbind. Returns whether a binding existed. */
export async function deleteBinding(c: BindingContext): Promise<boolean> {
  if (config.mock.aurora) {
    const rows = socialBindingsFixture.rows();
    const i = rows.findIndex(matches(c));
    if (i < 0) return false;
    rows.splice(i, 1);
    return true;
  }
  const rows = await exec(`DELETE FROM social_bindings WHERE ${WHERE} RETURNING channel`, params(c));
  return rows.length > 0;
}
