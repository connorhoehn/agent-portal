// One runbook as a page: Read (the canonical markdown a box
// receives, readably), History (versions and the diff between any two), Runs (each step with the last
// run's outcome, and every run that was given it) and Suggest an edit. Drifting and retired runbooks
// say so above the text.
import { useEffect, useMemo, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router';
import { usePublishPageTabs } from '../../lib/voice/pageContext';
import { ProcedureSteps, SourceList } from '@connorhoehn/ui-components';
import { EditorShell } from '@connorhoehn/ui-components/doc-editor';
import {
  Banner, Button, Chip, DataTable, DetailSection, Disclosure, DiffViewer, EmptyState, FormField, Inline, Input, LoadingState, Select, Spinner, Stack, StatusPill, T,
  Textarea, type DataTableColumn,
} from '@connorhoehn/ui-components/shared';
import { UnavailableNotice, isNotFoundError } from '../../components/UnavailableNotice';
import { useFetch } from '../../hooks/useFetch';
import { useCrumbLabel } from '../../lib/crumbLabels';
import { relativeTime } from '../../lib/relativeTime';
import { writeJson } from '../../lib/writeJson';
import { runbookDisplayTitle, runbookReadingMarkdown } from './runbookTitles';
import { ReadOnlyDocument } from '../../components/documents/ReadOnlyDocument';
import { useRunbookNames } from './useRunbookNames';
import type { Names } from './runbookNames';
import { RunbookFiles } from './RunbookFiles';
import {
  HEALTH_LABEL, HEALTH_TONE, OUTCOME_LABEL, RECORD_TABS, briefHref, parseTab, proposalHref, refusalMessage, runPageHref,
  runbookHref, scopeLabel, shortSha, stepMarkers, viewerDiff, type RecordTab,
} from './runbooksModel';
import type { LintFinding, RunbookApplication, RunbookRow, RunbookVersion } from './types';

const TAB_LABEL: Record<RecordTab, string> = { read: 'Read', history: 'History', runs: 'Runs', suggest: 'Suggest an edit' };

interface RecordResponse { runbook: RunbookRow; current: RunbookVersion | null; can_review: boolean }

export function RunbookRecord({ id, summary, onOpen, onChanged }: {
  id: string;
  summary: RunbookRow | null;
  onOpen: (href: string) => void;
  onChanged: () => void;
}) {
  const [params, setParams] = useSearchParams();
  const tab = parseTab(params.get('tab'));
  const record = useFetch<RecordResponse>(`/api/runbooks/${encodeURIComponent(id)}`, 0);
  const applications = useFetch<{ applications: RunbookApplication[] }>(tab === 'runs' ? `/api/runbooks/${encodeURIComponent(id)}/applications` : null, 0);
  const names = useRunbookNames();
  const title = record.data?.runbook.title ?? summary?.title;
  useCrumbLabel(id, title ? runbookDisplayTitle(title) : undefined);
  // G49: the record's tabs for the voice ("open history" is this page's tab), once it has a version to show.
  const { pathname } = useLocation();
  usePublishPageTabs(record.data?.current ? { path: pathname, tabs: RECORD_TABS.filter((t) => t !== 'suggest' || record.data?.runbook.status !== 'retired'), tab } : null);

  if (record.error && !record.data) {
    return (
      <EditorShell headerInset="page" title={title ? runbookDisplayTitle(title) : 'Runbook'} titleAs="h1" titleSize="md" titleOverflow="wrap" surface="plain" label="Runbook">
      <Stack className="p-6" data-testid="runbook-missing">
        <UnavailableNotice
          error={isNotFoundError(record.error) ? 'That runbook does not exist.' : record.error}
          what="this runbook"
          source="Runbooks are read from the runbook store"
          onRetry={record.refresh}
        />
      </Stack>
      </EditorShell>
    );
  }
  if (!record.data || !record.data.current) return <EditorShell headerInset="page" title={title ? runbookDisplayTitle(title) : 'Runbook'} titleAs="h1" titleSize="md" titleOverflow="wrap" surface="plain" label="Runbook">
    <Stack className="px-6 py-4">{!record.data ? <Inline role="status" gap="sm" data-testid="loading-state"><Spinner size="md" decorative /><T size="sm" tone="secondary">Loading runbook…</T></Inline> : <EmptyState align="start" title="No published version" description="This runbook does not have a version to read yet." />}</Stack>
  </EditorShell>;
  const { runbook, current } = record.data;
  const setTab = (next: string) => setParams((prev) => { const p = new URLSearchParams(prev); if (next === 'read') p.delete('tab'); else p.set('tab', next); return p; }, { replace: true });
  const retired = runbook.status === 'retired';
  const tabs = RECORD_TABS.filter((t) => t !== 'suggest' || !retired).map((t) => ({ id: t, label: TAB_LABEL[t] }));
  const pill = retired ? { tone: 'neutral' as const, label: 'Retired' }
    : runbook.status === 'draft' ? { tone: 'info' as const, label: 'Draft' }
      : { tone: HEALTH_TONE[runbook.health.status], label: HEALTH_LABEL[runbook.health.status] };

  return (
    <EditorShell
      headerInset="page"
      titleSize="md" titleOverflow="wrap" titleAs="h1"
      title={runbookDisplayTitle(runbook.title)}
      statusPill={<Inline gap="sm"><Chip tone="neutral" size="md">Runbook</Chip><StatusPill tone={pill.tone} label={pill.label} size="sm" /></Inline>}
      subtitle={<T size="xs" tone="tertiary">{`${scopeLabel(runbook.scope, names)} · owner ${names.person(runbook.owner_person_id)} · v${runbook.current_version} · updated ${relativeTime(runbook.updated_at)}`}</T>}
      tabs={tabs}
      activeTab={tab}
      onTabChange={setTab}
      tabsTrailing={<CopyMarkdown markdown={current.markdown} />}
      surface="plain"
      label="Runbook"
      data-testid="runbook-record"
    >
      <Stack gap="md" className={tab === 'read' ? 'h-full min-h-0 w-full px-6 py-4' : 'w-full max-w-4xl px-6 py-4'}>
        {tab === 'read' && <ReadTab runbook={runbook} version={current} names={names} onOpen={onOpen} />}
        {tab === 'history' && <HistoryTab runbook={runbook} names={names} />}
        {tab === 'runs' && <RunsTab runbook={runbook} version={current} names={names} applications={applications.data?.applications ?? null} error={applications.error} onOpen={onOpen} />}
        {tab === 'suggest' && <SuggestTab runbook={runbook} version={current} onOpen={onOpen} onChanged={() => { record.refresh(); onChanged(); }} />}
      </Stack>
    </EditorShell>
  );
}

function CopyMarkdown({ markdown }: { markdown: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (!copied) return undefined; const t = setTimeout(() => setCopied(false), 2000); return () => clearTimeout(t); }, [copied]);
  return (
    <Button size="sm" variant="secondary" data-testid="runbook-copy-markdown"
      onClick={() => { void navigator.clipboard?.writeText(markdown).then(() => setCopied(true), () => undefined); }}>
      {copied ? 'Copied' : 'Copy markdown'}
    </Button>
  );
}

