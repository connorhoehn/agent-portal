// Faces for call-log rows. platform-api's call log names people by id only
// (callerId, targetUserIds), so the BFF adds each one's avatar from the
// directory — best-effort, null renders initials — without changing the row.
import { listUsers } from '../providers/identity.js';
import { userAvatars } from '../providers/user-avatars.js';

export interface CallLogPeople { callerId: string; targetUserIds: string[] }

export async function withCallAvatars<Row extends CallLogPeople>(
  rows: Row[],
): Promise<Array<Row & { callerAvatarUrl: string | null; avatars: Record<string, string | null> }>> {
  if (rows.length === 0) return [];
  const named = (row: Row) => [row.callerId, ...(Array.isArray(row.targetUserIds) ? row.targetUserIds : [])].filter((id): id is string => typeof id === 'string' && id.length > 0);
  const ids = new Set(rows.flatMap(named));
  let avatars = new Map<string, string | null>();
  try {
    const directory = (await listUsers()).filter((user) => ids.has(user.id));
    avatars = await userAvatars(directory);
  } catch { /* faces are optional */ }
  return rows.map((row) => {
    const people: Record<string, string | null> = {};
    for (const id of named(row)) people[id] = avatars.get(id) ?? null;
    return { ...row, callerAvatarUrl: people[row.callerId] ?? null, avatars: people };
  });
}
