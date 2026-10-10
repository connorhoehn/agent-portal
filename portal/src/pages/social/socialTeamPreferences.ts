import { sendJson } from '../../lib/writeJson.ts';
import type { SocialSource, SocialTeam } from './socialPlatform.ts';

export interface TeamsResponse {
  source: SocialSource;
  teams: SocialTeam[];
  counts: { total: number; channels: number };
}

export async function saveTeamFavorite(teamId: string, userId: string, favorite: boolean, api = '/api/social'): Promise<void> {
  const receipt = await sendJson<{ member?: { teamId?: string; userId?: string; favorite?: boolean } }>(
    `${api}/teams/${encodeURIComponent(teamId)}/me`, 'PATCH', { favorite },
  );
  if (receipt?.member?.teamId !== teamId || receipt.member.userId !== userId || receipt.member.favorite !== favorite) {
    throw new Error('The team preference could not be confirmed. Try again.');
  }
}

interface TeamsSnapshot { data: TeamsResponse | null; isLoading: boolean; error: string | null }

/** Owns one actor's team reads and writes. Older polls cannot undo a saved
 * preference, and Pin and Leave share a synchronous per-team lock. */
export class SocialTeamPreferences {
  private snapshot: TeamsSnapshot = { data: null, isLoading: true, error: null };
  private listeners = new Set<() => void>();
  private pending = new Set<string>();
  private acknowledged = new Map<string, { favorite: boolean; expiresAt: number }>();
  private departed = new Map<string, number>();
  private readVersion = 0;
  private controller?: AbortController;
  private active = true;
  private lifetime = 0;

  readonly userId: string;
  private now: () => number;
  /** The Social API prefix: `/api/social`, or the plane's in another tenant (socialPlane.ts). */
  readonly api: string;
  constructor(userId: string, now: () => number = Date.now, api = '/api/social') { this.userId = userId; this.now = now; this.api = api; }

  getSnapshot = (): TeamsSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private publish(next: TeamsSnapshot): void {
    if (!this.active) return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }

  start(): void { this.active = true; }
  stop(): void {
    this.active = false;
    this.lifetime += 1;
    this.invalidateReads();
  }

  private invalidateReads(): void {
    this.readVersion += 1;
    this.controller?.abort();
  }

  refresh = async (): Promise<void> => {
    if (!this.active) return;
    this.invalidateReads();
    const version = this.readVersion;
    const controller = new AbortController();
    this.controller = controller;
    try {
      const response = await fetch(`${this.api}/teams`, { credentials: 'include', signal: controller.signal });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      if (!this.active || version !== this.readVersion) return;
      const data = body as TeamsResponse;
      const present = new Set(data.teams.map((team) => team.teamId));
      for (const id of this.acknowledged.keys()) if (!present.has(id)) this.acknowledged.delete(id);
      for (const [id, expiresAt] of this.departed) {
        if (!present.has(id) || expiresAt <= this.now()) this.departed.delete(id);
      }
      const teams = data.teams.flatMap((team) => {
        if (this.departed.has(team.teamId)) {
          if (!team.role) this.departed.delete(team.teamId);
          else return [];
        }
        const receipt = this.acknowledged.get(team.teamId);
        if (receipt === undefined) return [team];
        // Once a subsequent read sees the receipt, future external preference
        // changes may flow through normally. Out-of-order reads are rejected.
        // A different tab may change the same actor's preference before a
        // matching read arrives. Bound reconciliation to one poll interval.
        if (!team.role || team.favorite === receipt.favorite || receipt.expiresAt <= this.now()) {
          this.acknowledged.delete(team.teamId);
          return [team];
        }
        return [{ ...team, favorite: receipt.favorite }];
      });
      this.publish({ data: { ...data, teams, counts: {
        total: teams.length, channels: teams.reduce((count, team) => count + team.channels.length, 0),
      } }, isLoading: false, error: null });
    } catch (error) {
      if (!this.active || version !== this.readVersion) return;
      this.publish({ ...this.snapshot, isLoading: false, error: error instanceof Error ? error.message : 'Could not load teams.' });
    }
  };

  async pin(teamId: string, favorite: boolean): Promise<boolean> {
    if (!this.active || this.pending.has(teamId)) return false;
    const team = this.snapshot.data?.teams.find((row) => row.teamId === teamId);
    if (!team?.role) throw new Error('Join this team before pinning it.');
    if (team.favorite === favorite) return false;
    const lifetime = this.lifetime;
    return this.change(teamId, async () => {
      await saveTeamFavorite(teamId, this.userId, favorite, this.api);
      if (!this.active || lifetime !== this.lifetime) return;
      this.acknowledged.set(teamId, { favorite, expiresAt: this.now() + 30_000 });
      if (this.snapshot.data) this.publish({ ...this.snapshot, data: {
        ...this.snapshot.data,
        teams: this.snapshot.data.teams.map((row) => row.teamId === teamId ? { ...row, favorite } : row),
      } });
    });
  }

  async changeMembership(teamId: string, operation: () => Promise<void>, selfLeave: boolean): Promise<boolean> {
    const lifetime = this.lifetime;
    return this.change(teamId, async () => {
      await operation();
      if (!this.active || lifetime !== this.lifetime) return;
      if (!selfLeave || !this.snapshot.data) return;
      this.acknowledged.delete(teamId);
      this.departed.set(teamId, this.now() + 30_000);
      // The team directory lists memberships. Remove the whole row, including
      // its channels, until a subsequent read confirms the departed state.
      const teams = this.snapshot.data.teams.filter((team) => team.teamId !== teamId);
      this.publish({ ...this.snapshot, data: { ...this.snapshot.data, teams, counts: {
        total: teams.length, channels: teams.reduce((count, team) => count + team.channels.length, 0),
      } } });
    });
  }

  private async change(teamId: string, operation: () => Promise<void>): Promise<boolean> {
    if (!this.active || this.pending.has(teamId)) return false;
    this.pending.add(teamId);
    const lifetime = this.lifetime;
    this.invalidateReads();
    try {
      await operation();
      return this.active && lifetime === this.lifetime;
    } finally {
      this.pending.delete(teamId);
      // Also invalidate reads begun during the mutation before accepting the
      // first read started after its receipt (or refusal).
      if (this.active && lifetime === this.lifetime) {
        this.invalidateReads();
        void this.refresh();
      }
    }
  }
}
