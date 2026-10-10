// Prompt Studio — Bedrock Prompt Library browser, editor and live test harness.
//
// Layout: prompt rail on the left, one workspace panel on the right. This file
// owns only which prompt is selected, which version, and which panel is
// mounted; every panel, control and derivation lives in ./prompts/.

import { useSearchParams, useNavigate } from 'react-router';
import { useCallback, useEffect, useState } from 'react';
import { EmptyState, ErrorState, PageHeader, Stack } from '@connorhoehnslalom/ui-components/shared';
import { useCapabilities } from '../../lib/capabilities';
import { CreatePanel } from './prompts/CreatePanel';
import { EditPanel } from './prompts/EditPanel';
import { PromptSidebar } from './prompts/PromptSidebar';
import { TestPanel } from './prompts/TestPanel';
import { ViewPanel } from './prompts/ViewPanel';
import type { PanelMode, Selection } from './prompts/types';
import { usePromptList } from '../../components/canary/usePromptLibrary.js';
import type { PromptLibraryEntry } from '../../components/canary/types.js';
import { PromptsFrame } from './PromptsFrame';
import { friendlyLibraryError } from './prompts/libraryError';

function PromptsPage() {
  // Create/edit/publish/test/optimize all POST the canary prompt library
  // (ManageCanary); reading the library stays open.
  const { can, ready } = useCapabilities();
  const canManage = ready && can('ManageCanary');

  const { prompts, loading, error, refresh } = usePromptList();
  const [search, setSearch] = useState('');
  const [selection, setSelection] = useState<Selection | null>(null);
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [mode, setMode] = useState<PanelMode>(params.get('mode') === 'create' ? 'create' : 'view');
  // Bumped after a publish or draft save so the version dropdown and detail
  // remount against the new server state rather than a cached response.
  const [versionKey, setVersionKey] = useState(0);
  // Which trigger opened the panel that just closed. Edit and Test each
  // REPLACE the view, so the button that opened them no longer exists while
  // they are up; the view focuses it again once it has re-rendered.
  const [returnFocusTo, setReturnFocusTo] = useState<'edit' | 'test' | null>(null);
  const focusReturned = useCallback(() => setReturnFocusTo(null), []);

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
    <Stack gap="none" className="h-full min-h-0">
      {/* The page's one h1. The studio is a full-height rail + pane, and the
          pane's own header is the selected prompt's (an h2), so without this
          the route had no top-level heading at all. */}
      <PageHeader
        title="Prompt Studio"
        description="Author, test and publish the system prompts the agents read from the Bedrock Prompt Library."
        className="flex-none pb-4"
      />
      <Stack gap="none" className="min-h-0 flex-1">
        <PromptsFrame
          rail={(
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
          )}
        >
            {/* Exactly one of these renders: a failed fetch is not "empty", and an
                empty library is not an error — showing both at once (DEFECTS.md
                #8) told the reader two contradictory things at the same time. */}
            {!selection && !loading && mode !== 'create' && (
              error ? (
                <ErrorState
                  title="Prompt studio unreachable"
                  description={friendlyLibraryError(error)}
                  actionLabel="Retry"
                  onAction={refresh}
                />
              ) : (
                <EmptyState
                  title="No prompts yet"
                  description="The Bedrock Prompt Library is empty for this tenant."
                  {...(canManage
                    ? { actionLabel: '+ New prompt', onAction: () => setMode('create') }
                    : {})}
                />
              )
            )}

            {selection && mode === 'view' && (
              <ViewPanel
                key={`${selection.promptId}-${versionKey}`}
                selection={selection}
                onVersionChange={version => backToView({ version })}
                onEdit={() => setMode('edit')}
                onTest={() => setMode('test')}
                canManage={canManage}
                returnFocusTo={returnFocusTo}
                onFocusReturned={focusReturned}
              />
            )}

            {selection && mode === 'test' && (
              <TestPanel
                key={`${selection.promptId}-${selection.version}-test`}
                selection={selection}
                onClose={() => { setReturnFocusTo('test'); setMode('view'); }}
              />
            )}

            {selection && mode === 'edit' && (
              <EditPanel
                key={`${selection.promptId}-${selection.version}-edit`}
                selection={selection}
                onCancel={() => { setReturnFocusTo('edit'); setMode('view'); }}
                onPublished={(version, promptArn) => { setReturnFocusTo('edit'); backToView({ version, promptArn }, true); }}
                onDraftSaved={() => { setReturnFocusTo('edit'); backToView({ version: 'DRAFT' }, true); }}
              />
            )}

            {mode === 'create' && canManage && (
              <CreatePanel
                onCancel={() => { if (params.get('mode') === 'create') navigate('/iq/library'); else setMode('view'); }}
                onCreated={(promptId, promptArn, promptName) => {
                  refresh();
                  setSelection({ promptId, promptName, promptArn, version: 'DRAFT' });
                  setMode('view');
                }}
              />
            )}
        </PromptsFrame>
      </Stack>
    </Stack>
  );
}

export default PromptsPage;
