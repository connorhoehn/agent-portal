// Shared artifact-revision store for the agentic flow layer
// (docs/agentic-flows-migration.md, slice 4). Append-only revisions of one
// artifact (a deck today), each naming the revision it was made from; an append
// is accepted only while that base is still the artifact's head (CAS), and
// every writer — a person's save, a generation run, an agent revise — goes
// through the same path.
//
// One implementation, parameterised by (tenant, subject kind, id prefix) and
// by the artifact/revision tables it sits on. It deliberately reuses each
// tenant's EXISTING tables (assessment_decks / assessment_deck_revisions,
// pipeline_run_decks / pipeline_run_deck_revisions) rather than adding a
// generic table: no schema change, no data move, and the per-subject columns
// (team_id, run_id, audience, last_run_id) stay on the artifact row where the
// tenant's own provider owns them. The store owns only what is generic: the
// revision rows and the head pointer. The Aurora SQL has not run against a
// live cluster; tests assert its shape.
//
// `deckId` on a revision row is the artifact's id (the column is `deck_id` in
// both existing tables).

import { randomUUID } from 'node:crypto';
import type { SqlParameter } from '@aws-sdk/client-rds-data';
import { config } from '../../config.js';
import { clock } from '../../mock/core/index.js';
import { exec } from '../../providers/aurora.js';

export interface ArtifactRevision<S> {
  id: string;
  deckId: string;
  seq: number;
  baseRevisionId: string | null;
  label: string;
  spec: S;
  lockedSlideIds: string[];
  /** A run id, 'generated', or `person:<sub>`. */
  producedBy: string;
  createdBy: string | null;
  summary: string | null;
  createdAt: string;
}

export type NewRevision<S> = Omit<ArtifactRevision<S>, 'seq' | 'createdAt'>;

export type AppendResult<S> =
  | { ok: true; revision: ArtifactRevision<S> }
  | { ok: false; reason: 'missing' | 'conflict'; head: string | null };

/** What the store needs of a mock artifact row (the tenant's fixture row satisfies it). */
export interface MockArtifactHead { id: string; headRevisionId: string | null; updatedAt: string }

export interface ArtifactStoreConfig<S> {
  tenant: string;
  /** What the artifact belongs to: 'team', 'run'. Informational; the owning column lives on the artifact row. */
  subjectKind: string;
  /** Artifact id prefix, e.g. 'deck' → deck-<uuid>. */
  idPrefix: string;
  /** Revision id prefix, e.g. 'rev' → rev-<uuid>. */
  revisionPrefix: string;
  artifactTable: string;
  revisionTable: string;
  emptySpec: S;
  /** Mock fixtures (MOCK_AURORA). */
  mock: { artifacts: () => MockArtifactHead[]; revisions: () => Array<ArtifactRevision<S>>; afterAppend?: () => void };
}

/** The label a revision is shown under: v<seq>. */
export const revisionLabel = (seq: number): string => `v${seq}`;

const str = (name: string, value: string): SqlParameter => ({ name, value: { stringValue: value } });
const maybe = (name: string, value: string | null | undefined): SqlParameter =>
  value == null ? { name, value: { isNull: true } } : str(name, value);
const json = (name: string, value: unknown): SqlParameter => ({ name, value: { stringValue: JSON.stringify(value) } });
const parse = <T>(raw: unknown, fallback: T): T => {
  if (raw == null) return fallback;
  try { return JSON.parse(String(raw)) as T; } catch { return fallback; }
};
const iso = (col: string): string => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const REV_COLS = `id, deck_id, seq, base_revision_id, label, locked_slide_ids::text AS locked_slide_ids,
  produced_by, created_by, summary, ${iso('created_at')} AS created_at`;

