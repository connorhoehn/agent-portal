import { useEffect, useMemo, useState } from 'react';
import * as Y from 'yjs';
import type { Editor } from '@tiptap/react';
import { CanvasDocumentView } from '@connorhoehn/ui-components/doc-editor';
import { LoadingState, Stack } from '@connorhoehn/ui-components/shared';
import { createCanvasExtensions, MacroNode, HeadingAnchor, MarkdownClipboard, Callout, CanvasTextAlign } from '@connorhoehn/realtime-modules/adapters/tiptap';
import { TextStyleKit } from '@tiptap/extension-text-style';
import { TableKit } from '@tiptap/extension-table';
import Image from '@tiptap/extension-image';
import { documentMarkdownHtml } from '../../pages/runbooks/documentMarkdown';

const EXTENSIONS = createCanvasExtensions({ MacroNode, HeadingAnchor, MarkdownClipboard, Callout, CanvasTextAlign, TextStyleKit, Image, TableKit });
const READER = { name: 'Reader', color: 'transparent' };

/** A local snapshot in the workspace's document surface. No provider, saves or remote session. */
export function ReadOnlyDocument({ markdown, presentation = 'page', testId = 'readonly-document', onOpen }: {
  markdown: string; presentation?: 'page' | 'pane'; testId?: string; onOpen?: (href: string) => void;
}) {
  const html = useMemo(() => documentMarkdownHtml(markdown), [markdown]);
  const [snapshot, setSnapshot] = useState<{ doc: Y.Doc; html: string } | null>(null);
  useEffect(() => {
    const doc = new Y.Doc();
    setSnapshot({ doc, html });
    return () => doc.destroy();
  }, [html]);
  if (!snapshot || snapshot.html !== html) return <LoadingState label="Opening document…" />;
  return <Stack gap="none" className="min-h-0 flex-1" onClickCapture={event => {
    if (!onOpen || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
    const href = link?.getAttribute('href');
    if (!href?.startsWith('/iq/')) return;
    event.preventDefault(); event.stopPropagation(); onOpen(href);
  }}>
    <Snapshot key={snapshot.doc.clientID} doc={snapshot.doc} html={html} presentation={presentation} testId={testId} />
  </Stack>;
}

function Snapshot({ doc, html, presentation, testId }: { doc: Y.Doc; html: string; presentation: 'page' | 'pane'; testId: string }) {
  const body = doc.getXmlFragment('body');
  const [editor, setEditor] = useState<Editor | null>(null);
  useEffect(() => {
    if (editor && body.length === 0) editor.commands.setContent(html);
  }, [editor, body, html]);
  return <CanvasDocumentView isCanvas body={body} ydoc={doc} provider={null} user={READER}
    extensions={EXTENSIONS} editable={false} initialZoom={1} readingPresentation={presentation} readingNavigation
    showRuler={false} showOutline={false} showStatusBar pageMargin="narrow" fitHeight="parent"
    paginate={presentation === 'page'} onEditorReady={(next) => setEditor(next as Editor | null)} data-testid={testId} />;
}