function ReadTab({ runbook, version, names, onOpen }: { runbook: RunbookRow; version: RunbookVersion; names: Names; onOpen: (href: string) => void }) {
  const prov = version.provenance;
  const sources = [
    ...prov.run_refs.map((r) => ({ id: `run:${r}`, title: names.run(r), kind: 'transcript' as const, meta: 'Proposed this version', onOpen: () => onOpen(runPageHref(r)) })),
    ...prov.session_ids.map((s, k) => ({ id: `session:${s}`, title: prov.session_ids.length > 1 ? `Session ${k + 1}` : 'The session it came from', kind: 'transcript' as const, meta: 'Session it came from' })),
    ...prov.lab_experience_ids.map((l, k) => ({ id: `lab:${l}`, title: `Run note ${k + 1}`, kind: 'transcript' as const, meta: 'Evidence cited' })),
    ...(prov.source_artifact_ids ?? []).map((a, k, all) => ({ id: `art:${a}`, title: all.length > 1 ? `Migrated from earlier guide ${k + 1}` : 'Migrated from an earlier guide', kind: 'page' as const, meta: 'Earlier Distillation guide' })),
  ];
  return (
    <>
      {runbook.retired && (
        <Banner variant="warning" layout="callout" icon title="This runbook is retired" data-testid="runbook-retired"
          action={runbook.retired.superseded_by ? <Button variant="link" size="sm" onClick={() => onOpen(runbookHref(runbook.retired!.superseded_by!))}>Open its replacement</Button> : undefined}>
          {runbook.retired.reason}
        </Banner>
      )}
      {!runbook.retired && runbook.health.status === 'drifting' && (
        <Banner variant="warning" layout="callout" icon title="Recent runs have stumbled on this runbook" data-testid="runbook-drifting">
          {runbook.health.warning ?? runbook.health.reason}
        </Banner>
      )}
      {runbook.area && <T size="xs" tone="tertiary" data-testid="runbook-area">{`Area: ${names.initiative(runbook.area)}`}</T>}
      <T size="xs" tone="tertiary" data-testid="runbook-health">{runbook.health.reason}</T>
      <Stack gap="xs" className="shrink-0">
          <T size="sm" tone="secondary" wrap>{version.doc?.summary ?? runbook.summary}</T>
          {version.doc && <T size="xs" tone="secondary">{`${version.doc.steps.length} steps · ${version.doc.verify.length} checks · ${version.doc.rollback.length} rollback steps`}</T>}
      </Stack>
      <ReadOnlyDocument markdown={runbookReadingMarkdown(version.markdown)} testId="runbook-reader" />
      <Stack gap="none" className="shrink-0 max-h-[40%] overflow-y-auto">
      <Disclosure summary="Files and provenance" variant="plain" density="compact" summaryClassName="px-0">
        <Stack gap="lg">
        {version.files && version.files.length > 0 && (
          <DetailSection as="h2" variant="heading" title="Files" hint={`${version.files.length}`} description={`Skill name: ${runbook.id}. Every box receives this runbook as a skill in ~/.claude/skills.`}>
            <Stack gap="sm">
              <T size="xs" tone="tertiary" className="font-mono" data-testid="runbook-bundle-sha">{`bundle sha256 ${version.bundle_sha256 ? shortSha(version.bundle_sha256) : 'not recorded'}`}</T>
              <RunbookFiles files={version.files} />
            </Stack>
          </DetailSection>
        )}
        <DetailSection as="h2" variant="heading" title="Where it came from" hint={`v${version.version}`}>
          <Stack gap="sm">
            <T size="xs" tone="tertiary" className="font-mono">{`sha256 ${shortSha(version.sha256)}${version.accepted_at ? ` · accepted ${relativeTime(version.accepted_at)}${version.accepted_by ? ` by ${names.person(version.accepted_by)}` : ''}` : ''}`}</T>
            <SourceList aria-label="Provenance" emptyLabel="Written by hand; no run is cited." items={sources} data-testid="runbook-provenance" />
          </Stack>
        </DetailSection>
        </Stack>
      </Disclosure>
      </Stack>
    </>
  );
}

