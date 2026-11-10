// Write a knowledge-base document and its tenant metadata sidecar so the
// document is never readable without the sidecar.
//
// Retrieval keeps a document only for the tenant its sidecar names (beside the
// key-prefix check; lib/kb-prefixes.ts). Writing the object first meant a
// failed sidecar put left an object in the bucket with no label at all. The
// order here is the one that cannot do that:
//
//   1. the sidecar is put first; if that fails, nothing was written;
//   2. then the document; if that fails, the sidecar is removed again, but
//      only when no object exists at the key. A failed re-upload of a name
//      that is already there must not strip the label off the version that
//      is still being served.
//
// A sidecar whose cleanup fails is left behind with no document, which
// labels nothing and is overwritten by the next upload of that name.

import {
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type PutObjectCommandInput,
  type S3Client,
} from '@aws-sdk/client-s3';
import { tenantMetadataSidecar } from './kb-prefixes.js';

type DocumentPut = PutObjectCommandInput & { Bucket: string; Key: string };

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === 'NotFound' || e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404;
}

/**
 * Put `doc` and, when `owner` is known, its `<key>.metadata.json` sidecar
 * naming that tenant, sidecar first (see the file header for why).
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
  await s3.send(new PutObjectCommand({
    Bucket: doc.Bucket, Key: sidecar.key, Body: sidecar.body, ContentType: 'application/json',
  }));
  try {
    await s3.send(new PutObjectCommand(doc));
  } catch (err) {
    try {
      await s3.send(new HeadObjectCommand({ Bucket: doc.Bucket, Key: doc.Key }));
      // An earlier version is still there and keeps its label.
    } catch (headErr) {
      if (isNotFound(headErr)) {
        await s3.send(new DeleteObjectCommand({ Bucket: doc.Bucket, Key: sidecar.key }))
          .catch((delErr: Error) => console.warn('[kb] orphan metadata sidecar left behind:', delErr.message));
      }
    }
    throw err;
  }
}
