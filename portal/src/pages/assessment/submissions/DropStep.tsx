// Step 1 of the Submissions wizard: drop / browse a Microsoft Forms export (.csv),
// then parse it. Structure mirrors the source app's DropStep.tsx; re-expressed on
// the library's FileUploadDrop instead of a hand-rolled dropzone.
//
// There is no multipart parser on the middleware and no CSV library dependency
// in this repo, so parsing happens here: the file is read as text and run through
// `parseFormsCsv` (secondaryFormat.ts), and the resulting header->value records
// are POSTed as JSON — the shape `POST /submissions/parse` actually accepts.
// `.xlsx` is not supported by this client-side path; the accept list is CSV-only
// and a stray .xlsx (e.g. dragged in despite the filter) gets an explanatory
// alert instead of a failed upload.

import { useState } from 'react';
import { Button, FileUploadDrop, Inline, InlineAlert, Stack } from '@connorhoehnslalom/ui-components/shared';
import { parseFormsCsv } from '../secondaryFormat';
import type { ParseResponse } from '../secondaryTypes';

const ACCEPT = '.csv';

interface DropStepProps {
  onParsed: (parse: ParseResponse) => void;
}

export default function DropStep({ onParsed }: DropStepProps) {
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [parsing, setParsing] = useState(false);

  function handleFiles(files: File[]) {
    setError(null);
    const next = files[0] ?? null;
    if (next && next.name.toLowerCase().endsWith('.xlsx')) {
      setFile(null);
      setUnsupported(true);
      return;
    }
    setUnsupported(false);
    setFile(next);
  }

  async function parse() {
    if (!file) return;
    setParsing(true);
    setError(null);
    try {
      const text = await file.text();
      const { records } = parseFormsCsv(text);
      const res = await fetch('/api/assessment/submissions/parse', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source_file: file.name, records }),
      });
      const body = (await res.json().catch(() => ({}))) as Partial<ParseResponse> & { error?: string };
      if (!res.ok) throw new Error(body.error ?? `Couldn't parse this file (HTTP ${res.status}).`);
      if (!Array.isArray(body.rows)) throw new Error("The parse response didn't include any rows.");
      onParsed(body as ParseResponse);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setParsing(false);
    }
  }

  return (
    <Stack gap="md">
      <Stack gap="none" className="text-sm text-text-secondary">
        Drop the Microsoft Forms export (.csv) for today&apos;s intake batch, or browse for it.
      </Stack>
      <FileUploadDrop
        accept={ACCEPT}
        onFiles={handleFiles}
        onError={setError}
        label={file ? file.name : 'Drop file, or click to browse — .csv exported from Microsoft Forms'}
      />
      {unsupported && (
        <InlineAlert tone="warning">
          Export the form as CSV — .xlsx parsing isn&apos;t supported here yet.
        </InlineAlert>
      )}
      {error && <InlineAlert tone="error">{error}</InlineAlert>}
      <Inline justify="end">
        <Button onClick={() => void parse()} disabled={!file || parsing}>
          {parsing ? 'Parsing…' : 'Parse file'}
        </Button>
      </Inline>
    </Stack>
  );
}
