# Document workspace browser acceptance

These captures use the actual portal on `http://127.0.0.1:5183`, its BFF on
3001, the document gateway on 18081, and the isolated platform API on 13002.
They are not renders of a replacement editor. The portal composes the shared
`DocumentHeader`, `CanvasDocumentView`, `DocumentOutline`, `VersionHistoryPanel`,
`DocumentReviewPanel`, `TreeView`, and discussion components.

Tests use fresh browser contexts and newly created local drafts. They do not
change the user's open-browser identity or publish/move a real Confluence page.
Mock source metadata can reset when the BFF development process restarts; the
recorded draft IDs therefore identify the observed run, not permanent bookmarks.

## Verified interactions

- Create a blank draft through **New page**, edit the rich canvas, wait for a
  backend **Saved** receipt, reload, and read the same content in a separate
  `u-jonas` reader context. The reader has no edit control.
- Post a document comment and reply using the shared composer. The BFF stores
  the reply's actual parent ID. Edit the root, delete the reply through the
  confirmation dialog, react as `u-farah`, and reload the durable records.
- Explicitly take ownership, save **Browser checkpoint**, change live content,
  preview the stored binary snapshot, and confirm **Restore version**. Reload
  and a separate reader both show the checkpoint body. No Markdown restore
  request is used. See [structured evidence](binary-history-proof.json).

## Captures

- [Actual editor toolbar and inserted table](editor-toolbar.png)
- [Restored binary history](binary-history-restored.png)
- [Threaded discussion](threaded-comments.png)

## Limits

The source bridge is not configured in this mock stack. Source publication,
attachment transfer to Confluence, and remote tree movement require that bridge;
these browser observations do not claim remote publication. Those actions are
hidden when the source bridge is absent.

Section-scoped review items need actual section anchors. The canvas integration
exposes document-wide review requests, not fabricated section IDs or inert
section-task controls.

## Final checkpoint additions

Real review assignment/approval and reload passed with separate owner/reviewer
contexts; see [review evidence](reviews-proof.json). Real pointer before/after
tree drops persisted; see [drop evidence](tree-drops-proof.json).

Image upload remains blocked by HTTP 500. Browser recovery fault injection did
not intercept a CRDT write, so that proof remains unverified. The complete
[handoff](../../document-workspace-handoff-2026-09-20.md) records these limits and
the next steps. No remote source publication was tested.
