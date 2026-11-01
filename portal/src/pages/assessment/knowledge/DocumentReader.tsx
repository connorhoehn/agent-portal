import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Drawer, MarkdownView, Stack, Toolbar } from '@connorhoehnslalom/ui-components/shared';
import { DocumentContextPanel, useDocumentContext } from './ExplorerFrame';
import { DocumentOutline, DocumentStatusBar, type OutlineEntry } from '@connorhoehnslalom/ui-components/doc-editor';

/** Build navigation from rendered headings, so fenced code never becomes an outline entry. */
export function DocumentReader({ markdown, reactions }: { markdown: string; reactions?: ReactNode }) {
  const context = useDocumentContext();
  const root = useRef<HTMLElement>(null);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [wide, setWide] = useState(false);
  const [wordCount, setWordCount] = useState<number | null>(null);
  const [entries, setEntries] = useState<OutlineEntry[]>([]);
  useEffect(() => {
    const text = root.current?.innerText?.trim() ?? '';
    setWordCount(text ? text.split(/\s+/).length : 0);
    const headings = Array.from(root.current?.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6') ?? []);
    setEntries(headings.map((heading, index) => {
      heading.id = `document-heading-${index}`;
      heading.tabIndex = -1;
      return { id: heading.id, text: heading.textContent ?? '', level: Number(heading.tagName.slice(1)) };
    }));
  }, [markdown]);
  const outline = (
      <DocumentOutline entries={entries} onSelect={(id) => {
        setOutlineOpen(false);
        window.setTimeout(() => {
          const heading = root.current?.querySelector<HTMLElement>(`#${id}`);
          heading?.scrollIntoView({ block: 'start' });
          heading?.focus({ preventScroll: true });
        }, 0);
      }} />
  );
  return <Stack gap="md" className="min-w-0">
    <Toolbar aria-label="Reading tools" end={<Button variant="ghost" size="sm" aria-pressed={wide} onClick={() => setWide((value) => !value)}>{wide ? 'Reading width' : 'Full width'}</Button>}>
      {reactions}
      <Button variant="ghost" size="sm" onClick={() => context ? context.open('outline') : setOutlineOpen(true)}>On this page</Button>
    </Toolbar>
    <Stack ref={root} role="document" aria-label="Document content" className={wide ? 'min-w-0' : 'mx-auto w-full max-w-3xl'}>
      <MarkdownView markdown={markdown} className="doc-markdown" />
    </Stack>
    <DocumentStatusBar wordCount={wordCount} />
    <DocumentContextPanel id="outline">{outline}</DocumentContextPanel>
    <Drawer open={outlineOpen} onClose={() => setOutlineOpen(false)} title="On this page" width={320}>
      {outline}
    </Drawer>
  </Stack>;
}
