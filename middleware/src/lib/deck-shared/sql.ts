// RDS Data API parameter helpers the deck providers share.

import type { SqlParameter } from '@aws-sdk/client-rds-data';

export const str = (name: string, value: string): SqlParameter => ({ name, value: { stringValue: value } });
export const maybe = (name: string, value: string | null | undefined): SqlParameter =>
  value == null ? { name, value: { isNull: true } } : str(name, value);
export const json = (name: string, value: unknown): SqlParameter => ({ name, value: { stringValue: JSON.stringify(value) } });
export const parse = <T>(raw: unknown, fallback: T): T => {
  if (raw == null) return fallback;
  try { return JSON.parse(String(raw)) as T; } catch { return fallback; }
};
/** A timestamptz column as an ISO-8601 UTC string (the Data API would otherwise return a naive one). */
export const iso = (col: string): string => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