function HistoryTab({ runbook, names }: { runbook: RunbookRow; names: Names }) {
  const versions = useFetch<{ versions: RunbookVersion[] }>(`/api/runbooks/${encodeURIComponent(runbook.id)}/versions`, 0);
  const list = useMemo(() => [...(versions.data?.versions ?? [])].sort((a, b) => b.version - a.version), [versions.data]);
  const [to, setTo] = useState(runbook.current_version);
  const [from, setFrom] = useState(Math.max(1, runbook.current_version - 1));
  const diff = useFetch<{ diff: string; added: number; removed: number }>(
    list.length > 1 && from !== to ? `/api/runbooks/${encodeURIComponent(runbook.id)}/diff?from=${from}&to=${to}` : null, 0);
  // A row opens what that version changed: it sets the comparison below to the version and the one before it.
  const compareWithPrevious = (v: RunbookVersion) => {
    const n = v.version;
    setTo(n > 1 ? n : Math.min(2, list[0]!.version));
    setFrom(n > 1 ? n - 1 : 1);
  };
  const options = list.map((v) => ({ value: String(v.version), label: `v${v.version}` }));
  const columns: DataTableColumn<RunbookVersion>[] = [
    { key: 'version', header: 'Version', render: (v) => `v${v.version}`, numeric: true },
    { key: 'author', header: 'Written by', render: (v) => (v.author.kind === 'run' ? names.run(v.author.id) : v.author.kind === 'migration' ? 'Migration' : names.person(v.author.id)) },
    { key: 'accepted', header: 'Accepted', render: (v) => (v.accepted_at ? `${relativeTime(v.accepted_at)}${v.accepted_by ? ` by ${names.person(v.accepted_by)}` : ''}` : 'Seeded') },
    { key: 'sha', header: 'sha256', render: (v) => shortSha(v.sha256) },
  ];
  if (versions.error) return <UnavailableNotice error={versions.error} what="the version history" source="Versions are read from the runbook store" onRetry={versions.refresh} />;
  if (!versions.data) return <LoadingState label="Loading versions…" />;
  return (
    <>
      <DetailSection as="h2" variant="heading" first title="Versions" hint={`${list.length}`}>
        <DataTable data={list} columns={columns} keyField={(v) => String(v.version)} frameless emptyMessage="No versions." {...(list.length > 1 ? { onRowClick: compareWithPrevious } : { staticRows: 'There is only one version, so there is nothing earlier to compare it with.' })} data-testid="runbook-versions" />
      </DetailSection>
      <DetailSection as="h2" variant="heading" title="What changed" description="Compare any two versions of the canonical markdown.">
        <Stack gap="sm">
          {list.length > 1 && (
            <Inline gap="sm" align="center">
              <Select size="sm" aria-label="From version" className="w-auto" value={String(from)} options={options} onChange={(e) => setFrom(Number(e.target.value))} />
              <T size="sm" tone="tertiary">to</T>
              <Select size="sm" aria-label="To version" className="w-auto" value={String(to)} options={options} onChange={(e) => setTo(Number(e.target.value))} />
              {diff.data && <T size="xs" tone="tertiary">{`+${diff.data.added} −${diff.data.removed}`}</T>}
            </Inline>
          )}
          {list.length < 2 && <T size="sm" tone="secondary">There is only one version; nothing to compare yet.</T>}
          {from === to && list.length > 1 && <T size="sm" tone="secondary">Choose two different versions.</T>}
          {diff.error && <T size="sm" tone="secondary" className="text-danger-fg">{diff.error}</T>}
          {diff.data && (diff.data.diff
            ? <DiffViewer diff={viewerDiff(diff.data.diff, `${runbook.title}.md`)} data-testid="runbook-diff" />
            : <T size="sm" tone="secondary">These two versions are identical.</T>)}
        </Stack>
      </DetailSection>
    </>
  );
}

