import { useState } from 'react';
import { Button, Card, CardHeader, CatalogGrid, Inline, InlineAlert, InlinePlaceholder, Input, SectionLabel, Stack } from '@connorhoehnslalom/ui-components/shared';
import { useCapabilities } from '../../../lib/capabilities';
import { askPage } from './browserApi';
import type { WebQAResult } from './types';
import { T } from '../Text';

/**
 * Web Q&A: URL + question → screenshot + Nova Lite answer.
 *
 * Spinning up a real browser microVM is a /api/capabilities mutation, so the
 * form is gated on ManageDevbox; the explanation stays visible to everyone.
 */
export function WebQATab() {
  const { can, ready } = useCapabilities();
  const canManage = ready && can('ManageDevbox');

  const [url, setUrl] = useState('https://example.com');
  const [question, setQuestion] = useState('What is this page about?');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<WebQAResult | null>(null);

  const canAsk = Boolean(url.trim() && question.trim()) && !busy;

  async function ask() {
    if (!canAsk) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await askPage(url, question));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card padding="none" className="overflow-hidden">
      <CardHeader inset
        title="Ask a webpage"
        subtitle="Spins up a sandboxed Chrome, screenshots the page, sends it + your question to Nova Lite (multimodal). Returns an answer grounded in the visible content."
      />
      <Stack gap="md" className="px-3.5 py-3">
        {canManage ? (
          <Stack gap="sm">
            <Input
              type="url"
              value={url}
              onChange={e => setUrl(e.target.value)}
              placeholder="https://..."
              aria-label="Page URL"
            />
            <Input
              value={question}
              onChange={e => setQuestion(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void ask(); }}
              placeholder="What do you want to know about this page?"
              aria-label="Question"
            />
            <Inline gap="sm" justify="end">
              <Button variant="primary" onClick={() => { void ask(); }} disabled={!canAsk}>
                {busy ? 'Asking…' : 'Ask the page'}
              </Button>
            </Inline>
          </Stack>
        ) : (
          <InlinePlaceholder>Viewing only — your role can&apos;t drive the browser.</InlinePlaceholder>
        )}

        {error && <InlineAlert tone="error">{error}</InlineAlert>}

        {result && <WebQAResultPanes result={result} />}
      </Stack>
    </Card>
  );
}


function WebQAResultPanes({ result }: { result: WebQAResult }) {
  return (
    <CatalogGrid columns={2} dense>
      <Stack gap="xs">
        <SectionLabel>Screenshot ({result.pageTitle || result.url})</SectionLabel>
        {result.imageDataUrl ? (
          <Card padding="none" className="overflow-hidden">
            <img src={result.imageDataUrl} alt="Screenshot of the requested page" className="block w-full" />
          </Card>
        ) : (
          <InlinePlaceholder>No screenshot was captured.</InlinePlaceholder>
        )}
      </Stack>
      <Stack gap="xs">
        <SectionLabel>Answer</SectionLabel>
        <T className="whitespace-pre-wrap text-[13px] leading-relaxed text-text-primary" wrap>{result.answer}</T>
      </Stack>
    </CatalogGrid>
  );
}
