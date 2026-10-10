// Avatar URL per user id: the user's own `app_users.avatar_url`, else their
// linked person's `people.avatar_url`, else null (the portal renders initials).
//
// Deliberately its own module and its own best-effort read rather than a
// column on the directory queries in providers/identity.ts: those are the
// realtime authority path, and a cluster that has not yet applied the additive
// `avatar_url` columns (schema/orgiq_schema.sql, schema/identity_schema.sql)
// must lose faces, never admission. Any failure answers all-null.

import { RDSDataClient, ExecuteStatementCommand, type Field, type SqlParameter } from '@aws-sdk/client-rds-data';
import { config } from '../config.js';
import { mockAvatarUrl } from '../mock/avatars.js';

let client: RDSDataClient | null = null;
const rds = (): RDSDataClient => (client ??= new RDSDataClient({ region: config.region }));

const text = (cell: Field | undefined): string | null => (cell && !cell.isNull && typeof cell.stringValue === 'string' ? cell.stringValue : null);

export async function userAvatars(
  users: ReadonlyArray<{ id: string; personId: string | null }>,
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (users.length === 0) return out;
  const aurora = config.aurora;
  if (config.mock?.aurora || !aurora?.clusterArn || !aurora?.secretArn) {
    for (const user of users) out.set(user.id, mockAvatarUrl(user.personId ?? user.id));
    return out;
  }
  const ids = [...new Set(users.map((user) => user.id))];
  for (const id of ids) out.set(id, null);
  try {
    for (let offset = 0; offset < ids.length; offset += 200) {
      const params: SqlParameter[] = ids.slice(offset, offset + 200).map((id, index) => ({ name: `a${index}`, value: { stringValue: id } }));
      const result = await rds().send(new ExecuteStatementCommand({
        resourceArn: aurora.clusterArn, secretArn: aurora.secretArn, database: aurora.database,
        sql: `SELECT u.id, COALESCE(u.avatar_url, p.avatar_url) AS avatar_url
                FROM app_users u LEFT JOIN people p ON p.id = u.person_id
               WHERE u.id IN (${params.map((param) => `:${param.name}`).join(', ')})`,
        parameters: params,
      }));
      for (const row of result.records ?? []) {
        const id = text(row[0]);
        if (id && out.has(id)) out.set(id, text(row[1]) || null);
      }
    }
  } catch {
    for (const id of ids) out.set(id, null);
  }
  return out;
}
