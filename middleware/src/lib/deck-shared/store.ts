// The deck row store every tenant's provider shares: insert / get / list on the
// tenant's deck table (mock fixture under MOCK_AURORA, parameterized Aurora SQL
// otherwise) plus the revision pass-throughs. A provider supplies its table,
// the column that names the deck's subject, its row mapper and how an insert
// binds; SQL text and mock semantics are the tenant's, unchanged.

import type { SqlParameter } from '@aws-sdk/client-rds-data';
import { config } from '../../config.js';
import { clock } from '../../mock/core/index.js';
import { exec } from '../../providers/aurora.js';
import type { DeckSpec } from '@connorhoehnslalom/realtime-modules/deck';
import type { ArtifactRevision, ArtifactRevisionStore } from '../flow-artifacts/index.js';

/** The minimum a deck row carries for the shared store. */
export interface StoredDeckRow { id: string; createdAt: string; updatedAt: string }

export interface DeckStoreOptions<Row extends StoredDeckRow> {
  table: string;
  /** SELECT list, aliased the way `fromRow` reads it. */
  cols: string;
  /** Mock fixture holding the deck rows. */
  fixture: { rows(): Row[] };
  /** The subject column (`project_id`) and the row property it maps to (`projectId`) — what `listDecks(subject)` filters on. */
  subject: { col: string; prop: keyof Row & string };
  fromRow: (r: Record<string, unknown>) => Row;
  revisions: ArtifactRevisionStore<DeckSpec>;
  insert: {
    /** Insert columns in order; each binds `:<col>` unless `exprs` gives its SQL. */
    columns: string[];
    exprs?: Record<string, string>;
    params: (row: Omit<Row, 'createdAt' | 'updatedAt'>) => SqlParameter[];
    /** `ON CONFLICT (id) DO NOTHING` then re-read; an existing id is returned untouched (mock too). Default: INSERT … RETURNING. */
    idempotent?: boolean;
  };
}

export function createDeckStore<Row extends StoredDeckRow>(o: DeckStoreOptions<Row>) {
  const str = (name: string, value: string): SqlParameter => ({ name, value: { stringValue: value } });
  const values = o.insert.columns.map((c) => o.insert.exprs?.[c] ?? `:${c}`).join(', ');
  const insertSql = `INSERT INTO ${o.table} (${o.insert.columns.join(', ')}) VALUES (${values})`;

  return {
    async insertDeck(row: Omit<Row, 'createdAt' | 'updatedAt'>): Promise<Row> {
      if (config.mock.aurora) {
        if (o.insert.idempotent) {
          const existing = o.fixture.rows().find((d) => d.id === row.id);
          if (existing) return existing;
        }
        const now = clock.nowIso();
        const full = { ...row, createdAt: now, updatedAt: now } as Row;
        o.fixture.rows().unshift(full);
        return full;
      }
      if (o.insert.idempotent) {
        await exec(`${insertSql}\n       ON CONFLICT (id) DO NOTHING`, o.insert.params(row));
        const rows = await exec(`SELECT ${o.cols} FROM ${o.table} WHERE id = :id`, [str('id', row.id)]);
        return o.fromRow(rows[0]!);
      }
      const rows = await exec(`${insertSql} RETURNING ${o.cols}`, o.insert.params(row));
      return o.fromRow(rows[0]!);
    },

    async getDeck(id: string): Promise<Row | null> {
      if (config.mock.aurora) return o.fixture.rows().find((d) => d.id === id) ?? null;
      const rows = await exec(`SELECT ${o.cols} FROM ${o.table} WHERE id = :id`, [str('id', id)]);
      return rows[0] ? o.fromRow(rows[0]) : null;
    },

    async listDecks(subject?: string): Promise<Row[]> {
      if (config.mock.aurora) {
        return o.fixture.rows().filter((d) => !subject || d[o.subject.prop] === subject).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      }
      const rows = subject
        ? await exec(`SELECT ${o.cols} FROM ${o.table} WHERE ${o.subject.col} = :${o.subject.col} ORDER BY updated_at DESC LIMIT 200`, [str(o.subject.col, subject)])
        : await exec(`SELECT ${o.cols} FROM ${o.table} ORDER BY updated_at DESC LIMIT 200`);
      return rows.map(o.fromRow);
    },

    listRevisions: (deckId: string) => o.revisions.listRevisions(deckId),
    getRevision: (deckId: string, revisionId: string) => o.revisions.getRevision(deckId, revisionId),
    /** CAS append on the shared store: accepted only while `baseRevisionId` is the deck's head. */
    appendRevision: (rev: Omit<ArtifactRevision<DeckSpec>, 'seq' | 'createdAt'>) => o.revisions.append(rev),
  };
}
