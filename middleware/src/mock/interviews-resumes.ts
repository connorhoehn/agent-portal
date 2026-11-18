// The interviews tenant's résumé seed (docs/interviews-tenant-plan.md, row I1.6).
//
// One résumé for each seeded candidate who has an upcoming or a finished interview, so the Prepare page
// and the résumé viewer have something real to open. Nothing binary is committed: every file is built
// here, on demand, by `buildSimplePdf`, a pure function that writes a small valid one-page PDF. The text is
// fictional and fits the candidate's seeded role; no real person's details are in it.
//
// The rows are the registered fixture `interviews.resumes` (so `POST /api/__mock/reset` restores them);
// the candidate rows' `resumeFileId` pointer is `seededResumeFileId`, read by mock/interviews.ts. The memory
// bytes store (lib/interviews/resume/bytes-store.ts) answers a seeded key from `seededResumeBytes`.
//
// This file imports no candidate rows (mock/interviews.ts imports it), only the ids below.

import { createHash } from 'node:crypto';
import { clock, defineFixture } from './core/index.js';
import { RESUME_CONTENT_TYPE, type ResumeRecord } from '../lib/interviews/resume/types.js';

/** A minimal one-page PDF (Helvetica, US Letter) with `lines` of text, the first one larger. ASCII only. */
export function buildSimplePdf(lines: readonly string[]): Buffer {
  const esc = (s: string) => s.replace(/[^\x20-\x7e]/g, '?').replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const ops: string[] = ['BT', '/F1 18 Tf', '54 738 Td', '24 TL'];
  lines.forEach((line, i) => {
    if (i === 1) ops.push('/F1 11 Tf', '16 TL');
    ops.push(`(${esc(line)}) Tj`, 'T*');
  });
  ops.push('ET');
  const stream = ops.join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

interface Seed { name: string; headline: string; lines: string[]; uploadedDaysAgo: number }

const SEEDS: Record<string, Seed> = {
  'cand-rx6tcaqj': { name: 'Mateo Alvarez', headline: 'Backend engineer, ride-hailing marketplace', uploadedDaysAgo: 30, lines: [
    'Summary: Six years building pricing and dispatch services in Kotlin and Go.',
    'Tripline Mobility (4 years): built the trip-pricing service; cut p99 quote latency from 900 ms to 220 ms.',
    'Tripline Mobility: moved surge calculation to an event-driven pipeline; on call for the pricing stack.',
    'Cobalt Rides (2 years): payment retries, idempotency keys and a refunds ledger.',
    'Skills: Kotlin, Go, PostgreSQL, Kafka, distributed tracing.',
    'Education: BSc Computer Science, Fictional Polytechnic of Madrid.' ] },
  'cand-qz63q3a3': { name: 'Ingrid Solberg', headline: 'Senior software engineer, card issuing', uploadedDaysAgo: 33, lines: [
    'Summary: Nine years in card issuing and authorisation systems.',
    'Fjordcard (5 years): led the move of the card-authorisation service to a second region with no downtime.',
    'Fjordcard: introduced per-merchant rate limits and a replayable settlement log.',
    'Northgate Payments (4 years): built the dispute intake service in Java.',
    'Skills: Java, Kotlin, PostgreSQL, multi-region design, incident response.',
    'Education: MSc Informatics, Fictional University of Oslo.' ] },
  'cand-nx59ftdv': { name: 'Kwame Asante', headline: 'Software engineer, logistics platform', uploadedDaysAgo: 12, lines: [
    'Summary: Five years of backend work and maintainer of an open-source job queue library.',
    'Harbour Freight Systems (3 years): built the shipment-tracking API and its retry scheduler.',
    'Open source: maintainer of a small job queue library for Node.js (priorities, back-off, dead letters).',
    'Skills: TypeScript, Node.js, Redis, PostgreSQL, queue design.',
    'Education: BSc Computer Engineering, Fictional University of Coastal Ghana.' ] },
  'cand-s52jevud': { name: 'Aiko Tanaka', headline: 'iOS engineer, food delivery app', uploadedDaysAgo: 17, lines: [
    'Summary: Five years of iOS development, three of them on a food delivery app.',
    'Bento Run (3 years): shipped offline order history and the live courier map in Swift.',
    'Bento Run: moved checkout screens to SwiftUI; crash-free sessions from 98.9 to 99.7 percent.',
    'Pixel Mill Studio (2 years): client apps in UIKit and Objective-C.',
    'Skills: Swift, SwiftUI, Combine, Core Data, XCTest.',
    'Education: BEng Information Science, Fictional Institute of Technology Tokyo.' ] },
  'cand-w4pvy8m9': { name: 'Ravi Menon', headline: 'Mobile engineer, retail banking app', uploadedDaysAgo: 21, lines: [
    'Summary: Seven years of mobile engineering in retail banking.',
    'Lakeside Bank (4 years): led the move from UIKit to SwiftUI for two screens and wrote the migration guide.',
    'Lakeside Bank: built the transaction search with debounced, cancellable requests.',
    'Orchard Mobile (3 years): Android and iOS clients for a savings product.',
    'Skills: Swift, Kotlin, SwiftUI, accessibility, release engineering.',
    'Education: BTech Computer Science, Fictional Institute of Technology Pune.' ] },
  'cand-xbmv4nvd': { name: 'Nadia Petrova', headline: 'Engineering lead, developer tools', uploadedDaysAgo: 14, lines: [
    'Summary: Twelve years in engineering, the last five leading a developer tools group of eight.',
    'Sprocket Labs (5 years): lead of the build and release platform; cut mean build time by 40 percent.',
    'Sprocket Labs: set up the on-call rotation and the quarterly planning process for the group.',
    'Brightwire (7 years): engineer, then tech lead of the packaging team.',
    'Skills: people management, platform strategy, hiring, incident leadership.',
    'Education: MSc Computer Science, Fictional University of Sofia.' ] },
  'cand-zrtncmb2': { name: 'Jonah Whitaker', headline: 'Engineering manager, insurance platform', uploadedDaysAgo: 16, lines: [
    'Summary: Engineering manager of two teams on an insurance platform.',
    'Harbourline Insurance (6 years): manage fourteen engineers across quoting and claims.',
    'Harbourline Insurance: coached two engineers into tech lead roles; led a successful reorganisation of claims.',
    'Ledgerworks (5 years): senior engineer, then manager of the data team.',
    'Skills: delivery planning, performance conversations, stakeholder management.',
    'Education: BA Mathematics, Fictional College Dublin.' ] },
};

/** The seeded file id for a candidate, or null: the candidate rows' `resumeFileId`. */
export const seededResumeFileId = (candidateId: string): string | null => (SEEDS[candidateId] ? `rf-${candidateId.replace(/^cand-/, '')}` : null);
const keyOf = (candidateId: string): string => `interviews/resumes/${candidateId}/${seededResumeFileId(candidateId)}.pdf`;

const pdfOf = (seed: Seed): Buffer => buildSimplePdf([seed.name, seed.headline, ...seed.lines]);

/** The bytes of a seeded résumé by storage key, or null when the key is not a seeded one. */
export function seededResumeBytes(storageKey: string): Buffer | null {
  const id = Object.keys(SEEDS).find((c) => keyOf(c) === storageKey);
  return id ? pdfOf(SEEDS[id]!) : null;
}

export const interviewResumesFixture = defineFixture<ResumeRecord>({
  key: 'interviews.resumes',
  scenarios: {
    default: () => Object.entries(SEEDS).map(([candidateId, seed]): ResumeRecord => {
      const bytes = pdfOf(seed);
      return {
        id: seededResumeFileId(candidateId)!, candidateId, fileName: `${seed.name.replace(/\s+/g, '-')}-resume.pdf`, sizeBytes: bytes.length,
        contentType: RESUME_CONTENT_TYPE, sha256: createHash('sha256').update(bytes).digest('hex'), uploadedBy: 'u-greta',
        uploadedAt: clock.daysAgo(seed.uploadedDaysAgo), storageKey: keyOf(candidateId),
      };
    }),
    empty: () => [],
  },
});
