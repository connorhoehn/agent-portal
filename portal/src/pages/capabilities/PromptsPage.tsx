// Prompt Studio — Bedrock Prompt Library browser, editor and live test harness.
//
// Layout: prompt rail on the left, one workspace panel on the right. This file
// owns only which prompt is selected, which version, and which panel is
// mounted; every panel, control and derivation lives in ./prompts/.

import { useEffect, useState } from 'react';
import { EmptyState } from '@connorhoehnslalom/ui-components/shared';
import { useCapabilities } from '../../lib/capabilities';
import { CreatePanel } from './prompts/CreatePanel';
import { EditPanel } from './prompts/EditPanel';
import { PromptSidebar } from './prompts/PromptSidebar';
import { TestPanel } from './prompts/TestPanel';
import { ViewPanel } from './prompts/ViewPanel';
import type { PanelMode, Selection } from './prompts/types';
import { usePromptList } from '../../components/canary/usePromptLibrary.js';
import type { PromptLibraryEntry } from '../../components/canary/types.js';

function PromptsPage() {
  // Create/edit/publish/test/optimize all POST the canary prompt library
  // (ManageCanary); reading the library stays open.
  const { can, ready } = useCapabilities();
  const canManage = ready && can('ManageCanary');

  const { prompts, loading, error, refresh } = usePromptList();
  const [search, setSearch] = useState('');
  const [selection, setSelection] = useState<Selection | null>(null);
  const [mode, setMode] = useState<PanelMode>('view');
  // Bumped after a publish or draft save so the version dropdown and detail
  // remount against the new server state rather than a cached response.
  const [versionKey, setVersionKey] = useState(0);

  useEffect(() => {
    if (!selection && prompts.length > 0) {
      const first = prompts[0];
      setSelection({ promptId: first.id, promptName: first.name, promptArn: first.arn, version: 'DRAFT' });
    }
  }, [prompts, selection]);

  const filtered = prompts.filter(p => !search || p.name.toLowerCase().includes(search.toLowerCase()));

  function selectPrompt(prompt: PromptLibraryEntry): void {
    setSelection({ promptId: prompt.id, promptName: prompt.name, promptArn: prompt.arn, version: 'DRAFT' });
    setMode('view');
  }

  function backToView(patch: Partial<Selection>, bumpVersion = false): void {
    if (bumpVersion) setVersionKey(k => k + 1);
    setSelection(prev => (prev ? { ...prev, ...patch } : prev));
    setMode('view');
  }

  return (
    // -m-6 cancels the shell's page padding: the rail and the workspace are
    // full-bleed columns, not a card sitting inside the content area.
    <div className="-m-6 flex h-full min-h-0">
      <PromptSidebar
        prompts={filtered}
        loading={loading}
        error={error}
        search={search}
        onSearch={setSearch}
        selectedId={selection?.promptId ?? null}
        onSelect={selectPrompt}
        onRefresh={refresh}
        onNew={() => { setSelection(null); setMode('create'); }}
        canManage={canManage}
      />

      <div className="flex min-w-0 flex-1 flex-col overflow-auto bg-surface">
        {!selection && !loading && mode !== 'create' && (
          <EmptyState
            title="No prompts yet"
            description="The Bedrock Prompt Library is empty for this tenant."
            {...(canManage
              ? { actionLabel: '+ New prompt', onAction: () => setMode('create') }
              : {})}
          />
        )}

        {selection && mode === 'view' && (
          <ViewPanel
            key={`${selection.promptId}-${versionKey}`}
            selection={selection}
            onVersionChange={version => backToView({ version })}
            onEdit={() => setMode('edit')}
            onTest={() => setMode('test')}
            canManage={canManage}
          />
        )}

        {selection && mode === 'test' && (
          <TestPanel
            key={`${selection.promptId}-${selection.version}-test`}
            selection={selection}
            onClose={() => setMode('view')}
          />
        )}

        {selection && mode === 'edit' && (
          <EditPanel
            key={`${selection.promptId}-${selection.version}-edit`}
            selection={selection}
            onCancel={() => setMode('view')}
            onPublished={(version, promptArn) => backToView({ version, promptArn }, true)}
            onDraftSaved={() => backToView({ version: 'DRAFT' }, true)}
          />
        )}

        {mode === 'create' && (
          <CreatePanel
            onCancel={() => { if (selection) setMode('view'); }}
            onCreated={(promptId, promptArn, promptName) => {
              refresh();
              setSelection({ promptId, promptName, promptArn, version: 'DRAFT' });
              setMode('view');
            }}
          />
        )}
      </div>
    </div>
  );
}

export default PromptsPage;
