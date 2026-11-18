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

/** A one-page résumé: a header, then sections of entries (a heading line, then bullets). */
export interface ResumeDoc {
  name: string;
  headline: string;
  contact: string;
  sections: Array<{ title: string; entries: Array<{ heading?: string; lines: string[] }> }>;
}

/** Latin-1 text for a WinAnsi Helvetica string: accents kept (á, é, ø), anything else replaced. */
const pdfText = (s: string): string => s.replace(/[–—]/g, '-').replace(/[^\x20-\x7e\xa0-\xff]/g, '?')
  .replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

/** Words wrapped at `max` characters. */
function wrap(text: string, max: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const w of text.split(/\s+/)) {
    if (line && line.length + 1 + w.length > max) { out.push(line); line = w; } else line = line ? `${line} ${w}` : w;
  }
  if (line) out.push(line);
  return out;
}

/**
 * A one-page résumé PDF (A4, Helvetica and Helvetica-Bold in WinAnsi, so names keep their accents): the name at 20 pt,
 * the headline and contact line at 11 pt, then each section under a bold 12 pt title and a rule, entries in bold,
 * bullets at 10.5 pt wrapped to the page. Pure; no binary is committed.
 */
export function buildResumePdf(doc: ResumeDoc): Buffer {
  const ops: string[] = [];
  let y = 790;
  const text = (font: 'F1' | 'F2', size: number, x: number, s: string) => { ops.push('BT', `/${font} ${size} Tf`, `${x} ${y} Td`, `(${pdfText(s)}) Tj`, 'ET'); };
  text('F2', 20, 56, doc.name); y -= 20;
  text('F1', 11, 56, doc.headline); y -= 15;
  text('F1', 10, 56, doc.contact); y -= 26;
  for (const section of doc.sections) {
    text('F2', 12, 56, section.title.toUpperCase()); y -= 5;
    ops.push('0.6 G', `56 ${y} m 539 ${y} l S`, '0 G'); y -= 16;
    for (const e of section.entries) {
      if (e.heading) { text('F2', 10.5, 56, e.heading); y -= 14; }
      for (const l of e.lines) {
        wrap(l, 92).forEach((piece, i) => { text('F1', 10.5, i === 0 ? 64 : 74, i === 0 ? `- ${piece}` : piece); y -= 14; });
      }
      y -= 4;
    }
    y -= 8;
  }
  const stream = ops.join('\n');
  const enc = '/Encoding /WinAnsiEncoding';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica ${enc} >>`,
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold ${enc} >>`,
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => { offsets.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

interface Seed extends ResumeDoc { uploadedDaysAgo: number }

const job = (heading: string, ...lines: string[]) => ({ heading, lines });

// Invented people, companies and schools; the work fits each candidate's seeded note and their rounds' transcripts.
const SEEDS: Record<string, Seed> = {
  'cand-rx6tcaqj': { name: 'Mateo Álvarez', headline: 'Backend engineer, ride-hailing marketplace', contact: 'Madrid · mateo.alvarez@mail.example', uploadedDaysAgo: 30, sections: [
    { title: 'Summary', entries: [{ lines: ['Six years building pricing and dispatch services in Kotlin and Go; wants to move into payments.'] }] },
    { title: 'Experience', entries: [
      job('Tripline Mobility, Backend engineer, 2022 to now',
        'Built the trip-pricing service; cut p99 quote latency from 900 ms to 220 ms.',
        'Moved surge calculation to an event-driven pipeline; on call for the pricing stack.',
        'Wrote the fixed-window rate limiter for the driver app\'s location pings.'),
      job('Cobalt Rides, Software engineer, 2020 to 2022',
        'Payment retries with idempotency keys, and the refunds ledger behind them.') ] },
    { title: 'Skills', entries: [{ lines: ['Kotlin, Go, PostgreSQL, Redis, Kafka, distributed tracing.'] }] },
    { title: 'Education', entries: [job('BSc Computer Science, Universidad del Alto Tajo, 2019', 'Final project: a scheduler for shared bike rebalancing.')] },
  ] },
  'cand-qz63q3a3': { name: 'Ingrid Solberg', headline: 'Senior software engineer, card issuing', contact: 'Oslo · ingrid.solberg@mail.example', uploadedDaysAgo: 33, sections: [
    { title: 'Summary', entries: [{ lines: ['Nine years in card issuing and authorisation systems; leads incidents and multi-region work.'] }] },
    { title: 'Experience', entries: [
      job('Fjordcard, Senior software engineer, 2020 to now',
        'Led the move of the card-authorisation service to a second region, first active-passive, then active-active.',
        'Wrote the failover runbook; added pool-wait alerts after a connection-pool incident.',
        'Introduced per-merchant rate limits and a replayable settlement log.'),
      job('Northgate Payments, Software engineer, 2016 to 2020', 'Built the dispute intake service in Java.') ] },
    { title: 'Skills', entries: [{ lines: ['Java, Kotlin, Python, PostgreSQL, multi-region design, incident response.'] }] },
    { title: 'Education', entries: [job('MSc Informatics, Vestfjord University College, 2016')] },
  ] },
  'cand-nx59ftdv': { name: 'Kwame Asante', headline: 'Software engineer, logistics platform', contact: 'Accra, open to relocating · kwame.asante@mail.example', uploadedDaysAgo: 12, sections: [
    { title: 'Summary', entries: [{ lines: ['Five years of backend work; maintainer of an open-source job queue library.'] }] },
    { title: 'Experience', entries: [
      job('Harbour Freight Systems, Software engineer, 2021 to now',
        'Built the shipment-tracking API and its retry scheduler.', 'Moved webhook delivery onto a queue with back-off and dead letters.'),
      job('Open source, Maintainer, 2019 to now', 'A small job queue library for Node.js: priorities, back-off, dead letters.') ] },
    { title: 'Skills', entries: [{ lines: ['TypeScript, Node.js, Python, Redis, PostgreSQL, queue design.'] }] },
    { title: 'Education', entries: [job('BSc Computer Engineering, Cape Meridian University, 2019')] },
  ] },
  'cand-s52jevud': { name: 'Aiko Tanaka', headline: 'iOS engineer, food delivery app', contact: 'Berlin · aiko.tanaka@mail.example', uploadedDaysAgo: 17, sections: [
    { title: 'Summary', entries: [{ lines: ['Five years of iOS development, three of them on a food delivery app.'] }] },
    { title: 'Experience', entries: [
      job('Bento Run, iOS engineer, 2021 to now',
        'Shipped offline order history and the live courier map in Swift.',
        'Moved checkout screens to SwiftUI; crash-free sessions from 98.9 to 99.7 percent.'),
      job('Pixel Mill Studio, iOS developer, 2019 to 2021', 'Client apps in UIKit and Objective-C.') ] },
    { title: 'Skills', entries: [{ lines: ['Swift, SwiftUI, Combine, Core Data, XCTest.'] }] },
    { title: 'Education', entries: [job('BEng Information Science, Kanzaki Institute of Technology, 2019')] },
  ] },
  'cand-w4pvy8m9': { name: 'Ravi Menon', headline: 'Mobile engineer, retail banking app', contact: 'Hamburg · ravi.menon@mail.example', uploadedDaysAgo: 21, sections: [
    { title: 'Summary', entries: [{ lines: ['Seven years of mobile engineering in retail banking.'] }] },
    { title: 'Experience', entries: [
      job('Lakeside Bank, Senior mobile engineer, 2020 to now',
        'Led the move from UIKit to SwiftUI for two screens and wrote the migration guide.',
        'Built the transaction search with debounced, cancellable requests.'),
      job('Orchard Mobile, Mobile engineer, 2017 to 2020', 'Android and iOS clients for a savings product.') ] },
    { title: 'Skills', entries: [{ lines: ['Swift, Kotlin, SwiftUI, accessibility, release engineering.'] }] },
    { title: 'Education', entries: [job('BTech Computer Science, Western Deccan Institute of Technology, 2017')] },
  ] },
  'cand-xbmv4nvd': { name: 'Nadia Petrova', headline: 'Engineering lead, developer tools', contact: 'Sofia · nadia.petrova@mail.example', uploadedDaysAgo: 14, sections: [
    { title: 'Summary', entries: [{ lines: ['Twelve years in engineering, the last five leading a developer tools group of eight.'] }] },
    { title: 'Experience', entries: [
      job('Sprocket Labs, Engineering lead, 2021 to now',
        'Lead of the build and release platform; cut mean build time by 40 percent.',
        'Set up the on-call rotation and the quarterly planning process for the group.'),
      job('Brightwire, Engineer then tech lead, 2014 to 2021', 'Tech lead of the packaging team.') ] },
    { title: 'Skills', entries: [{ lines: ['People management, platform strategy, hiring, incident leadership.'] }] },
    { title: 'Education', entries: [job('MSc Computer Science, Vitosha Technical University, 2014')] },
  ] },
  'cand-zrtncmb2': { name: 'Jonah Whitaker', headline: 'Engineering manager, insurance platform', contact: 'Dublin · jonah.whitaker@mail.example', uploadedDaysAgo: 16, sections: [
    { title: 'Summary', entries: [{ lines: ['Engineering manager of two teams on an insurance platform.'] }] },
    { title: 'Experience', entries: [
      job('Harbourline Insurance, Engineering manager, 2019 to now',
        'Manage fourteen engineers across quoting and claims.',
        'Coached two engineers into tech lead roles; led the reorganisation of the claims team.'),
      job('Ledgerworks, Senior engineer then manager, 2014 to 2019', 'Manager of the data team.') ] },
    { title: 'Skills', entries: [{ lines: ['Delivery planning, performance conversations, stakeholder management.'] }] },
    { title: 'Education', entries: [job('BA Mathematics, Liffeyside College, 2013')] },
  ] },
};

/** The seeded file id for a candidate, or null: the candidate rows' `resumeFileId`. */
export const seededResumeFileId = (candidateId: string): string | null => (SEEDS[candidateId] ? `rf-${candidateId.replace(/^cand-/, '')}` : null);
const keyOf = (candidateId: string): string => `interviews/resumes/${candidateId}/${seededResumeFileId(candidateId)}.pdf`;

const pdfOf = (seed: Seed): Buffer => buildResumePdf(seed);

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
        id: seededResumeFileId(candidateId)!, candidateId, fileName: `${seed.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, '-')}-resume.pdf`, sizeBytes: bytes.length,
        contentType: RESUME_CONTENT_TYPE, sha256: createHash('sha256').update(bytes).digest('hex'), uploadedBy: 'u-greta',
        uploadedAt: clock.daysAgo(seed.uploadedDaysAgo), storageKey: keyOf(candidateId),
      };
    }),
    empty: () => [],
  },
});