export function createArtifactRevisionStore<S>(cfg: ArtifactStoreConfig<S>) {
  const idRe = new RegExp(`^${cfg.idPrefix}-[0-9a-f-]{36}$`);
  const revRe = new RegExp(`^${cfg.revisionPrefix}-[0-9a-f-]{36}$`);

  const fromRow = (r: Record<string, unknown>, spec?: S): ArtifactRevision<S> => ({
    id: String(r['id']), deckId: String(r['deck_id']), seq: Number(r['seq']),
    baseRevisionId: r['base_revision_id'] == null ? null : String(r['base_revision_id']),
    label: String(r['label']), spec: spec ?? parse<S>(r['spec'], cfg.emptySpec),
    lockedSlideIds: parse<string[]>(r['locked_slide_ids'], []),
    producedBy: String(r['produced_by']), createdBy: r['created_by'] == null ? null : String(r['created_by']),
    summary: r['summary'] == null ? null : String(r['summary']), createdAt: String(r['created_at']),
  });

  return {
    config: cfg,
    isArtifactId: (v: unknown): v is string => typeof v === 'string' && idRe.test(v),
    isRevisionId: (v: unknown): v is string => typeof v === 'string' && revRe.test(v),
    newArtifactId: (): string => `${cfg.idPrefix}-${randomUUID()}`,
    newRevisionId: (): string => `${cfg.revisionPrefix}-${randomUUID()}`,

    /** Every revision of an artifact, newest first, WITHOUT its spec. */
    async listRevisions(artifactId: string): Promise<Array<Omit<ArtifactRevision<S>, 'spec'>>> {
      if (config.mock.aurora) {
        return cfg.mock.revisions().filter((r) => r.deckId === artifactId).sort((a, b) => b.seq - a.seq)
          .map(({ spec: _spec, ...rest }) => rest);
      }
      const rows = await exec(`SELECT ${REV_COLS} FROM ${cfg.revisionTable} WHERE deck_id = :deck_id ORDER BY seq DESC`,
        [str('deck_id', artifactId)]);
      return rows.map((r) => { const { spec: _spec, ...rest } = fromRow(r, cfg.emptySpec); return rest; });
    },

    async getRevision(artifactId: string, revisionId: string): Promise<ArtifactRevision<S> | null> {
      if (config.mock.aurora) return cfg.mock.revisions().find((r) => r.deckId === artifactId && r.id === revisionId) ?? null;
      const rows = await exec(
        `SELECT ${REV_COLS}, spec::text AS spec FROM ${cfg.revisionTable} WHERE deck_id = :deck_id AND id = :id`,
        [str('deck_id', artifactId), str('id', revisionId)],
      );
      return rows[0] ? fromRow(rows[0]) : null;
    },

    /**
     * Appends a revision iff `baseRevisionId` is still the artifact's head
     * (null for the first). Aurora does compare and append in ONE statement:
     * the UPDATE takes the artifact row's lock and re-checks the head under
     * it, so a concurrent writer with the same base finds the head moved and
     * inserts nothing.
     */
    async append(rev: NewRevision<S>): Promise<AppendResult<S>> {
      if (config.mock.aurora) {
        const artifact = cfg.mock.artifacts().find((d) => d.id === rev.deckId);
        if (!artifact) return { ok: false, reason: 'missing', head: null };
        if (artifact.headRevisionId !== rev.baseRevisionId) return { ok: false, reason: 'conflict', head: artifact.headRevisionId };
        const rows = cfg.mock.revisions();
        const seq = rows.filter((r) => r.deckId === rev.deckId).reduce((m, r) => Math.max(m, r.seq), 0) + 1;
        const now = clock.nowIso();
        const full: ArtifactRevision<S> = { ...rev, seq, createdAt: now };
        const previous = { headRevisionId: artifact.headRevisionId, updatedAt: artifact.updatedAt };
        rows.push(full);
        artifact.headRevisionId = rev.id;
        artifact.updatedAt = now;
        try { cfg.mock.afterAppend?.(); } catch (error) {
          rows.splice(rows.indexOf(full), 1);
          Object.assign(artifact, previous);
          throw error;
        }
        return { ok: true, revision: full };
      }
      const rows = await exec(
        `WITH head AS (
           UPDATE ${cfg.artifactTable} SET head_revision_id = :id, updated_at = NOW()
            WHERE id = :deck_id AND head_revision_id IS NOT DISTINCT FROM CAST(:base_revision_id AS TEXT)
            RETURNING id
         )
         INSERT INTO ${cfg.revisionTable}
           (id, deck_id, seq, base_revision_id, label, spec, locked_slide_ids, produced_by, created_by, summary)
         SELECT :id, head.id,
                (SELECT COALESCE(MAX(seq), 0) + 1 FROM ${cfg.revisionTable} WHERE deck_id = :deck_id),
                CAST(:base_revision_id AS TEXT), :label, CAST(:spec AS JSONB), CAST(:locked AS JSONB),
                :produced_by, :created_by, :summary
           FROM head
         RETURNING ${REV_COLS}`,
        [str('id', rev.id), str('deck_id', rev.deckId), maybe('base_revision_id', rev.baseRevisionId),
          str('label', rev.label), json('spec', rev.spec), json('locked', rev.lockedSlideIds),
          str('produced_by', rev.producedBy), maybe('created_by', rev.createdBy), maybe('summary', rev.summary)],
      );
      if (rows[0]) return { ok: true, revision: fromRow(rows[0], rev.spec) };
      const head = await this.headOf(rev.deckId);
      return head === undefined ? { ok: false, reason: 'missing', head: null } : { ok: false, reason: 'conflict', head };
    },

    /** The artifact's head revision id; `undefined` when the artifact does not exist. */
    async headOf(artifactId: string): Promise<string | null | undefined> {
      if (config.mock.aurora) return cfg.mock.artifacts().find((d) => d.id === artifactId)?.headRevisionId;
      const rows = await exec(`SELECT head_revision_id FROM ${cfg.artifactTable} WHERE id = :id`, [str('id', artifactId)]);
      return rows[0] ? (rows[0]['head_revision_id'] == null ? null : String(rows[0]['head_revision_id'])) : undefined;
    },

    /** The 409 body every CAS refusal carries. */
    conflictDetails: (head: string | null): { activeRevisionId: string | null } => ({ activeRevisionId: head }),
  };
}

export type ArtifactRevisionStore<S> = ReturnType<typeof createArtifactRevisionStore<S>>;
