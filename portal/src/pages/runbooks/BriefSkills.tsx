// R8: the skills a run's box received, on the brief page. Every published runbook reaches a box as
// a Claude Code skill in one org-wide library; the brief records which library (its sha), where it
// went (`dir`: ~/.claude/skills on a devbox, ./.claude/skills in a local worker's checkout, null
// when the machine does not install it) and every skill's version. The name, one-line description
// and title are those of the version the run received (GET /api/runs/:ref/brief `skills`).
import { DataTable, DetailSection, Link, Stack, T, type DataTableColumn } from '@connorhoehnslalom/ui-components/shared';
import { runbookHref } from './runbooksModel';
import type { BriefSkillDetail, SkillLibrary } from './types';

/** Where the library went, as one honest sentence. */
export function skillLibraryWhere(lib: SkillLibrary, frozen: boolean): string {
  if (!lib.dir) return frozen ? 'Not installed on the machine that ran this: its brief said so.' : 'Not installed on this kind of machine.';
  return `${frozen ? 'Installed' : 'Installed at boot'} in ${lib.dir}${lib.dir.startsWith('./') ? ' (project skills in the run’s checkout)' : ''}.`;
}

export function BriefSkills({ library, skills, frozen, onOpen }: { library: SkillLibrary; skills: BriefSkillDetail[] | undefined; frozen: boolean; onOpen: (href: string) => void }) {
  // The brief's own record is the list; the details only add words to it.
  const detail = new Map((skills ?? []).map((k) => [k.name, k]));
  const rows: BriefSkillDetail[] = library.skills.map((k) => detail.get(k.name) ?? { name: k.name, version: k.version, title: null, description: null, current_version: null });
  const columns: DataTableColumn<BriefSkillDetail>[] = [
    {
      key: 'name', header: 'Skill', className: 'max-w-xs truncate',
      render: (k) => {
        const to = runbookHref(k.name);
        return (
          <Link href={to} title={k.title ?? k.name} data-testid={`brief-skill-${k.name}`}
            onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); e.stopPropagation(); onOpen(to); }}>
            {k.name}
          </Link>
        );
      },
    },
    {
      key: 'description', header: 'Description', className: 'max-w-md truncate',
      render: (k) => <T tone={k.description ? undefined : 'tertiary'} title={k.description ?? undefined}>{k.description ?? 'That version is no longer in the store.'}</T>,
    },
    {
      key: 'version', header: 'Version', numeric: true,
      render: (k) => (
        <T tabular title={k.current_version && k.current_version !== k.version ? `The runbook is at v${k.current_version} now` : undefined}>
          {`v${k.version}${k.current_version && k.current_version !== k.version ? ` (now v${k.current_version})` : ''}`}
        </T>
      ),
    },
  ];
  return (
    <DetailSection variant="heading" title={frozen ? 'Skills the box received' : 'Skills a box would receive'} hint={`${rows.length}`} data-testid="brief-skills">
      <Stack gap="sm">
        <T size="xs" tone="tertiary" data-testid="brief-skills-where">{skillLibraryWhere(library, frozen)}</T>
        <DataTable data={rows} columns={columns} keyField={(k) => k.name} frameless emptyMessage="The org had no established skills yet." data-testid="brief-skills-table" />
      </Stack>
    </DetailSection>
  );
}
