// The read-only viewer for a runbook's skill files, shared by the runbook page and the proposal review.
// File content is untrusted (a box wrote it): CodeBlock always gets language "text", the one path that only
// HTML-escapes. The other languages inject highlighted <span style> markup via dangerouslySetInnerHTML.
import { CodeBlock, Disclosure, Inline, Stack, T } from '@connorhoehn/ui-components/shared';
import { fileLanguageLabel, fileModeLabel, formatBytes, shortSha } from './runbooksModel';
import type { RunbookFile } from './types';

export function RunbookFiles({ files, testId = 'runbook-files' }: { files: readonly RunbookFile[]; testId?: string }) {
  return (
    <Stack gap="xs" data-testid={testId}>
      {files.map((f) => (
        <Disclosure
          key={f.path} variant="plain" density="compact" data-testid="runbook-file"
          summary={(
            <Inline gap="sm" align="center">
              <T size="sm" className="font-mono">{f.path}</T>
              <T size="xs" tone="tertiary">{`${fileLanguageLabel(f.path)} · ${formatBytes(f.size)} · ${fileModeLabel(f.mode)} · ${shortSha(f.sha256)}`}</T>
            </Inline>
          )}
        >
          <CodeBlock code={f.content} language="text" copyButton showLineNumbers ariaLabel={`Contents of ${f.path}`} />
        </Disclosure>
      ))}
    </Stack>
  );
}
