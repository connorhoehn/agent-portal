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
import {
  Button, Chip, CodeBlock, InlineAlert, MetaLine, Modal, SectionLabel, Stack,
} from '@connorhoehn/ui-components/shared';
import { KeyValue } from '../KeyValue';
import { absoluteTime } from '../../lib/relativeTime';

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
      {/* A ghost Button stripped to nothing so the Chip is the whole visual —
          the wrapper exists only to make the chip activatable, since Chip has
          no onClick. */}
      <Button
        variant="ghost"
        size="sm"
        className="inline-flex p-0 m-0 border-none bg-transparent h-auto"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        title={`prompt version ${promptVersion} — click for details`}
      >
        <Chip tone="neutral" size={size} mono>
          {label}
        </Chip>
      </Button>
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
      <MetaLine
        className="mb-3 font-mono"
        items={[`p:${promptVersion.slice(0, 12)}`]}
      />

      {loading && <MetaLine items={['Loading…']} />}

      {err && <InlineAlert tone="error">Could not load prompt version: {err}</InlineAlert>}

      {detail && (
        <Stack gap="none">
          {/* Label/value pairs. The markup this replaces used a two-column CSS
              grid; Inline rows read the same and keep each pair together when
              a long sha wraps. */}
          <Stack gap="xs" className="mb-4">
            <KeyValue layout="row" labelWidth="w-24" label="Agent" value={detail.agentId} mono />
            <KeyValue layout="row" labelWidth="w-24" label="Registered" value={absoluteTime(detail.registeredAt)} />
            <KeyValue layout="row" labelWidth="w-24" label="SHA-256" value={detail.contentSha256} mono className="break-all" />
            {detail.notes && (
              <KeyValue layout="row" labelWidth="w-24" label="Notes" value={detail.notes} />
            )}
          </Stack>

          <SectionLabel className="mb-1">System prompt</SectionLabel>
          {/* CodeBlock owns the mono face, the scroll and the wrapping. */}
          <CodeBlock
            code={detail.content}
            className="text-xs max-h-[50vh] overflow-y-auto whitespace-pre-wrap break-words"
            ariaLabel="System prompt content"
          />
        </Stack>
      )}
    </>
  );
}

export default PromptVersionChip;
