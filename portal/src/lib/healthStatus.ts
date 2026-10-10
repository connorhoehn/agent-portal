export interface DependencyHealth {
  ok: boolean;
  error?: string;
  checkedAt?: number;
  refreshing?: boolean;
  stale?: boolean;
}

export const healthPending = (status?: DependencyHealth): boolean =>
  status?.stale === true || (status?.refreshing === true && status.checkedAt === undefined);

export const healthFailed = (status?: DependencyHealth): boolean =>
  status?.ok === false && !healthPending(status);