function RunsTab({ runbook, version, names, applications, error, onOpen }: {
  runbook: RunbookRow;
  names: Names;
  version: RunbookVersion;
  applications: RunbookApplication[] | null;
  error: string | null;
  onOpen: (href: string) => void;
}) {
  if (error) return <UnavailableNotice error={error} what="the runs that used this runbook" source="Applications are read from the runbook store" />;
  if (!applications) return <LoadingState label="Loading runs…" />;
  const steps = version.doc?.steps ?? [];
  const markers = stepMarkers(steps, applications, runbook.current_version);
  const columns: DataTableColumn<RunbookApplication>[] = [
    { key: 'run', header: 'Run', render: (a) => <T title={a.run_ref}>{`${names.run(a.run_ref)} · v${a.version}`}</T> },
    { key: 'outcome', header: 'Outcome', render: (a) => `${OUTCOME_LABEL[a.outcome]}${a.failed_at_step ? ` at step ${a.failed_at_step}` : ''}` },
    { key: 'note', header: 'Note', render: (a) => a.note ?? '' },
    { key: 'at', header: 'When', render: (a) => relativeTime(a.at) },
  ];
  return (
    <>
      <DetailSection as="h2" variant="heading" first title="Runs that were given it" hint={`${applications.length} · open one to read its brief`}>
        <DataTable data={[...applications].sort((a, b) => b.at.localeCompare(a.at))} columns={columns} keyField={(a) => a.id} frameless emptyMessage="No run has reported on this runbook yet. Open a row to read the brief that run was given." onRowClick={(a) => onOpen(briefHref(a.run_ref))} data-testid="runbook-applications" />
      </DetailSection>
      <DetailSection as="h2" variant="heading" title="The steps" hint={applications.some((a) => a.version === runbook.current_version) ? `as the last run of v${runbook.current_version} went` : `no run of v${runbook.current_version} yet`}>
        <ProcedureSteps
          aria-label="Steps and their last outcome"
          steps={markers.map((m) => ({ id: String(m.n), title: m.step.do, ...(m.status ? { status: m.status } : {}), ...(m.note ? { note: m.note } : {}) }))}
          emptyLabel="This runbook has no steps."
        />
      </DetailSection>
    </>
  );
}

