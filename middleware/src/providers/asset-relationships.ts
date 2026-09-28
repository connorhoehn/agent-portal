// Read-only joins over the existing record IDs. Shared evidence is not a
// publication link; never infer identity from a title or duplicate content.
import { getCandidate, listCandidates } from './promotions.js';
import { getAsset } from './prompt-library.js';
import { getItem, itemSources, libraryProvenance, listArtifacts, listReview } from './distillation.js';
import { getDesignThread } from './design-reviews.js';

export interface AssetRelationship {
  id: string;
  kind: 'observation' | 'guide' | 'review' | 'promotion' | 'library' | 'design';
  label: string;
  href: string;
  relation: string;
}

export async function assetRelationships(kind: 'knowledge' | 'promotion' | 'library', id: string): Promise<AssetRelationship[] | null> {
  const links = new Map<string, AssetRelationship>();
  const add = (link: AssetRelationship) => links.set(`${link.kind}:${link.id}`, link);
  const observations = new Set<string>();
  const targets = new Set<string>();
  const libraryIds = new Set<string>();
  const knowledgeHref = (item: string, view = 'guides') => `/iq/distillation/knowledge?${new URLSearchParams({ view, item })}`;

  async function includeKnowledge(itemId: string) {
    const item = await getItem(itemId);
    if (!item) return;
    targets.add(item.id);
    if (item.level === 'L0') observations.add(item.id);
    if (item.level === 'L2') {
      add({ id: item.id, kind: 'guide', label: item.title, href: knowledgeHref(item.id), relation: 'Source guide' });
      if (item.library_item_id) libraryIds.add(item.library_item_id);
    }
    for (const source of await itemSources(itemId) ?? []) {
      if (source.kind === 'observation') observations.add(source.id);
      if (source.kind === 'cluster') targets.add(source.id);
    }
  }

  if (kind === 'knowledge') {
    if (!await getItem(id)) return null;
    await includeKnowledge(id);
  } else if (kind === 'library') {
    const asset = await getAsset(id);
    if (!asset) return null;
    libraryIds.add(id);
    for (const source of asset.derivedFrom?.top ?? []) observations.add(source.id);
    const provenance = await libraryProvenance(id);
    if (provenance) await includeKnowledge(provenance.artifact.id);
  } else {
    const candidate = await getCandidate(id);
    if (!candidate) return null;
    for (const source of candidate.observations) observations.add(source.id);
    const candidateObservationIds = new Set(observations);
    // Only direct evidence joins, not graph neighbours or title similarity.
    for (const guide of await listArtifacts()) {
      const sources = await itemSources(guide.id) ?? [];
      if (sources.some((source) => source.kind === 'observation' && candidateObservationIds.has(source.id))) {
        await includeKnowledge(guide.id);
        const link = links.get(`guide:${guide.id}`);
        if (link) link.relation = 'Shared evidence';
      }
    }
  }

  for (const observationId of observations) {
    const item = await getItem(observationId);
    if (item?.level === 'L0') add({ id: item.id, kind: 'observation', label: item.title, href: knowledgeHref(item.id, 'notes'), relation: 'Source observation' });
  }
  for (const review of await listReview()) {
    if (targets.has(review.target_id)) add({ id: review.id, kind: 'review', label: `${review.target?.title ?? review.target_id} · ${review.verdict}`, href: `/iq/distillation/review?${new URLSearchParams({ sample: review.id, tab: review.verdict === 'pending' ? 'pending' : 'decided' })}`, relation: 'Knowledge review' });
  }
  if (kind !== 'promotion') for (const candidate of await listCandidates()) {
    if (candidate.observations.some((source) => observations.has(source.id))) add({ id: candidate.id, kind: 'promotion', label: candidate.title, href: `/iq/distillation/review?${new URLSearchParams({ view: 'promotions', item: candidate.id })}`, relation: 'Promotion with shared evidence' });
  }
  for (const libraryId of libraryIds) {
    const asset = await getAsset(libraryId);
    if (!asset) continue;
    if (kind !== 'library') add({ id: asset.id, kind: 'library', label: asset.name, href: `/iq/library/${encodeURIComponent(asset.id)}`, relation: kind === 'promotion' ? 'Asset with shared evidence' : 'Published as' });
    if (asset.designReviewId) {
      const design = await getDesignThread(asset.designReviewId);
      if (design?.status === 'approved') add({ id: design.id, kind: 'design', label: design.title, href: `/iq/designs/${encodeURIComponent(design.id)}`, relation: 'Approved design decision' });
    }
  }
  return [...links.values()].filter((link) => !(kind === 'knowledge' && link.id === id && link.kind === 'guide'));
}
