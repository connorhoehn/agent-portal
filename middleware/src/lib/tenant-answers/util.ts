// Small readers shared by the tenant intents: a doc as a cited record, the
// words of a question that name something (not what kind of answer is wanted),
// and the team/person a question names.

import { words, stem } from '../search-index/tokens.js';
import { STOPWORDS } from '../search-index/question.js';
import type { SearchDoc } from '../search-index/types.js';
import type { AnswerRecord } from './types.js';

export { plural, listing } from '../local-answers/format.js';

export const str = (doc: SearchDoc, key: string): string => {
  const v = doc.record[key];
  return typeof v === 'string' ? v : '';
};

export function toRecord(doc: SearchDoc, n: number): AnswerRecord {
  const status = str(doc, 'status'), subtitle = str(doc, 'subtitle');
  return { type: doc.type, id: doc.id, title: doc.title, href: str(doc, 'href'), n, ...(status ? { status } : {}), ...(subtitle ? { subtitle } : {}) };
}
export const toRecords = (docs: SearchDoc[]): AnswerRecord[] => docs.map((d, i) => toRecord(d, i + 1));

/** Words that say what kind of answer is wanted ("answered", "questions", "show"), not what it is about. */
const CUES = new Set(('answered answer answers question questions confirm confirmed confirms replied reply response responses said told resolved '
  + 'show list find search which what whats did does about any there document documents doc docs standard standards policy policies exception exceptions '
  + 'open pending staged submission submissions team teams lead leads').split(' '));

/** The words a question is about: stopwords and answer cues removed. */
export function topicWords(q: string, extraCues: Iterable<string> = [], keep: Iterable<string> = []): string[] {
  const extra = new Set(extraCues), kept = new Set(keep);
  return [...new Set(words(q))].filter(w => w.length > 1 && !STOPWORDS.has(w) && (kept.has(w) || !CUES.has(w)) && !extra.has(w));
}

/** True when every word's stem is among the doc text's word stems. */
export function hasAll(text: string, terms: string[]): boolean {
  const have = new Set(words(text).flatMap(w => [w, stem(w)]));
  return terms.every(t => have.has(t) || have.has(stem(t)));
}

/** The docs a question names by a distinctive word of the title (or the id), or [] when none or several tie. */
export function named(q: string, docs: SearchDoc[], idPattern?: RegExp): SearchDoc[] {
  const qwords = new Set(words(q).flatMap(w => [w, stem(w)]));
  const scored = docs.map(d => {
    const idHit = idPattern ? (q.match(idPattern) ?? []).some(m => m.toLowerCase() === d.id.toLowerCase()) : q.includes(d.id.toLowerCase());
    const hits = words(d.title).filter(w => w.length >= 4 && (qwords.has(w) || qwords.has(stem(w)))).length;
    return { d, score: idHit ? 100 : hits };
  }).filter(x => x.score > 0);
  if (!scored.length) return [];
  const top = Math.max(...scored.map(x => x.score));
  return scored.filter(x => x.score === top).map(x => x.d);
}
