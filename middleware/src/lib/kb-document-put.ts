// Write and delete a knowledge-base document together with its tenant
// metadata sidecar so the document is never readable without the sidecar.
//
// Retrieval keeps a document only for the tenant its sidecar names (beside the
// key-prefix check; lib/kb-prefixes.ts). Writing the object first meant a
// failed sidecar put left an object in the bucket with no label at all. The
// order here is the one that cannot do that, even with two uploads (or an
// upload and a delete) of the same key running at once:
//
//   1. the sidecar is put first; if that fails, nothing was written;
//   2. then the document; if that fails, the error is thrown and the sidecar
//      stays. It labels nothing on its own, and removing it could strip the
//      label from a concurrent upload of the same name whose document lands
//      a moment later;
//   3. after a successful document put the sidecar is put again (the same
//      bytes, so idempotent). Whatever removed it between steps 1 and 2 (a
//      delete of the same key, say), the document this call wrote ends up
//      labelled. A failed re-assert throws, so the caller sees a failure.
//
// A sidecar left behind with no document is overwritten by the next upload of
// that name and removed by a delete of it.

import {
  DeleteObjectCommand,
  PutObjectCommand,
  type PutObjectCommandInput,
  type S3Client,
} from '@aws-sdk/client-s3';
import { METADATA_SIDECAR_SUFFIX, tenantMetadataSidecar } from './kb-prefixes.js';

type DocumentPut = PutObjectCommandInput & { Bucket: string; Key: string };

/**
 * Put `doc` and, when `owner` is known, its `<key>.metadata.json` sidecar
 * naming that tenant: sidecar, document, sidecar again (see the file header).
 */
export async function putDocumentWithSidecar(
  s3: Pick<S3Client, 'send'>,
  doc: DocumentPut,
  owner: string | null,
): Promise<void> {
  if (!owner) {
    await s3.send(new PutObjectCommand(doc));
    return;
  }
  const sidecar = tenantMetadataSidecar(doc.Key, owner);
  const putSidecar = () => s3.send(new PutObjectCommand({
    Bucket: doc.Bucket, Key: sidecar.key, Body: sidecar.body, ContentType: 'application/json',
  }));
  await putSidecar();
  await s3.send(new PutObjectCommand(doc));
  await putSidecar();
}

/** The sidecar key a delete of `key` also removes, or null when `key` is
 * itself a sidecar (deleting a label never reaches for a label of a label). */
export function sidecarKeyFor(key: string): string | null {
  return key.toLowerCase().endsWith(METADATA_SIDECAR_SUFFIX) ? null : `${key}${METADATA_SIDECAR_SUFFIX}`;
}

/**
 * Delete a document and its `<key>.metadata.json` sidecar, object first.
 *
 * The reverse of the put order, for the same reason: removing the sidecar
 * first would leave a readable document with no label for as long as the
 * object delete takes, or for good if it failed. Deleting the object first
 * can at worst leave a sidecar with no document, which labels nothing and is
 * overwritten by the next upload of that name. A failed object delete throws
 * and leaves the sidecar where it is; a failed sidecar delete is logged, not
 * thrown, because the delete the caller asked for has happened. The sidecar
 * delete is sent whether or not one exists: DeleteObject on a missing key is
 * a no-op, and a document written while no tenant owned its prefix has none.
 */
export async function deleteDocumentWithSidecar(
  s3: Pick<S3Client, 'send'>,
  bucket: string,
  key: string,
): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  const sidecar = sidecarKeyFor(key);
  if (!sidecar) return;
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: sidecar }))
    .catch((err: Error) => console.warn('[kb] orphan metadata sidecar left behind:', err.message));
}
