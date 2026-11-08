import { useEffect } from 'react';
import { Button, Card, Chip, DataTable, DetailHeader, InlinePlaceholder, Stack, T, type BreadcrumbItem } from '@connorhoehn/ui-components/shared';
import { useSession } from '../../../lib/auth';
import { relativeTime } from '../../../lib/relativeTime';
import { CLASSIFICATION_LABEL } from './knowledgeFormat';
import { nextPresenceSequence } from './presenceSequence';
import { CanvasDocumentPane } from './CanvasDocumentPane';
import type { AssessmentSSEEvent, KnowledgeMode, KnowledgeNode } from './types';

export function FolderPane({ node, children, onSelectChild }: { node: KnowledgeNode; children: KnowledgeNode[]; onSelectChild: (id: string) => void }) {
  return (
    <Card padding="md">
      <Stack gap="sm">
        <DetailHeader
          as="h2"
          title={node.title}
          badge={node.classification && (
            <Chip size="xs" tone="info" uppercase>{CLASSIFICATION_LABEL[node.classification] ?? node.classification}</Chip>
          )}
        />
        {children.length === 0 ? (
          <InlinePlaceholder size="sm">This folder is empty.</InlinePlaceholder>
        ) : (
          <DataTable<KnowledgeNode>
            data={children}
            keyField={(child) => child.id}
            onRowClick={(child) => onSelectChild(child.id)}
            pageSize={20}
            columns={[
              { key: 'title', header: 'Name', sortable: true, render: (child) => <T size="sm" weight="medium">{child.title}</T> },
              { key: 'classification', header: 'Type', render: (child) => child.is_dir ? 'Folder' : (child.classification ? CLASSIFICATION_LABEL[child.classification] ?? child.classification : 'Document') },
              { key: 'updated_at', header: 'Updated', numeric: true, render: (child) => child.updated_at ? relativeTime(child.updated_at) : '—' },
            ]}
          />
        )}
      </Stack>
    </Card>
  );
}

export interface DocPaneProps {
  node: KnowledgeNode;
  mode: KnowledgeMode;
  sourceConfigured: boolean;
  onBack: () => void;
  /** BFF events refresh the existing source-bound comments and activity. */
  sseEvents: AssessmentSSEEvent[];
  sseConnected: boolean;
  /** A replay gap requires refetching durable records. */
  sseGapped: boolean;
  /** Refetch the explorer after a source operation changes its tree. */
  onTreeChanged: () => void;
  /** Where the page lives, drawn inline on the editor's title row. */
  path: BreadcrumbItem[];
  /** The page's source section, for the History tab's persisted activity. */
  sectionKey: string | null;
}

function getTabId(): string {
  try {
    const existing = sessionStorage.getItem('assessment.knowledge.tabId');
    if (existing) return existing;
    const fresh = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `tab-${Math.random().toString(36).slice(2)}`;
    sessionStorage.setItem('assessment.knowledge.tabId', fresh);
    return fresh;
  } catch {
    return `tab-${Math.random().toString(36).slice(2)}`;
  }
}

function sendPresence(docId: string, tabId: string, action: 'enter' | 'heartbeat' | 'leave'): void {
  const body = JSON.stringify({ doc_id: docId, tab_id: tabId, action, sequence: nextPresenceSequence() });
  if (action === 'leave' && typeof navigator !== 'undefined' && navigator.sendBeacon) {
    // The page may already be tearing down (close/navigate-away) — a plain
    // fetch can get cancelled mid-flight there; a beacon can outlive the page.
    navigator.sendBeacon('/api/assessment/knowledge/presence', new Blob([body], { type: 'application/json' }));
    return;
  }
  void fetch('/api/assessment/knowledge/presence', {
    method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body,
  }).catch(() => {});
}


/** The rich canvas is the single content writer; BFF presence retains source identity. */
export function DocPane(props: DocPaneProps) {
  const { session } = useSession();
  useEffect(() => {
    const tabId = getTabId();
    sendPresence(props.node.id, tabId, 'enter');
    const timer = setInterval(() => sendPresence(props.node.id, tabId, 'heartbeat'), 15_000);
    const leave = () => sendPresence(props.node.id, tabId, 'leave');
    window.addEventListener('pagehide', leave);
    return () => { clearInterval(timer); window.removeEventListener('pagehide', leave); leave(); };
  }, [props.node.id]);
  return <CanvasDocumentPane key={`${props.node.id}:${session?.sub}:${session?.role}:${session?.tenant}`} {...props} />;
}
export default DocPane;
