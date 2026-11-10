// putDocumentWithSidecar against a fake bucket where the test decides the
// order in which each request lands, so two uploads (or an upload and a
// delete) of the same key can be interleaved step by step. The property held
// in every interleaving: once a document put has succeeded and its call has
// returned, the document has its sidecar.
import { DeleteObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { deleteDocumentWithSidecar, putDocumentWithSidecar } from '../kb-document-put.js';

type Cmd = { constructor: { name: string }; input: { Key: string; Body?: unknown } };
type Pending = { op: string; key: string; release: (fail?: Error) => void };

/** A bucket whose requests wait until the test releases them, one at a time. */
function fakeBucket() {
  const objects = new Map<string, unknown>();
  const pending: Pending[] = [];
  const send = (cmd: Cmd) => new Promise<unknown>((resolve, reject) => {
    const op = cmd.constructor.name;
    const key = cmd.input.Key;
    pending.push({
      op, key,
      release: (fail) => {
        if (fail) { reject(fail); return; }
        if (op === 'PutObjectCommand') objects.set(key, cmd.input.Body);
        else if (op === 'DeleteObjectCommand') objects.delete(key);
        resolve({});
      },
    });
  });
  const flush = () => new Promise((r) => setImmediate(r));
  /** Release the oldest waiting request matching op and key. */
  async function step(op: string, key: string, fail?: Error) {
    await flush();
    const i = pending.findIndex((p) => p.op === op && p.key === key);
    if (i < 0) throw new Error(`no waiting ${op} ${key}; waiting: ${pending.map((p) => `${p.op} ${p.key}`).join(', ')}`);
    pending.splice(i, 1)[0]!.release(fail);
    await flush();
  }
  async function drain() {
    for (;;) {
      await flush();
      const p = pending.shift();
      if (!p) return;
      p.release();
    }
  }
  return { s3: { send } as never, objects, step, drain, pending };
}

const BUCKET = 'docs-bucket';
const KEY = 'uploads/2026-11-10/notes.md';
const SIDECAR = `${KEY}.metadata.json`;
const put = 'PutObjectCommand';
const del = 'DeleteObjectCommand';
const doc = (body: string) => ({ Bucket: BUCKET, Key: KEY, Body: body });
/** The call's error (or null), caught at once: a rejection lands while the
 * test is still stepping, before any `expect(...).rejects` could attach. */
const attempt = (p: Promise<void>) => p.then(() => null, (e: Error) => e.message);

it('writes sidecar, document, sidecar again', async () => {
  const b = fakeBucket();
  const done = attempt(putDocumentWithSidecar(b.s3, doc('a'), 'orgiq'));
  await b.drain();
  await done;
  expect(b.objects.get(KEY)).toBe('a');
  expect(JSON.parse(String(b.objects.get(SIDECAR)))).toEqual({ metadataAttributes: { tenant: 'orgiq' } });
});

it('a failed sidecar put writes nothing', async () => {
  const b = fakeBucket();
  const done = attempt(putDocumentWithSidecar(b.s3, doc('a'), 'orgiq'));
  await b.step(put, SIDECAR, new Error('sidecar put failed'));
  expect(await done).toBe('sidecar put failed');
  expect(b.pending).toHaveLength(0);
  expect(b.objects.size).toBe(0);
});

it('a failed document put sends no delete, so the sidecar stays', async () => {
  const b = fakeBucket();
  const done = attempt(putDocumentWithSidecar(b.s3, doc('a'), 'orgiq'));
  await b.step(put, SIDECAR);
  await b.step(put, KEY, new Error('object put failed'));
  expect(await done).toBe('object put failed');
  expect(b.pending).toHaveLength(0);
  expect([...b.objects.keys()]).toEqual([SIDECAR]);
});

it('two interleaved uploads of one key: one fails, the other lands labelled', async () => {
  const b = fakeBucket();
  const first = attempt(putDocumentWithSidecar(b.s3, doc('first'), 'orgiq'));
  const second = putDocumentWithSidecar(b.s3, doc('second'), 'orgiq');
  await b.step(put, SIDECAR);                                   // first's sidecar
  await b.step(put, SIDECAR);                                   // second's sidecar
  await b.step(put, KEY, new Error('object put failed'));        // first's document fails
  expect(await first).toBe('object put failed');
  // Nothing from the failed upload may touch the sidecar now.
  expect(b.pending.map((p) => `${p.op} ${p.key}`)).toEqual([`${put} ${KEY}`]);
  await b.step(put, KEY);                                       // second's document
  await b.drain();
  await second;
  expect(b.objects.get(KEY)).toBe('second');
  expect(b.objects.has(SIDECAR)).toBe(true);
});

it('two interleaved uploads that both succeed leave the document labelled', async () => {
  const b = fakeBucket();
  const first = attempt(putDocumentWithSidecar(b.s3, doc('first'), 'orgiq'));
  const second = putDocumentWithSidecar(b.s3, doc('second'), 'orgiq');
  await b.step(put, SIDECAR);
  await b.step(put, SIDECAR);
  await b.step(put, KEY);
  await b.step(put, KEY);
  await b.drain();
  await Promise.all([first, second]);
  expect(b.objects.get(KEY)).toBe('second');
  expect(b.objects.has(SIDECAR)).toBe(true);
});

it('a delete of the key between the sidecar put and the document put does not leave the new document unlabelled', async () => {
  const b = fakeBucket();
  const upload = putDocumentWithSidecar(b.s3, doc('new'), 'orgiq');
  await b.step(put, SIDECAR);                                   // upload's sidecar
  const removal = deleteDocumentWithSidecar(b.s3, BUCKET, KEY);
  await b.step(del, KEY);                                       // delete: object (none yet)
  await b.step(del, SIDECAR);                                   // delete: the upload's fresh sidecar
  await removal;
  expect(b.objects.size).toBe(0);
  await b.step(put, KEY);                                       // upload's document
  expect(b.objects.has(SIDECAR)).toBe(false);                   // the window the re-assert closes
  await b.step(put, SIDECAR);                                   // the re-assert
  await upload;
  expect(b.objects.get(KEY)).toBe('new');
  expect(b.objects.has(SIDECAR)).toBe(true);
});

it('a failed re-assert is thrown to the caller', async () => {
  const b = fakeBucket();
  const done = attempt(putDocumentWithSidecar(b.s3, doc('a'), 'orgiq'));
  await b.step(put, SIDECAR);
  await b.step(put, KEY);
  await b.step(put, SIDECAR, new Error('re-assert failed'));
  expect(await done).toBe('re-assert failed');
});

it('an unowned key gets the document only', async () => {
  const b = fakeBucket();
  const done = putDocumentWithSidecar(b.s3, doc('a'), null);
  await b.drain();
  await done;
  expect([...b.objects.keys()]).toEqual([KEY]);
});

// Keep the imports honest: the commands the fake dispatches on are the SDK's.
it('dispatches on the SDK command names', () => {
  expect(new PutObjectCommand({ Bucket: BUCKET, Key: KEY }).constructor.name).toBe(put);
  expect(new DeleteObjectCommand({ Bucket: BUCKET, Key: KEY }).constructor.name).toBe(del);
});
