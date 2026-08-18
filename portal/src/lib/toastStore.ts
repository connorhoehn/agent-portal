// Toast store — lightweight module-level pub/sub (same pattern as canaryStore).
// Drives the global <ToastHost /> stack in Layout. Designed for long-running
// operations: a `pending` toast can be updated in place (progress text) and
// then resolved to success/error, so provisioning flows read as one live card
// rather than a burst of disconnected notifications.

export type ToastKind = 'pending' | 'success' | 'error' | 'info';

export interface Toast {
  id: string;
  kind: ToastKind;
  title: string;
  detail?: string;
  createdAt: number;
}

let toasts: Toast[] = [];
const listeners = new Set<() => void>();
let seq = 0;
const timers = new Map<string, ReturnType<typeof setTimeout>>();

const SUCCESS_TTL_MS = 6000;
const ERROR_TTL_MS = 8000;
const INFO_TTL_MS = 5000;

function emit(): void {
  for (const l of listeners) l();
}

export function subscribeToasts(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function getToasts(): Toast[] {
  return toasts;
}

function scheduleDismiss(id: string, ttl: number): void {
  const existing = timers.get(id);
  if (existing) clearTimeout(existing);
  timers.set(id, setTimeout(() => dismissToast(id), ttl));
}

export function dismissToast(id: string): void {
  const t = timers.get(id);
  if (t) { clearTimeout(t); timers.delete(id); }
  if (!toasts.some(x => x.id === id)) return;
  toasts = toasts.filter(x => x.id !== id);
  emit();
}

/** Start a live operation toast (spinner). Returns the id for later updates. */
export function toastPending(title: string, detail?: string): string {
  const id = `t-${++seq}`;
  toasts = [...toasts, { id, kind: 'pending', title, ...(detail !== undefined ? { detail } : {}), createdAt: Date.now() }];
  emit();
  return id;
}

/** Update a pending toast's text in place (progress feedback). */
export function toastUpdate(id: string, patch: { title?: string; detail?: string }): void {
  let changed = false;
  toasts = toasts.map(t => {
    if (t.id !== id) return t;
    changed = true;
    return { ...t, ...(patch.title !== undefined ? { title: patch.title } : {}), ...(patch.detail !== undefined ? { detail: patch.detail } : {}) };
  });
  if (changed) emit();
}

function resolve(id: string | null, kind: ToastKind, title: string, detail: string | undefined, ttl: number): string {
  if (id && toasts.some(t => t.id === id)) {
    toasts = toasts.map(t => (t.id === id ? { ...t, kind, title, ...(detail !== undefined ? { detail } : { detail: undefined as unknown as string }) } : t));
    emit();
    scheduleDismiss(id, ttl);
    return id;
  }
  const nid = `t-${++seq}`;
  toasts = [...toasts, { id: nid, kind, title, ...(detail !== undefined ? { detail } : {}), createdAt: Date.now() }];
  emit();
  scheduleDismiss(nid, ttl);
  return nid;
}

/** Resolve a pending toast (or fire a standalone one) as success. */
export function toastSuccess(id: string | null, title: string, detail?: string): string {
  return resolve(id, 'success', title, detail, SUCCESS_TTL_MS);
}

/** Resolve a pending toast (or fire a standalone one) as error. */
export function toastError(id: string | null, title: string, detail?: string): string {
  return resolve(id, 'error', title, detail, ERROR_TTL_MS);
}

/** One-shot informational toast. */
export function toastInfo(title: string, detail?: string): string {
  return resolve(null, 'info', title, detail, INFO_TTL_MS);
}
