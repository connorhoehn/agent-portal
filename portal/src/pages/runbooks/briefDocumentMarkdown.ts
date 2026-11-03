import { briefReadingMarkdown } from './runbookTitles.ts';
import type { Brief, BriefSection, BriefSkillDetail } from './types';

// Metadata is text, not authored markdown. Escape it before adding it to the reading copy.
const text = (value: string) => value.replace(/\\/g, '\\\\').replace(/[\[\]`*_<>#|]/g, '\\$&').replace(/\r?\n/g, ' ');
const runbookLink = (id: string, label: string) => `[${text(label)}](/iq/runbooks/${encodeURIComponent(id)})`;
const count = (n: number) => n.toLocaleString('en-US');
const code = (value: string) => {
  const delimiter = '`'.repeat(Math.max(0, ...(value.match(/`+/g) ?? []).map(run => run.length)) + 1);
  return `${delimiter} ${value.replace(/\r?\n/g, ' ')} ${delimiter}`;
};

/** Supporting evidence belongs to the same document and outline as the instructions. */
export function briefDocumentMarkdown(brief: Brief, options: {
  frozen: boolean;
  skills?: BriefSkillDetail[];
  sectionLabel(section: BriefSection): string;
  referenceLabel(section: BriefSection): string;
  runbookLabel(id: string): string;
  workItemLabel: string;
  initiativeLabel: string;
}): string {
  const parts = [briefReadingMarkdown(brief.markdown).trim(), '## Sources', '_What contributed to these instructions, and why._'];
  parts.push('### Included sources');
  parts.push(brief.sections.length ? brief.sections.map(section => {
    const reference = options.referenceLabel(section);
    const label = reference && section.kind === 'runbook' && section.ref ? runbookLink(section.ref, reference) : text(reference);
    return `- **${text(options.sectionLabel(section))}**${label ? ` · ${label}` : ''} · _${count(section.tokens)} tokens_\n  ${text(section.reason)}`;
  }).join('\n') : 'No sources were recorded.');
  if (brief.omitted.length) {
    parts.push('### Sources left out', brief.omitted.map(item => `- ${runbookLink(item.runbook_id, options.runbookLabel(item.runbook_id))} · _${item.reason === 'budget' ? 'Over the token budget' : item.reason === 'scope' ? 'Outside the scope' : 'Excluded because recent runs drifted from it'}_`).join('\n'));
  }
  if (brief.skill_library) {
    const library = brief.skill_library;
    const details = new Map((options.skills ?? []).map(skill => [skill.name, skill]));
    parts.push('### Skill library', library.dir ? `_${options.frozen ? 'Installed' : 'Installed at boot'} in ${text(library.dir)}._` : '_Not installed on this kind of machine._');
    parts.push(library.skills.length ? library.skills.map(skill => {
      const detail = details.get(skill.name);
      const version = `v${skill.version}${detail?.current_version && detail.current_version !== skill.version ? `; current version v${detail.current_version}` : ''}`;
      return `- ${runbookLink(skill.name, options.runbookLabel(skill.name))} · _${version}_\n  ${text(detail?.description ?? 'That version is no longer in the store.')}`;
    }).join('\n') : 'No skills were included.');
  }
  parts.push('## Assembly details', '_The document identity and inputs for this brief._');
  const fields = [
    ['Brief', code(brief.id)], ['Run', code(brief.run_ref)], ['Assembler', code(brief.assembler_version)],
    ['Tokens', `${count(brief.used_tokens)} of ${count(brief.budget_tokens)}`],
    [options.frozen ? 'Saved' : 'Assembled', new Date(brief.assembled_at).toUTCString()],
    ...(brief.work_item_id ? [['Work item', `${text(options.workItemLabel)} (${code(brief.work_item_id)})`]] : []),
    ...(brief.initiative_id ? [['Initiative', text(options.initiativeLabel)]] : []),
    ...(brief.repo ? [['Repository', code(brief.repo)]] : []),
  ];
  parts.push(fields.map(([label, value]) => `- **${label}:** ${value}`).join('\n'));
  parts.push(`**Document checksum (SHA-256)**\n\n${code(brief.sha256)}`);
  if (brief.skill_library) parts.push(`**Skill library checksum (SHA-256)**\n\n${code(brief.skill_library.sha256)}`);
  return parts.join('\n\n') + '\n';
}