function LintList({ findings }: { findings: readonly LintFinding[] }) {
  if (!findings.length) return null;
  return (
    <Stack gap="xs" data-testid="suggest-lint">
      {findings.map((f, i) => (
        <Banner key={`${i}:${f.rule}:${f.path}`} variant={f.severity === 'error' ? 'error' : 'warning'} title={`${f.rule} · ${f.path}`}>{f.message}</Banner>
      ))}
    </Stack>
  );
}

function SuggestTab({ runbook, version, onOpen, onChanged }: { runbook: RunbookRow; version: RunbookVersion; onOpen: (href: string) => void; onChanged: () => void }) {
  const [markdown, setMarkdown] = useState(version.markdown);
  const [rationale, setRationale] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [filed, setFiled] = useState<{ id: string; lint: LintFinding[] } | null>(null);
  const unchanged = markdown.trim() === version.markdown.trim();
  const submit = async () => {
    setBusy(true); setError(null); setProblems([]);
    const res = await writeJson<{ proposal: { id: string; lint: LintFinding[] }; code?: string; problems?: string[] }>(
      '/api/runbooks/proposals', 'POST',
      { kind: 'edit', runbook_id: runbook.id, base_version: runbook.current_version, markdown, rationale },
    );
    setBusy(false);
    if (!res.ok) {
      setError(refusalMessage(res.status, res.data?.code, res.error));
      setProblems(res.data?.problems ?? []);
      return;
    }
    setFiled({ id: res.data!.proposal.id, lint: res.data!.proposal.lint });
    onChanged();
  };
  if (filed) {
    return (
      <Stack gap="md" data-testid="suggest-filed">
        <Banner variant="success" layout="callout" icon title="Your edit is with the reviewers"
          action={<Button variant="link" size="sm" onClick={() => onOpen(proposalHref(filed.id))}>Open the proposal</Button>}>
          It stays a proposal until someone who owns this runbook accepts it; nothing a box receives has changed.
        </Banner>
        <LintList findings={filed.lint} />
      </Stack>
    );
  }
  return (
    <Stack gap="md" data-testid="suggest-form">
      <T size="sm" tone="secondary" wrap>
        Edit the runbook below, say why, and send it for review. You are proposing a change to v{runbook.current_version}; the reviewer sees exactly the diff.
      </T>
      <FormField label="Runbook markdown" hint="The same canonical format a box receives: numbered steps, a command under each, what to expect.">
        {({ labelId: _l, ...w }) => (
          <Textarea {...w} value={markdown} onChange={(e) => setMarkdown(e.target.value)} rows={22} data-testid="suggest-markdown" />
        )}
      </FormField>
      <FormField label="Why this change" required>
        {({ labelId: _l, ...w }) => (
          <Input {...w} value={rationale} onChange={(e) => setRationale(e.target.value)} placeholder="The second pilot run failed at the flip because…" data-testid="suggest-rationale" />
        )}
      </FormField>
      {error && <Banner variant="error" layout="callout" icon title="Not sent" data-testid="suggest-error">{error}</Banner>}
      {problems.length > 0 && (
        <Stack gap="xs">{problems.map((p) => <T key={p} size="sm" tone="secondary" className="text-danger-fg" wrap>{p}</T>)}</Stack>
      )}
      <Inline gap="sm" align="center">
        <Button variant="primary" disabled={busy || unchanged || !rationale.trim()} onClick={() => { void submit(); }} data-testid="suggest-submit">
          {busy ? 'Sending…' : 'Send for review'}
        </Button>
        {unchanged && <T size="xs" tone="tertiary">Change something first.</T>}
        <Button variant="ghost" disabled={unchanged} onClick={() => setMarkdown(version.markdown)}>Reset to v{runbook.current_version}</Button>
      </Inline>
    </Stack>
  );
}
