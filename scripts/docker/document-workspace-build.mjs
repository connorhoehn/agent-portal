import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const sourceManifest = JSON.parse(readFileSync(new URL('./document-workspace-sources.json', import.meta.url), 'utf8'));
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const imageDefinitions = [
  { source: 'managed-nosql-store', variable: 'MNS_IMAGE', image: 'managed-nosql-store:document-workspace', context: 'managed-nosql-store', dockerfile: 'managed-nosql-store/Dockerfile' },
  { source: 'message-queue', variable: 'MQ_IMAGE', image: 'message-queue:document-workspace', context: 'message-queue', dockerfile: 'message-queue/Dockerfile' },
  { source: 'event-catalog', variable: 'CATALOG_IMAGE', image: 'event-catalog:document-workspace', context: '.', dockerfile: 'event-catalog/Dockerfile', dependencies: ['ui-components'] },
  { source: 'platform-api', variable: 'PLATFORM_API_IMAGE', image: 'platform-api:document-workspace', context: '.', dockerfile: 'platform-api/Dockerfile' },
  { source: 'realtime-examples', variable: 'GATEWAY_IMAGE', image: 'realtime-examples:document-workspace', context: 'realtime-examples', dockerfile: 'realtime-examples/Dockerfile', target: 'server-runtime' },
];
export function defaultImages() {
  return { ...Object.fromEntries(imageDefinitions.map(image => [image.variable, image.image.replace(':document-workspace', `:document-${sourceManifest.sources[image.source].commit.slice(0, 12)}`)])), REDIS_IMAGE: sourceManifest.redisImage };
}
function command(program, args, options = {}) {
  const result = spawnSync(program, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${program} failed with status ${result.status}`);
}
function hasCommit(repository, commit) {
  return spawnSync('git', ['-C', repository, 'cat-file', '-e', `${commit}^{commit}`], { stdio: 'ignore' }).status === 0;
}
function repositoryFor(name, state) {
  const source = sourceManifest.sources[name];
  if (!source || !/^[a-f0-9]{40}$/.test(source.commit)) throw new Error(`Invalid committed source: ${name}`);
  return resolveCommittedRepository(source, { sibling: resolve(root, '..', name), cache: resolve(state, 'git-cache', `${name}.git`) });
}
export function resolveCommittedRepository(source, { sibling, cache }) {
  if (!/^[a-f0-9]{40}$/.test(source.commit)) throw new Error('A full immutable commit SHA is required');
  if (existsSync(sibling) && hasCommit(sibling, source.commit)) return sibling;
  // A fresh checkout need not carry six sibling working trees. Fetch missing
  // immutable objects into a private bare cache; never change a sibling branch.
  if (!existsSync(cache)) { mkdirSync(dirname(cache), { recursive: true }); command('git', ['init', '--bare', cache]); }
  if (!hasCommit(cache, source.commit)) command('git', ['-C', cache, 'fetch', '--depth=1', source.url, source.commit]);
  if (!hasCommit(cache, source.commit)) throw new Error(`Missing committed source ${source.commit}`);
  return cache;
}
/** Same committed-object approach as prepare-libraries.mjs, without modifying
 * manifests: each owning Dockerfile installs its own locked dependency graph. */
export function archiveCommittedSource(repository, commit, destination, paths = []) {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('A full immutable commit SHA is required');
  mkdirSync(destination, { recursive: true });
  const archive = execFileSync('git', ['-C', repository, 'archive', '--format=tar', commit, ...paths], { maxBuffer: 512 * 1024 * 1024 });
  execFileSync('tar', ['-xf', '-', '-C', destination], { input: archive });
}

export function prepareDocumentCompose(state) {
  const source = sourceManifest.sources['realtime-examples'];
  const directory = resolve(state, 'compose-source', source.commit);
  archiveCommittedSource(repositoryFor('realtime-examples', state), source.commit, directory, [
    'examples/middleware-foundation/compose.yml', 'examples/middleware-foundation/compose.document-grants.yml',
    'examples/middleware-foundation/catalog-probe.cjs', 'examples/middleware-foundation/document-probe.cjs',
    'scripts/init-dynamodb.cjs', 'infra/dynamodb-schemas.json',
  ]);
  return resolve(directory, 'examples/middleware-foundation');
}

export function buildDocumentWorkspace({ state, images, planOnly = false }) {
  const context = mkdtempSync(resolve(tmpdir(), 'assessment-document-build-'));
  try {
    for (const [name, source] of Object.entries(sourceManifest.sources)) {
      archiveCommittedSource(repositoryFor(name, state), source.commit, resolve(context, name));
    }
    const plan = { schemaVersion: 1, sources: sourceManifest.sources, redisImage: images.REDIS_IMAGE,
      images: imageDefinitions.map(definition => ({ ...definition, image: images[definition.variable], commit: sourceManifest.sources[definition.source].commit })) };
    // The catalog's Dockerfile consumes the library's source AND its committed
    // package/lock/dist guards; it installs Linux dependencies inside the image.
    for (const definition of imageDefinitions) {
      if (!existsSync(resolve(context, definition.dockerfile))) throw new Error(`Missing Dockerfile for ${definition.source}`);
      if (!existsSync(resolve(context, definition.source, 'package-lock.json'))) throw new Error(`Missing lockfile for ${definition.source}`);
    }
    if (!existsSync(resolve(context, 'ui-components/dist/index.js'))) throw new Error('Catalog UI dependency must include committed dist');
    writeFileSync(resolve(state, 'build-plan.json'), JSON.stringify(plan, null, 2) + '\n');
    if (planOnly) { console.log(JSON.stringify(plan, null, 2)); return; }
    const report = { schemaVersion: 1, builtAt: new Date().toISOString(), sources: sourceManifest.sources, images: [] };
    for (const definition of plan.images) {
      console.log(`Building ${definition.image} from ${definition.source}@${definition.commit}`);
      const args = ['build', '--ssh', 'default', '--progress=plain', '--label', `org.opencontainers.image.revision=${definition.commit}`,
        '--label', `org.opencontainers.image.source=${sourceManifest.sources[definition.source].url}`];
      if (definition.dependencies) args.push('--label', `io.orgiq.document-workspace.dependencies=${JSON.stringify(Object.fromEntries(definition.dependencies.map(name => [name, sourceManifest.sources[name].commit])))}`);
      if (definition.target) args.push('--target', definition.target);
      args.push('-f', resolve(context, definition.dockerfile), '-t', definition.image, resolve(context, definition.context));
      command('docker', args, { env: process.env }); // Build gets no runtime signing or service credentials.
      const built = JSON.parse(execFileSync('docker', ['image', 'inspect', definition.image], { encoding: 'utf8' }))[0];
      report.images.push({ image: definition.image, id: built.Id, architecture: built.Architecture, os: built.Os, repoDigests: built.RepoDigests, sourceCommit: definition.commit });
      writeFileSync(resolve(state, 'build-report.json'), JSON.stringify(report, null, 2) + '\n');
    }
    if (spawnSync('docker', ['image', 'inspect', images.REDIS_IMAGE], { stdio: 'ignore' }).status !== 0) command('docker', ['pull', images.REDIS_IMAGE]);
    const redis = JSON.parse(execFileSync('docker', ['image', 'inspect', images.REDIS_IMAGE], { encoding: 'utf8' }))[0];
    report.images.push({ image: images.REDIS_IMAGE, id: redis.Id, architecture: redis.Architecture, os: redis.Os, repoDigests: redis.RepoDigests });
    writeFileSync(resolve(state, 'build-report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(`All document service images built. Provenance: ${resolve(state, 'build-report.json')}`);
  } finally { rmSync(context, { recursive: true, force: true }); }
}
