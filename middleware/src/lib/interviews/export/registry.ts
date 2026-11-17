// The registry of export sections (contract E8, row I6.2): what Milo showed on one interview, section by section. Each
// lane that keeps a log of what Milo showed registers one `read`; the export service calls every one of them by key.
// A section that throws leaves its key with an error code in the document, never a failed export (service.ts).

export interface ExportSection {
  key: string;
  read(interviewId: string): Promise<unknown>;
}

const sections = new Map<string, ExportSection>();

/** Add a section; registering a key again replaces the earlier one (a module may load twice under test). */
export function registerExportSection(s: ExportSection): void {
  sections.set(s.key, s);
}

export function exportSections(): ExportSection[] {
  return [...sections.values()];
}

/** Test seam: drop every section a test added. */
export function clearExportSections(): void {
  sections.clear();
}
