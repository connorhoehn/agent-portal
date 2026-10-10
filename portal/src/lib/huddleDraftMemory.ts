import { huddleScopeKey, type HuddleScope } from './huddleRoster.ts';

interface Draft { html: string; files: readonly unknown[] }
export interface SavedHuddleDraft<D extends Draft, P> {
  scope: HuddleScope;
  title: string;
  draft: D;
  page: P | null;
}
interface Snapshot<D extends Draft, P> {
  identityKey: string | null;
  active: SavedHuddleDraft<D, P> | null;
  retired: readonly SavedHuddleDraft<D, P>[];
}
const hasDraft = (draft: Draft): boolean => draft.files.length > 0
  || /<(?:img|audio|video|hr)\b/i.test(draft.html)
  || draft.html.replace(/<[^>]*>/g, '').replace(/&nbsp;|&#160;/g, '').trim().length > 0;

/** Unsent local drafts only: this grants no retired call access or send authority. */
export class HuddleDraftMemory<D extends Draft, P> {
  private snapshot: Snapshot<D, P> = { identityKey: null, active: null, retired: [] };
  private listeners = new Set<() => void>();
  private readonly empty: D;
  constructor(empty: D) { this.empty = empty; }
  getSnapshot = (): Snapshot<D, P> => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  };
  private publish(next: Snapshot<D, P>): void {
    this.snapshot = next; for (const listener of this.listeners) listener();
  }
  setScope(identityKey: string | null, scope: HuddleScope | null, title: string): void {
    const previous = this.snapshot;
    const valid = identityKey && scope?.identityKey === identityKey ? scope : null;
    const sameIdentity = !!identityKey && previous.identityKey === identityKey;
    if (sameIdentity && huddleScopeKey(previous.active?.scope ?? null) === huddleScopeKey(valid)) return;
    const retired = sameIdentity ? [...previous.retired] : [];
    if (sameIdentity && previous.active && hasDraft(previous.active.draft)) {
      const key = huddleScopeKey(previous.active.scope);
      const index = retired.findIndex(row => huddleScopeKey(row.scope) === key);
      if (index >= 0) retired[index] = previous.active; else retired.push(previous.active);
    }
    // A new call begins with its own blank draft. Recovery into any destination
    // is an explicit consumer action; an old draft is never adopted here.
    this.publish({ identityKey, retired, active: valid ? { scope: { ...valid }, title, draft: this.empty, page: null } : null });
  }
  active(identityKey: string | null, scope: HuddleScope | null): SavedHuddleDraft<D, P> | null {
    if (!identityKey || this.snapshot.identityKey !== identityKey || !scope) return null;
    const row = this.snapshot.active;
    return row && huddleScopeKey(row.scope) === huddleScopeKey(scope) ? row : null;
  }
  retired(identityKey: string | null, currentScope: HuddleScope | null): readonly SavedHuddleDraft<D, P>[] {
    if (!identityKey || this.snapshot.identityKey !== identityKey) return [];
    const rows = [...this.snapshot.retired];
    const active = this.snapshot.active;
    // Expose the old draft during the render that retires a call, before the
    // scope effect runs; a controlled editor never receives a transient blank.
    if (active && huddleScopeKey(active.scope) !== huddleScopeKey(currentScope)
      && hasDraft(active.draft)) {
      const index = rows.findIndex(row => huddleScopeKey(row.scope) === huddleScopeKey(active.scope));
      if (index >= 0) rows[index] = active; else rows.push(active);
    }
    return rows;
  }
  setDraft(identityKey: string | null, scope: HuddleScope | null, draft: D): boolean {
    const active = this.active(identityKey, scope); if (!active) return false;
    if (active.draft !== draft) this.publish({ ...this.snapshot, active: { ...active, draft } });
    return true;
  }
  setPage(identityKey: string | null, scope: HuddleScope | null, page: P | null): boolean {
    const active = this.active(identityKey, scope); if (!active) return false;
    if (active.page !== page) this.publish({ ...this.snapshot, active: { ...active, page } });
    return true;
  }
  updateRetired(identityKey: string | null, currentScope: HuddleScope | null, callId: string, draft: D): boolean {
    const rows = this.retired(identityKey, currentScope).filter(row => row.scope.callId === callId);
    if (rows.length !== 1) return false;
    const row = rows[0], key = huddleScopeKey(row.scope);
    if (row === this.snapshot.active) {
      this.publish({ ...this.snapshot, active: { ...row, draft } });
    } else {
      this.publish({ ...this.snapshot, retired: this.snapshot.retired.map(saved => huddleScopeKey(saved.scope) === key ? { ...row, draft } : saved) });
    }
    return true;
  }
  discardRetired(identityKey: string | null, currentScope: HuddleScope | null, callId: string): boolean {
    const rows = this.retired(identityKey, currentScope).filter(row => row.scope.callId === callId);
    if (rows.length !== 1) return false;
    const key = huddleScopeKey(rows[0].scope);
    const active = rows[0] === this.snapshot.active
      ? { ...rows[0], draft: this.empty, page: null } : this.snapshot.active;
    this.publish({ ...this.snapshot, active, retired: this.snapshot.retired.filter(saved => huddleScopeKey(saved.scope) !== key) });
    return true;
  }
}
