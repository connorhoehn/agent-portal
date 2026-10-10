import type { PresentationQuestionContext } from '../lib/presentation-context.js';
import type { MockResponse } from './responses.js';

const text = (value: string): string => value.replace(/[\\`*_<>\[\]]/g, '\\$&');

/** Deterministic offline preview, not a fabricated model/retrieval result. */
export function presentationQuestionPreview(raw: unknown): MockResponse | null {
  if (!raw || typeof raw !== 'object') return null;
  const context = raw as PresentationQuestionContext;
  if (context.kind !== 'initiative-deck' || !context.content?.slides?.length
    || !['saved-revision', 'visible-draft'].includes(context.provenance)) return null;
  const blocks = context.content.slides.map(slide => {
    const lines = [`### ${text(slide.title)}`];
    if (slide.eyebrow) lines.push(text(slide.eyebrow));
    for (const bullet of slide.bullets ?? []) lines.push(`- ${text(bullet)}`);
    for (const [index, column] of (slide.columns ?? []).entries()) {
      lines.push(`Column ${index + 1}:`, ...column.map(value => `- ${text(value)}`));
    }
    if (slide.chart) {
      lines.push(`Chart (${slide.chart.kind}): ${slide.chart.labels.map(text).join(' · ')}`,
        ...slide.chart.series.map(series => `- ${text(series.name)}: ${series.values.join(' · ')}`));
    }
    if (slide.quote) lines.push(`“${text(slide.quote.text)}” — ${text(slide.quote.by)}`);
    if (slide.image) lines.push(`Image description: ${text(slide.image.alt)}`);
    if (slide.notes) lines.push('', `Speaker notes: ${text(slide.notes)}`);
    if (slide.sources.length) lines.push('', 'Citations listed on this slide (source documents were not opened):', '',
      ...slide.sources.map(source => `- ${text(source.title)} (${text(source.documentId)}${source.anchor ? ` · ${text(source.anchor)}` : ''})`));
    if (lines.length === 1) lines.push('This slide has no additional text or figures.');
    return lines.join('\n');
  });
  return { keywords: [], toolCalls: [], response: [
    '**Offline presentation preview**',
    `The ${context.scope === 'slide' ? 'selected slide' : context.scope === 'sources' ? 'generated Sources slide' : 'presentation'} in [${text(context.title)}](${context.href}), version \`${context.revisionId}\`${context.provenance === 'visible-draft' ? ' (visible unsaved draft)' : ' (saved content)'}, contains:`,
    ...blocks,
    'This preview repeats the supplied presentation content. No language model, initiative lookup, or source-document retrieval ran.',
  ].join('\n\n') };
}
