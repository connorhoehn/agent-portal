// The host's own rules on a deck, on top of the engine's format validator.

/**
 * Host rules on top of the format (docs/deck-edit-operations.md, "Pictures"): the
 * server never fetches a picture from an address (no server-side fetching of
 * arbitrary URLs), so an image `url` is refused; an `assetId` is kept but
 * resolves to nothing until an asset store exists, so the slide shows the
 * engine's placeholder and its image-missing finding.
 */
export function hostSpecErrors(spec: { slides: Array<{ id: string; image?: { url?: string } }> }): string[] {
  return spec.slides.filter((s) => s.image?.url !== undefined).map((s) => `slide ${s.id}: image.url is not accepted; the server does not fetch pictures from addresses. Give image.assetId once pictures can be uploaded, or describe the picture in image.alt`);
}
