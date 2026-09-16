import { useEffect, useRef, useState } from 'react';
import {
  Button, Chip, CodeBlock, DataTable, Inline, InlineAlert, MetaLine, Spinner, Stack,
} from '@connorhoehnslalom/ui-components/shared';
import type { DataTableColumn } from '@connorhoehnslalom/ui-components/shared';
import { useCapabilities } from '../../lib/capabilities';
import { relativeTime } from '../../lib/relativeTime';

// ─── Types ────────────────────────────────────────────────────────────────────

interface LandingZoneFile {
  key: string;
  size: number;
  lastModified: string;
  extension: string;
}

interface FilesResponse {
  files: LandingZoneFile[];
  nextToken: string | null;
}

// ─── Props ────────────────────────────────────────────────────────────────────

export interface LandingZoneBrowserProps {
  kbId: string;
  s3Prefix: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function truncateKey(key: string, max = 60): string {
  if (key.length <= max) return key;
  return '…' + key.slice(-(max - 1));
}

// ─── Component ────────────────────────────────────────────────────────────────

export function LandingZoneBrowser({ kbId, s3Prefix }: LandingZoneBrowserProps) {
  // Uploads POST /api/admin/kb-registry landing-zone (ManageKB); listing stays.
  const { can, ready } = useCapabilities();
  const canManage = ready && can('ManageKB');
  const [files, setFiles] = useState<LandingZoneFile[]>([]);
  const [nextToken, setNextToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // ─── Fetch helpers ──────────────────────────────────────────────────────────

  async function fetchFiles(token?: string) {
    setLoading(true);
    setError(null);
    try {
      const url = token
        ? `/api/admin/kb-registry/${kbId}/landing-zone/files?limit=50&nextToken=${encodeURIComponent(token)}`
        : `/api/admin/kb-registry/${kbId}/landing-zone/files?limit=50`;

      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data: FilesResponse = await res.json();

      setFiles(prev => token ? [...prev, ...data.files] : data.files);
      setNextToken(data.nextToken);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load files');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void fetchFiles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kbId]);

  // ─── Upload ─────────────────────────────────────────────────────────────────

  async function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    // Reset input so the same file can be re-selected
    e.target.value = '';

    setUploading(true);
    setError(null);

    try {
      const form = new FormData();
      form.append('file', file);

      const res = await fetch(
        `/api/admin/kb-registry/${kbId}/landing-zone/upload`,
        { method: 'POST', credentials: 'include', body: form },
      );

      if (!res.ok) throw new Error(`Upload failed: HTTP ${res.status}`);

      const data: { file: LandingZoneFile } = await res.json();
      setFiles(prev => [data.file, ...prev]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }

  // ─── Table columns ──────────────────────────────────────────────────────────

  const columns: DataTableColumn<LandingZoneFile>[] = [
    {
      key: 'key',
      header: 'Key',
      render: (f) => (
        <Inline gap="xs" wrap={false}>
          <Inline as="span" gap="none" title={f.key} className="font-mono text-[12px]">
            {truncateKey(f.key)}
          </Inline>
          {f.extension && (
            <Chip tone="neutral" size="xs" uppercase>
              {f.extension.replace(/^\./, '')}
            </Chip>
          )}
        </Inline>
      ),
    },
    {
      key: 'size',
      header: 'Size',
      render: (f) => <MetaLine className="text-right font-mono" items={[humanSize(f.size)]} />,
    },
    {
      key: 'lastModified',
      header: 'Modified',
      render: (f) => <MetaLine className="text-right whitespace-nowrap" items={[relativeTime(f.lastModified)]} />,
    },
  ];

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <Stack gap="md">
      {/* Header row */}
      <Inline gap="sm" justify="between" wrap>
        <CodeBlock className="text-[12px]" code={`s3://<bucket>/${s3Prefix}`} />

        {canManage && (
          <Button
            variant="primary"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="shrink-0"
          >
            {uploading ? (
              <>
                <Spinner size="sm" color="var(--color-surface)" />
                Uploading…
              </>
            ) : (
              'Upload File'
            )}
          </Button>
        )}

        {/* Hidden file input — the HTML `hidden` attribute, not a class. It
            is the only affordance behind the Upload button, there is nothing
            for a primitive to own, and with no className it is not a styled
            raw element either. */}
        <input
          ref={fileInputRef}
          type="file"
          hidden
          onChange={handleFileSelected}
        />
      </Inline>

      {/* Error banner */}
      {error && <InlineAlert tone="error">{error}</InlineAlert>}

      {/* Table */}
      <DataTable
        data={files}
        columns={columns}
        keyField={(f) => f.key}
        loading={loading && files.length === 0}
        emptyMessage={(
          <Stack gap="none" align="center" className="py-8 px-4 text-center">
            <MetaLine className="leading-normal" items={['No files in this landing zone yet.']} />
            <MetaLine size="xs" items={['Upload a document to get started.']} />
          </Stack>
        )}
      />

      {/* Load More */}
      {nextToken && (
        <Button
          variant="secondary"
          size="sm"
          disabled={loading}
          onClick={() => void fetchFiles(nextToken)}
          className="self-start"
        >
          {loading ? 'Loading…' : 'Load More'}
        </Button>
      )}
    </Stack>
  );
}

export default LandingZoneBrowser;
