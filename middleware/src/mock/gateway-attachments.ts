// Reactions and upload metadata for the BFF gateway under dev:mock.
//
//   gateway.reactions  StoredReaction rows (live: Redis hashes / memory)
//   gateway.uploads    FileUploadRow rows (live: the upload metadata store)
//
// Registered so `POST /api/__mock/reset` undoes a reaction or an attachment
// made on ANY tenant's channel (lib/gateway-attachments.ts reads and writes
// these rows when MOCK_AURORA is on). Upload blobs stay on local disk; with
// their metadata row gone they are unreachable.

import type { StoredReaction } from '@connorhoehnslalom/realtime-modules/reactions';
import type { FileUploadRow } from '@connorhoehnslalom/realtime-modules/fileupload';
import { defineFixture } from './core/index.js';

export const gatewayReactionsFixture = defineFixture<StoredReaction>({
  key: 'gateway.reactions',
  scenarios: { default: () => [], empty: () => [] },
});

export const gatewayUploadsFixture = defineFixture<FileUploadRow>({
  key: 'gateway.uploads',
  scenarios: { default: () => [], empty: () => [] },
});
