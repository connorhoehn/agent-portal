import { useEffect, useRef, useState } from 'react';
import { Spinner } from '@connorhoehnslalom/ui-components/shared';

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

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function truncateKey(key: string, max = 60): string {
  if (key.length <= max) return key;
  return '…' + key.slice(-(max - 1));
}

// ─── Component ────────────────────────────────────────────────────────────────

export function LandingZoneBrowser({ kbId, s3Prefix }: LandingZoneBrowserProps) {
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

      const res = await fetch(url);
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
        { method: 'POST', body: form },
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

  // ─── Shared table styles ────────────────────────────────────────────────────

  const thStyle: React.CSSProperties = {
    padding: '8px 12px',
    fontSize: 11,
    fontWeight: 600,
    color: '#6b7280',
    textAlign: 'left',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    borderBottom: '1px solid #e5e7eb',
    background: '#f9fafb',
    whiteSpace: 'nowrap',
  };

  const tdStyle: React.CSSProperties = {
    padding: '8px 12px',
    fontSize: 12,
    color: '#374151',
    borderBottom: '1px solid #f3f4f6',
    verticalAlign: 'middle',
  };

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Header row */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 8,
        }}
      >
        <code
          style={{
            fontSize: 12,
            background: '#f3f4f6',
            border: '1px solid #e5e7eb',
            borderRadius: 4,
            padding: '4px 8px',
            color: '#374151',
            wordBreak: 'break-all',
          }}
        >
          s3://&lt;bucket&gt;/{s3Prefix}
        </code>

        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '6px 14px',
            fontSize: 12,
            fontWeight: 600,
            background: uploading ? '#93c5fd' : '#2563eb',
            color: '#fff',
            border: 'none',
            borderRadius: 6,
            cursor: uploading ? 'not-allowed' : 'pointer',
            flexShrink: 0,
          }}
        >
          {uploading ? (
            <>
              <Spinner size="sm" color="#fff" />
              Uploading…
            </>
          ) : (
            'Upload File'
          )}
        </button>

        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          style={{ display: 'none' }}
          onChange={handleFileSelected}
        />
      </div>

      {/* Error banner */}
      {error && (
        <div
          style={{
            padding: '8px 12px',
            background: '#fef2f2',
            border: '1px solid #fecaca',
            borderRadius: 6,
            fontSize: 12,
            color: '#dc2626',
          }}
        >
          {error}
        </div>
      )}

      {/* Table */}
      <div
        style={{
          border: '1px solid #e5e7eb',
          borderRadius: 8,
          overflow: 'hidden',
        }}
      >
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={thStyle}>Key</th>
              <th style={{ ...thStyle, textAlign: 'right' }}>Size</th>
              <th style={{ ...thStyle, textAlign: 'right' }}>Modified</th>
            </tr>
          </thead>
          <tbody>
            {loading && files.length === 0 ? (
              <tr>
                <td
                  colSpan={3}
                  style={{
                    ...tdStyle,
                    textAlign: 'center',
                    color: '#9ca3af',
                    padding: '32px 0',
                  }}
                >
                  Loading…
                </td>
              </tr>
            ) : files.length === 0 ? (
              <tr>
                <td
                  colSpan={3}
                  style={{
                    ...tdStyle,
                    textAlign: 'center',
                    color: '#9ca3af',
                    padding: '32px 16px',
                    lineHeight: 1.5,
                  }}
                >
                  No files in this landing zone yet.
                  <br />
                  <span style={{ fontSize: 11 }}>
                    Upload a document to get started.
                  </span>
                </td>
              </tr>
            ) : (
              files.map((f, i) => (
                <tr
                  key={`${f.key}-${i}`}
                  style={{ background: i % 2 === 0 ? '#fff' : '#fafafa' }}
                >
                  <td style={tdStyle}>
                    <span
                      title={f.key}
                      style={{ fontFamily: 'monospace', fontSize: 12 }}
                    >
                      {truncateKey(f.key)}
                    </span>
                    {f.extension && (
                      <span
                        style={{
                          marginLeft: 6,
                          padding: '1px 5px',
                          background: '#f3f4f6',
                          border: '1px solid #e5e7eb',
                          borderRadius: 3,
                          fontSize: 10,
                          color: '#6b7280',
                          textTransform: 'uppercase',
                        }}
                      >
                        {f.extension.replace(/^\./, '')}
                      </span>
                    )}
                  </td>
                  <td
                    style={{
                      ...tdStyle,
                      textAlign: 'right',
                      fontFamily: 'monospace',
                      color: '#6b7280',
                    }}
                  >
                    {humanSize(f.size)}
                  </td>
                  <td
                    style={{
                      ...tdStyle,
                      textAlign: 'right',
                      color: '#9ca3af',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {relativeTime(f.lastModified)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Load More */}
      {nextToken && (
        <button
          disabled={loading}
          onClick={() => void fetchFiles(nextToken)}
          style={{
            alignSelf: 'flex-start',
            padding: '6px 14px',
            fontSize: 12,
            background: '#fff',
            border: '1px solid #d1d5db',
            borderRadius: 6,
            cursor: loading ? 'not-allowed' : 'pointer',
            color: '#374151',
          }}
        >
          {loading ? 'Loading…' : 'Load More'}
        </button>
      )}
    </div>
  );
}

export default LandingZoneBrowser;
