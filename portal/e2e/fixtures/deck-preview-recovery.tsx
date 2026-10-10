import '../../src/app.css';
import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { useDeckPreview } from '../../src/components/decks/useDeckPreview';
import type { DeckSpec, DeckPreviewResult } from '../../src/components/decks/deckApi';
const spec: DeckSpec = { title: 'Preview recovery', slides: [{ id: 's1', layout: 'title', title: 'Exact selected slide', sources: [] }] };
let requests = 0;
const render = async (): Promise<DeckPreviewResult> => {
  requests++;
  if (location.search.includes('hang') && requests === 1) return new Promise(() => {});
  return { slides: [{ id: 's1', title: 'Exact selected slide', svg: '<svg xmlns="http://www.w3.org/2000/svg"/>' }], warnings: [] } as DeckPreviewResult;
};
function Fixture() {
  const { preview, request } = useDeckPreview('fixture-deck', undefined, render);
  useEffect(() => request(spec), [request]);
  const state = preview === 'loading' ? 'Loading' : typeof preview === 'object' && 'error' in preview ? preview.error : 'Ready';
  return <main><p data-testid="preview-state">{state}</p><button onClick={() => request(spec)}>Retry preview</button></main>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><Fixture /></StrictMode>);
