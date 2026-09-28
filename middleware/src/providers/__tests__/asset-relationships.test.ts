jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true }, auth: {} } }));
jest.mock('@aws-sdk/client-bedrock-agent', () => ({ BedrockAgentClient: class { send() { return Promise.resolve({}); } }, ListPromptsCommand: class {} }));
jest.mock('../aurora.js', () => ({ exec: jest.fn() }));

import { assetRelationships } from '../asset-relationships.js';
import { fixtureRegistry } from '../../mock/core/index.js';
import { artifacts, libraryLinks, clusters, observations, reviewSamples } from '../../mock/distillation.js';
import { promotionCandidates } from '../../mock/promotions.js';
import { libraryAssets } from '../../mock/prompt-library.js';
import { getDesignThread, listDesignReviews } from '../design-reviews.js';
import { publishArtifact } from '../distillation.js';

afterEach(() => fixtureRegistry.resetAll('default'));

test('guide and catalog links resolve the existing publication ID in both directions', async () => {
  const link = libraryLinks.rows()[0]!;
  const forward = await assetRelationships('knowledge', link.artifact_id);
  expect(forward).toEqual(expect.arrayContaining([expect.objectContaining({ id: link.library_item_id, kind: 'library', relation: 'Published as' })]));
  const back = await assetRelationships('library', link.library_item_id);
  expect(back).toEqual(expect.arrayContaining([expect.objectContaining({ id: link.artifact_id, kind: 'guide' })]));
  expect(back?.filter((r) => r.kind === 'observation').every((r) => observations.rows().some((o) => o.id === r.id))).toBe(true);
});

test('knowledge reviews use their sample IDs and keep decided history', async () => {
  const review = reviewSamples.rows().find((r) => r.target_kind === 'artifact')!;
  const links = await assetRelationships('knowledge', review.target_id);
  const record = links?.find((l) => l.id === review.id)!;
  expect(new URL(record.href, 'https://org.test').searchParams.get('sample')).toBe(review.id);
  expect(new URL(record.href, 'https://org.test').searchParams.get('tab')).toBe(review.verdict === 'pending' ? 'pending' : 'decided');
});

test('legacy candidates without common identifiers are not linked by similar content', async () => {
  const candidate = promotionCandidates.rows()[0]!;
  expect(await assetRelationships('promotion', candidate.id)).toEqual([]);
  expect(await assetRelationships('promotion', 'missing')).toBeNull();
});

test('a candidate sharing an observation links the existing guide and review, without claiming publication', async () => {
  const link = libraryLinks.rows()[0]!;
  const guide = artifacts.rows().find((a) => a.id === link.artifact_id)!;
  const cluster = clusters.rows().find((c) => guide.cluster_ids.includes(c.id))!;
  const candidate = promotionCandidates.rows()[0]!;
  candidate.observations[0]!.id = cluster.member_observation_ids[0]!;
  const records = await assetRelationships('promotion', candidate.id);
  expect(records).toEqual(expect.arrayContaining([expect.objectContaining({ id: guide.id, kind: 'guide', relation: 'Shared evidence' })]));
  expect(records?.some((r) => r.relation === 'Published as')).toBe(false);
  expect(await assetRelationships('library', link.library_item_id)).toEqual(expect.arrayContaining([expect.objectContaining({ id: candidate.id, kind: 'promotion' })]));
});

test('publishing a guide leaves skill records, promotion approvals and execution configuration unchanged', async () => {
  const draft = artifacts.rows().find((a) => a.status === 'draft')!;
  const assetsBefore = JSON.stringify(libraryAssets.rows());
  const candidatesBefore = JSON.stringify(promotionCandidates.rows());
  await publishArtifact(draft.id, 'Reviewer');
  expect(draft.status).toBe('published');
  expect(JSON.stringify(libraryAssets.rows())).toBe(assetsBefore);
  expect(JSON.stringify(promotionCandidates.rows())).toBe(candidatesBefore);
});


test('approved design decisions are referenced without absorbing their initiative discussion', async () => {
  const link = libraryLinks.rows()[0]!;
  const asset = libraryAssets.rows().find((a) => a.id === link.library_item_id)!;
  asset.designReviewId = (await listDesignReviews({ status: 'approved' }))[0]!.id;
  const before = await getDesignThread(asset.designReviewId);
  expect(before?.status).toBe('approved');
  const links = await assetRelationships('knowledge', link.artifact_id);
  expect(links).toEqual(expect.arrayContaining([expect.objectContaining({ id: before!.id, kind: 'design', relation: 'Approved design decision' })]));
  expect(await getDesignThread(asset.designReviewId)).toEqual(before);
  expect(before!.orgProjectId).toBeTruthy();
});
