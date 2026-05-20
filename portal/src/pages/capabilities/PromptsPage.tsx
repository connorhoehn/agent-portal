// Read-only browser of the prompt-version registry.
//
// Backed by GET /api/observability/prompt-versions. Each row in
// `observability.prompt_versions` is content-addressed by a 12-char short
// SHA of the system prompt; the canonical text is preserved in `content`.
// The UI exposes that registry as a searchable table and renders the
// canonical prompt text in a read-only modal CodeEditor.
//
// No mutation calls — the runner registers prompts at agent boot.

import { useEffect, useMemo, useState } from 'react';
import {
  PageSection,
  Card,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableTh,
  TableTd,
  Modal,
  CodeEditor,
  EmptyState,
  Chip,
  Banner,
  FormField,
  IconButton,
} from '@connorhoehnslalom/ui-components/shared';

// ─── Types ────────────────────────────────────────────────────────────────────

interface PromptVersion {
  promptVersion: string;     // 12-char short SHA
  agentId: string;
  content: string;
  contentSha256: string;
  registeredAt: string;      // ISO/postgres timestamp text
  notes: string | null;
}

interface PromptVersionsResponse {
  versions: PromptVersion[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatTimestamp(raw: string): string {
  if (!raw) return '—';
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  return d.toLocaleString();
}

// ─── Page ─────────────────────────────────────────────────────────────────────

function PromptsPage() {
  const [data, setData] = useState<PromptVersion[] | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>('');
  const [selected, setSelected] = useState<PromptVersion | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch('/api/observability/prompt-versions', {
          credentials: 'include',
        });
        if (!res.ok) {
          throw new Error(`Registry fetch failed: ${res.status} ${res.statusText}`);
        }
        const body = (await res.json()) as PromptVersionsResponse;
        if (cancelled) return;
        setData(Array.isArray(body.versions) ? body.versions : []);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load prompt registry');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo<PromptVersion[]>(() => {
    if (!data) return [];
    const q = filter.trim().toLowerCase();
    if (!q) return data;
    return data.filter((row) => {
      return (
        row.agentId.toLowerCase().includes(q) ||
        row.content.toLowerCase().includes(q) ||
        row.promptVersion.toLowerCase().includes(q)
      );
    });
  }, [data, filter]);

  return (
    <div style={{ padding: 24 }} data-testid="prompts-page">
      <PageSection
        title="Prompt Registry"
        description="Content-addressed system prompts registered by each agent at boot. Click a row to view the canonical text."
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {error && (
            <Banner variant="error" title="Failed to load" data-testid="prompts-error">
              {error}
            </Banner>
          )}

          <Card padding="md">
            <div style={{ marginBottom: 12, maxWidth: 480 }}>
              <FormField label="Filter" hint="Free-text search across agent ID, prompt SHA, and content.">
                {(wiring) => (
                  <input
                    {...wiring}
                    type="text"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    placeholder="e.g. orgiq-search or 'You are an expert…'"
                    data-testid="prompts-filter"
                    style={{
                      width: '100%',
                      padding: '6px 10px',
                      fontSize: 13,
                      border: '1px solid var(--color-border)',
                      borderRadius: 'var(--radius-md)',
                      background: 'var(--color-surface)',
                      color: 'var(--color-text-primary)',
                    }}
                  />
                )}
              </FormField>
            </div>

            {loading ? (
              <div
                data-testid="prompts-loading"
                style={{ padding: 24, textAlign: 'center', color: 'var(--color-text-secondary)', fontSize: 13 }}
              >
                Loading prompt registry…
              </div>
            ) : !data || data.length === 0 ? (
              <EmptyState
                title="No prompts registered yet"
                body="Prompt versions are registered by each agent at boot. Once an agent runs against the harness or live traffic, its system prompt will appear here."
                testId="prompts-empty"
              />
            ) : filtered.length === 0 ? (
              <EmptyState
                title="No matches"
                body={`Nothing in the registry matches "${filter}". Clear the filter to see all ${data.length} entries.`}
                testId="prompts-empty-filtered"
              />
            ) : (
              <Table data-testid="prompts-table">
                <TableHead>
                  <TableRow>
                    <TableTh>Agent ID</TableTh>
                    <TableTh>Prompt Version</TableTh>
                    <TableTh>Registered</TableTh>
                    <TableTh>Promoted</TableTh>
                    <TableTh>Notes</TableTh>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {filtered.map((row) => (
                    <TableRow
                      key={row.promptVersion}
                      data-testid={`prompts-row-${row.promptVersion}`}
                      onClick={() => setSelected(row)}
                      style={{ cursor: 'pointer' }}
                    >
                      <TableTd style={{ fontWeight: 500 }}>{row.agentId}</TableTd>
                      <TableTd>
                        <Chip tone="info" size="xs" mono>
                          {row.promptVersion}
                        </Chip>
                      </TableTd>
                      <TableTd style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
                        {formatTimestamp(row.registeredAt)}
                      </TableTd>
                      <TableTd style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>
                        {/* Promoted columns (promoted_at/by) are not yet exposed by the
                            registry endpoint — show an em dash until the schema lands. */}
                        —
                      </TableTd>
                      <TableTd style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
                        {row.notes ?? '—'}
                      </TableTd>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Card>
        </div>
      </PageSection>

      <Modal
        open={selected !== null}
        onClose={() => setSelected(null)}
        title={selected ? `${selected.agentId} · ${selected.promptVersion}` : ''}
        maxWidth={840}
        backdropTestId="prompts-modal-backdrop"
        footer={
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <IconButton
              aria-label="Close prompt viewer"
              onClick={() => setSelected(null)}
              data-testid="prompts-modal-close"
            >
              Close
            </IconButton>
          </div>
        }
      >
        {selected && (
          <div data-testid="prompts-modal" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', gap: 16, fontSize: 12, color: 'var(--color-text-secondary)' }}>
              <span>
                <strong style={{ color: 'var(--color-text-tertiary)' }}>Registered:</strong>{' '}
                {formatTimestamp(selected.registeredAt)}
              </span>
              <span style={{ fontFamily: 'var(--font-mono, monospace)' }}>
                <strong style={{ color: 'var(--color-text-tertiary)' }}>SHA-256:</strong>{' '}
                {selected.contentSha256.slice(0, 16)}…
              </span>
            </div>
            <CodeEditor
              value={selected.content}
              onChange={() => {
                /* read-only */
              }}
              language="template"
              readOnly
              minLines={8}
              maxLines={28}
              aria-label="Prompt content (read-only)"
            />
          </div>
        )}
      </Modal>
    </div>
  );
}

export default PromptsPage;
