import { useCallback, useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import { canvasRecoveryKey, encodeCanvasRecovery, decodeCanvasRecovery, type CanvasRecovery } from './canvasRecovery';

/** Tab-local recovery is partitioned by verified identity and document; it never stores grants. */
export function useCanvasRecovery(tenant: string, subject: string, documentId: string) {
  const key = canvasRecoveryKey(tenant, subject, documentId);
  const [recovered, setRecovered] = useState<CanvasRecovery | null>(() => {
    try {
      const stored = JSON.parse(sessionStorage.getItem(key) ?? 'null');
      return decodeCanvasRecovery(stored?.recovered ?? stored?.pending) ? stored.recovered ?? stored.pending : null;
    } catch { return null; }
  });
  const recoveredRef = useRef(recovered);
  const pendingRef = useRef<CanvasRecovery | null>(null);
  const [storageError, setStorageError] = useState(false);
  const write = useCallback(() => {
    try {
      if (!recoveredRef.current && !pendingRef.current) sessionStorage.removeItem(key);
      else sessionStorage.setItem(key, JSON.stringify({ recovered: recoveredRef.current, pending: pendingRef.current }));
      setStorageError(false);
    } catch { setStorageError(true); }
  }, [key]);
  const retain = useCallback((bytes: Uint8Array) => {
    recoveredRef.current = encodeCanvasRecovery(bytes);
    setRecovered(recoveredRef.current);
    write();
  }, [write]);
  const clear = useCallback(() => {
    recoveredRef.current = null;
    setRecovered(null);
    write();
  }, [write]);
  const track = useCallback((ydoc: Y.Doc | null, provider: { pendingUpdateCount: number } | null) => {
    if (!ydoc || !provider) return () => {};
    const preservePending = () => {
      if (!provider.pendingUpdateCount) return;
      pendingRef.current = encodeCanvasRecovery(Y.encodeStateAsUpdate(ydoc));
      write();
    };
    ydoc.on('update', preservePending);
    preservePending();
    return () => ydoc.off('update', preservePending);
  }, [write]);
  const acknowledged = useCallback(() => { pendingRef.current = null; write(); }, [write]);
  useEffect(() => { write(); }, [write]);
  const download = useCallback(() => {
    const bytes = decodeCanvasRecovery(recoveredRef.current ?? pendingRef.current);
    if (!bytes) return;
    const url = URL.createObjectURL(new Blob([Uint8Array.from(bytes)], { type: 'application/octet-stream' }));
    const link = document.createElement('a'); link.href = url; link.download = `document-${documentId}-recovery.yjs`; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [documentId]);
  return { recovered, storageError, retain, clear, track, acknowledged, download,
    restore: (ydoc: Y.Doc) => { const bytes = decodeCanvasRecovery(recoveredRef.current); if (bytes) { Y.applyUpdate(ydoc, bytes, 'explicit-recovery'); clear(); } },
  };
}
