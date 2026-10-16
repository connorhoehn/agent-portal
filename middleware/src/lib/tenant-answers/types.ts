// What a tenant answer is: one fixed fact computed from the tenant's search
// projection (lib/search-index), with the records it was read from. The shape
// matches the orgiq local answers (lib/local-answers) closely enough that a
// surface can show the text and link the records the same way.

import type { SearchDoc } from '../search-index/types.js';
import type { TenantSearchContext } from '../search-index/tenants.js';

export interface AnswerRecord {
  type: string;
  id: string;
  title: string;
  href: string;
  /** 1-based position, as the orgiq answers number their citations. */
  n: number;
  status?: string;
  subtitle?: string;
}

export interface TenantAnswer {
  /** `<tenant>:<intent>`, the way a local answer names its intent. */
  intent: string;
  text: string;
  records: AnswerRecord[];
  /** The structured rows the prose was computed from. */
  rows: Array<Record<string, unknown>>;
  /** Which projection the facts were read from, in words. */
  sources: string[];
}

/** What an intent reads: the question and the reader's projection, already ACL- and visibility-filtered. */
export interface AnswerContext {
  /** The question as typed. */
  question: string;
  /** Lowercased, apostrophes straightened, trailing punctuation dropped. */
  q: string;
  /** Docs of these types (optionally narrowed by facets), ACL- and visibility-filtered, in no particular order. */
  docs(types: string[], facets?: Record<string, string[]>): Promise<SearchDoc[]>;
  reader: TenantSearchContext;
}

export interface AnswerIntent {
  id: string;
  /** Null when the question is not this intent's: the next intent (or nothing) answers. */
  answer(c: AnswerContext): Promise<TenantAnswer | null>;
}
