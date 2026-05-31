// PromptVersionChip — renders 'p:8a7f3e2c' for a prompt-version sha and opens
// a modal with the full system prompt on click.
//
// Backend contract:
//   GET /api/observability/prompt-versions/:promptVersion →
//     { version: { promptVersion, agentId, content, contentSha256,
//                  registeredAt, notes } }
//
// In production traces, promptVersion may be null until Agent A's migration
// lands — render '—' chip with no click handler in that case.

import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { Chip, Modal } from '@connorhoehnslalom/ui-components/shared';

interface PromptVersionDetail {
  promptVersion: string;
  agentId: string;
  content: string;
  contentSha256: string;
  registeredAt: string;
  notes: string | null;
}

interface Props {
  promptVersion: string | null | undefined;
  size?: 'xs' | 'sm';
}

export function PromptVersionChip({ promptVersion, size = 'xs' }: Props) {
  const [open, setOpen] = useState(false);

  if (!promptVersion) {
    return (
      <Chip tone="neutral" size={size}>
        —
      </Chip>
    );
  }

  const short = promptVersion.length > 8 ? promptVersion.slice(0, 8) : promptVersion;
  const label = `p:${short}`;

  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        style={chipBtnStyle}
        title={`prompt version ${promptVersion} — click for details`}
      >
        <Chip tone="neutral" size={size} mono>
          {label}
        </Chip>
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Prompt version"
        maxWidth={520}
      >
        <PromptVersionBody promptVersion={promptVersion} />
      </Modal>
    </>
  );
}

function PromptVersionBody({ promptVersion }: { promptVersion: string }) {
  const [detail, setDetail] = useState<PromptVersionDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    fetch(
      `/api/observability/prompt-versions/${encodeURIComponent(promptVersion)}`,
      { credentials: 'include' },
    )
      .then(async (r) => {
        if (!r.ok) {
          throw new Error(`${r.status} ${r.statusText}`);
        }
        return r.json();
      })
      .then((j: { version?: PromptVersionDetail }) => {
        if (cancelled) return;
        if (j?.version) {
          setDetail(j.version);
        } else {
          setErr('Response missing version field');
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setErr(e instanceof Error ? e.message : 'Fetch failed');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [promptVersion]);

  return (
    <>
      <div style={versionSubtitle}>
        <span style={monoStyle}>p:{promptVersion.slice(0, 12)}</span>
      </div>

      {loading && <div>Loading…</div>}

      {err && (
        <div style={{ color: 'var(--color-danger, #ef4444)' }}>
          Could not load prompt version: {err}
        </div>
      )}

      {detail && (
        <div>
          <div style={metaGrid}>
            <div style={metaLabel}>AGENT</div>
            <div style={metaValue}>
              <span style={monoStyle}>{detail.agentId}</span>
            </div>
            <div style={metaLabel}>REGISTERED</div>
            <div style={metaValue}>
              {new Date(detail.registeredAt).toLocaleString()}
            </div>
            <div style={metaLabel}>SHA-256</div>
            <div style={metaValue}>
              <span style={monoStyle}>{detail.contentSha256}</span>
            </div>
            {detail.notes && (
              <>
                <div style={metaLabel}>NOTES</div>
                <div style={metaValue}>{detail.notes}</div>
              </>
            )}
          </div>

          <div style={contentLabel}>SYSTEM PROMPT</div>
          <pre style={contentPre}>{detail.content}</pre>
        </div>
      )}
    </>
  );
}

// ── styles ────────────────────────────────────────────────────────────────────

const chipBtnStyle: CSSProperties = {
  background: 'transparent',
  border: 'none',
  padding: 0,
  margin: 0,
  cursor: 'pointer',
  display: 'inline-flex',
};

const monoStyle: CSSProperties = {
  fontFamily: 'ui-monospace, monospace',
};

const versionSubtitle: CSSProperties = {
  fontSize: 12,
  color: 'var(--color-text-tertiary)',
  marginBottom: 12,
};

const metaGrid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'max-content 1fr',
  gap: '6px 12px',
  marginBottom: 16,
  alignItems: 'baseline',
};

const metaLabel: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  color: 'var(--color-text-tertiary)',
  letterSpacing: 0.5,
};

const metaValue: CSSProperties = {
  fontSize: 12,
  color: 'var(--color-text-secondary)',
};

const contentLabel: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  color: 'var(--color-text-tertiary)',
  letterSpacing: 0.5,
  marginBottom: 4,
};

const contentPre: CSSProperties = {
  fontFamily: '"Fira Code", "Cascadia Code", monospace',
  fontSize: 11.5,
  lineHeight: 1.55,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  margin: 0,
  padding: '10px 12px',
  borderRadius: 4,
  background: 'var(--color-bg)',
  border: '1px solid var(--color-border)',
  maxHeight: '50vh',
  overflowY: 'auto',
  color: 'var(--color-text-primary)',
};

export default PromptVersionChip;
