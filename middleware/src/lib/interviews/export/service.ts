// The export of what Milo showed on one interview (row I6.2): a JSON document built from the sections registered in
// registry.ts. The interview carries ids, the round, times and state; the candidate appears by id, never by name. A
// section that throws leaves its key with an error code and the export carries on. Nothing here writes a log: the
// route says that an export happened (who, which interview, when) and nothing of what it held.
import type { Interview } from '../types.js';
import { exportSections } from './registry.js';
import './sections.js';
import { interviewsNow } from '../clock.js';

export interface MiloExport {
  exportedAt: string;
  interview: {
    id: string; applicationId: string; candidateId: string | null; openingId: string | null;
    /** `competencies`: what the round assesses (kit.ts competenciesOfRound), so the suggestions' competency ids read against it. */
    round: { id: string; name: string; type: string; minutes: number; competencies: Array<{ id: string; name: string }> };
    scheduledAt: string | null; endedAt: string | null; state: string;
  };
  sections: Record<string, unknown>;
}

export interface ExportContext {
  interview: Interview;
  candidateId: string | null;
  openingId: string | null;
  roundName: string;
  /** The competencies the round assesses (kit.ts competenciesOfRound); none when the opening could not be read. */
  competencies?: ReadonlyArray<{ id: string; name: string }>;
}

export async function buildMiloExport(ctx: ExportContext, now: Date = interviewsNow()): Promise<MiloExport> {
  const i = ctx.interview;
  const sections: Record<string, unknown> = {};
  for (const s of exportSections()) {
    try {
      sections[s.key] = await s.read(i.id);
    } catch {
      sections[s.key] = { error: 'unavailable' };
    }
  }
  return {
    exportedAt: now.toISOString(),
    interview: {
      id: i.id, applicationId: i.applicationId, candidateId: ctx.candidateId, openingId: ctx.openingId,
      round: { id: i.roundId, name: ctx.roundName, type: i.type, minutes: i.minutes, competencies: (ctx.competencies ?? []).map((c) => ({ id: c.id, name: c.name })) },
      scheduledAt: i.scheduledAt, endedAt: i.endedAt, state: i.state,
    },
    sections,
  };
}
