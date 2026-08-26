// Pure gating logic for the article-detail Publish control (audit finding M5).
//
// POST /api/newsroom/articles/:id/publish is gated on the PublishArticle
// capability in Cedar — editors hold it, reporters don't (see
// portal/src/lib/capabilities.tsx). Kept separate from ArticleDetailPage.tsx
// so it's unit-testable without React/JSX/DOM: a reporter (no capability) or
// an already-published article should never show a live button — only the
// status chip.

export function canShowPublishControl(status: string | null, hasCapability: boolean): boolean {
  return hasCapability && status !== 'published';
}
