// The candidate's résumé, read in place (docs/interviews-tenant-plan.md row I1.6, contract C7): the record from
// GET /api/interviews/candidates/:id/resume, the file from …/resume/file in the library's PdfViewer with the
// session's cookies. No résumé, or a file that will not open, is one plain line. It takes its height from the
// container it is placed in. This is the only file that imports the viewer (and, through lib/pdfWorker, pdf.js).

import { PdfViewer } from '@connorhoehn/ui-components/pdf-viewer';
import { Stack, T } from '@connorhoehn/ui-components/shared';
import { useState } from 'react';
import { isNotFoundError } from '../../components/UnavailableNotice';
import { useFetch } from '../../hooks/useFetch';
import '../../lib/pdfWorker';
import { resumeFilePath, resumePath, type ResumeRecord } from '../../lib/interviewsResume';

/** `version` changes when the file was replaced, so the viewer reads the new one. */
export default function ResumeViewer({ candidateId, version = 0 }: { candidateId: string; version?: number }) {
  const { data, error, isLoading } = useFetch<{ resume: ResumeRecord }>(candidateId ? `${resumePath(candidateId)}?v=${version}` : null);
  const [failedId, setFailedId] = useState<string | null>(null);
  // A not-found answer after a removal wins over the file read before it (useFetch keeps its last data on an error).
  const resume = error && isNotFoundError(error) ? undefined : data?.resume;

  if (!resume) {
    if (isLoading && !error) return <T size="sm" tone="secondary" data-testid="interviews-resume-loading">Loading the résumé…</T>;
    return (
      <T size="sm" tone="secondary" data-testid="interviews-resume-none">
        {!error || isNotFoundError(error) ? 'No résumé has been added yet.' : 'The résumé could not be read. Try again in a moment.'}
      </T>
    );
  }
  if (failedId === resume.id) {
    return <T size="sm" tone="secondary" data-testid="interviews-resume-unreadable">This résumé could not be opened.</T>;
  }
  return (
    <Stack gap="none" className="h-full min-h-0 w-full" data-testid="interviews-resume-viewer">
      <PdfViewer key={`${resume.id}:${version}`} src={`${resumeFilePath(candidateId)}?v=${encodeURIComponent(resume.id)}`} withCredentials
        title={resume.fileName} className="h-full" onError={() => setFailedId(resume.id)} />
    </Stack>
  );
}
