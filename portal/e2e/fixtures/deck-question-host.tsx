// Shared-hook rendering regression. The session/capability reads are real;
// the cloned documents and revise/run callbacks exist only in this page.
// No deck API write, agent invocation, gateway, call or tenant switch is used.
import '../../src/app.css';
import { useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import type { PresentationFooterContext } from '@connorhoehn/ui-components/doc-editor';
import { SessionProvider, useSession } from '../../src/lib/auth';
import { useCapabilities } from '../../src/lib/capabilities';
import { useDeckAgentRun, type DeckAgentRunConfig } from '../../src/components/decks/useDeckAgentRun';
import type { DeckEditorDocument } from '../../src/components/decks/DeckEditorPage';
import type { DeckDetailCore, DeckSpec } from '../../src/components/decks/deckApi';

type Host = 'assessment' | 'pipelines' | 'social';
const requested = new URLSearchParams(window.location.search).get('host');
const host: Host = requested === 'pipelines' || requested === 'social' ? requested : 'assessment';
const initial: DeckSpec = { title: `${host} question host fixture`, slides: [
  { id: 'summary', layout: 'bullets', title: 'Summary', bullets: ['A cloned document'], notes: 'Fixture notes', sources: [] },
] };
const saved: DeckDetailCore = { id: `fixture-${host}`, title: initial.title, activeRevisionId: 'fixture-v1', revisions: [
  { id: 'fixture-v1', label: 'v1', createdAt: '2026-10-09T12:00:00Z', producedBy: 'fixture' },
] };
const proof = {
  host, principal: null as { sub: string; tenant: string; role: string } | null,
  capabilityReady: false, searchAllowed: false,
  revisions: [] as { kind: 'inline' | 'run'; deckId: string; input: unknown }[],
  runReads: [] as string[], reloads: 0, openedRevision: null as string | null,
  markedSlideIds: [] as string[],
};
(window as typeof window & { __deckQuestionHost: typeof proof }).__deckQuestionHost = proof;
const revised: DeckDetailCore = { ...structuredClone(saved), activeRevisionId: 'fixture-v2', revisions: [
  { id: 'fixture-v2', label: 'v2', createdAt: '2026-10-09T13:00:00Z', producedBy: 'fixture' }, ...saved.revisions,
] };
const cfg: DeckAgentRunConfig = host === 'social'
  ? {
    canInstruct: true, hints: [], progressTitle: () => 'Fixture edit',
    reviseNow: async (deckId, input) => {
      proof.revisions.push({ kind: 'inline', deckId, input: structuredClone(input) });
      return { revisionId: 'fixture-v2', summary: 'Fixture edit retained', changedSlideIds: ['summary'], engine: 'offline', replayed: false };
    },
  }
  : {
    canInstruct: true, hints: [], progressTitle: () => 'Fixture edit',
    revise: async (deckId, input) => {
      proof.revisions.push({ kind: 'run', deckId, input: structuredClone(input) });
      return { runId: `fixture-${host}-run` };
    },
    getRun: async id => {
      proof.runReads.push(id);
      return { id, status: 'completed', summary: 'Fixture edit retained', changedSlideIds: ['summary'] };
    },
  };

function Fixture() {
  const { session } = useSession();
  const { can, ready } = useCapabilities();
  const dirtyRef = useRef(false);
  const canInstruct = true;
  proof.principal = session ? { sub: session.sub, tenant: session.tenant, role: session.role } : null;
  proof.capabilityReady = ready;
  proof.searchAllowed = ready && can('Search');
  const doc: DeckEditorDocument<DeckDetailCore> = {
    deckId: saved.id, deck: structuredClone(saved), revisionId: 'fixture-v1', specRevisionId: 'fixture-v1',
    spec: structuredClone(initial), dirtyRef,
    setRevisionId: id => { proof.openedRevision = id; },
    reload: async () => { proof.reloads++; return structuredClone(revised); },
    setConflict: () => {},
  };
  // These unsupported hosts deliberately do not opt into a question provider.
  const extras = useDeckAgentRun(doc, { ...cfg, canInstruct });
  const context: PresentationFooterContext = {
    selectedSlide: initial.slides[0], selectedIndex: 0, slideCount: initial.slides.length,
    selectSlide: () => {}, markChanged: ids => { proof.markedSlideIds = [...ids]; },
  };
  return <div className="flex min-h-screen flex-col bg-surface" data-testid="fixture-question-host"
    data-host={host} data-ready={ready} data-search={proof.searchAllowed} data-can-instruct={canInstruct}>
    <h1>{host} host with a Search-capable Work session</h1>
    <div data-testid="fixture-question-principal">{session ? `${session.sub} / ${session.tenant} / ${session.role}` : 'Loading session'}</div>
    <div className="mt-auto">{extras.footer?.(context)}</div>
  </div>;
}
createRoot(document.getElementById('root')!).render(<SessionProvider><BrowserRouter><Fixture /></BrowserRouter></SessionProvider>);
