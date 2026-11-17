// A candidate's résumé (docs/interviews-tenant-plan.md, row I1.6): the stored file's record. The bytes
// are never in the row; they live behind the bytes store (bytes-store.ts) under `storageKey`.
// A résumé is personal data about someone who is not a user, uploaded as a file from outside, so the
// record keeps only what is needed to show it, to check it and to find it again.

export const RESUME_CONTENT_TYPE = 'application/pdf';

export interface ResumeRecord {
  id: string;
  candidateId: string;
  /** The name as shown: cleaned (rules.ts cleanFileName), never used to build the storage key. */
  fileName: string;
  sizeBytes: number;
  /** Always `application/pdf`. */
  contentType: typeof RESUME_CONTENT_TYPE;
  /** Lower-case hex SHA-256 of the bytes. */
  sha256: string;
  uploadedBy: string;
  uploadedAt: string;
  /** Where the bytes are (rules.ts resumeStorageKey). Never leaves the server. */
  storageKey: string;
}
