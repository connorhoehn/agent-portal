// The files shared in one conversation, for the library's ChannelFilesPanel.
// The list is the BFF's (GET /api/uploads?channel=), which asks the same channel
// read authority and history floor as the download, so a reader is only ever
// shown files they could open. It refetches when the view opens and whenever a
// message carrying an attachment arrives.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ChannelFileItem } from '@connorhoehnslalom/ui-components/social';

interface WireFile { id: string; name: string; size: number; contentType: string; url: string; uploaderName: string; sentAt: string }
interface ChatMessageLike { id?: string; attachments?: ReadonlyArray<{ id?: string; url?: string }> }

export interface ChannelFilesState { files: ChannelFileItem[]; isLoading: boolean; error: string | null; refresh: () => void }

/** Which message a stored file arrived on, by the transfer id or the download URL it carries. */
export function messageIdForFile(messages: readonly ChatMessageLike[], file: Pick<WireFile, 'id' | 'url'>): string {
  const hit = messages.find(m => m.attachments?.some(a => a.url === file.url || a.id === file.id || (a.url ?? '').endsWith(`/${file.id}`)));
  return hit?.id ?? '';
}

export function useChannelFiles(channel: string | null, active: boolean, messages: readonly ChatMessageLike[] = []): ChannelFilesState {
  const [rows, setRows] = useState<{ channel: string; files: WireFile[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  // A new message may carry a file (its attachments, or its metadata, may not be mapped here), so any new message refetches.
  const attached = messages.length * 1000 + messages.reduce((n, m) => n + (m.attachments?.length ?? 0), 0);
  useEffect(() => {
    if (!channel || !active) return;
    const ctl = new AbortController();
    setLoading(true);
    fetch(`/api/uploads?channel=${encodeURIComponent(channel)}`, { credentials: 'include', signal: ctl.signal })
      .then(async res => {
        if (!res.ok) throw new Error(res.status === 403 ? 'You no longer have access to this conversation’s files.' : `Files are unavailable (${res.status}).`);
        const body = await res.json() as { files?: WireFile[] };
        setRows({ channel, files: body.files ?? [] }); setError(null);
      })
      .catch(err => { if (!ctl.signal.aborted) { setRows(null); setError(err instanceof Error ? err.message : 'Files are unavailable.'); } })
      .finally(() => { if (!ctl.signal.aborted) setLoading(false); });
    return () => ctl.abort();
  }, [channel, active, attached, tick]);
  const files = useMemo<ChannelFileItem[]>(() => rows && rows.channel === channel ? rows.files.map(f => ({
    messageId: messageIdForFile(messages, f),
    attachment: { id: f.id, name: f.name, size: f.size, contentType: f.contentType, url: f.url },
    author: f.uploaderName, sentAt: f.sentAt,
  })) : [], [rows, channel, messages]);
  const refresh = useCallback(() => setTick(n => n + 1), []);
  return { files, isLoading, error, refresh };
}
