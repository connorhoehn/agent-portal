// Run titles in words (docs/demo-content-audit.md P3).
//
// The projection (lib/pipeline-runs.ts) titles a run from the one row it read:
// an assessment run is "score-dimensions · TEAM-003", a marketplace firing is
// "marketplace work wi-obs-e1-s3", a bot's job is the bot's slug. Those are
// ids a peer cannot read. This is the presenter: it replaces them with names
// it is handed (the team, the work item, the bot, the initiative), and leaves
// a title alone when no name is known — an id is better than a guess.
//
// PURE, like the projection. providers/pipeline-runs.ts reads the names (the
// same readers under dev:mock and Aurora) and calls this once per projection.

import type { Run } from './pipeline-runs.js';

/** "score-dimensions" is "Score dimensions"; a name that already has spaces or capitals is left as written. */
export function humanizeSlug(slug: string): string {
  if (/\s/.test(slug) || /[A-Z]/.test(slug)) return slug;
  const words = slug.split(/[-_]+/).filter(Boolean).map((w) => WORD_CASE[w] ?? w);
  const spaced = words.join(' ').replace('self assessment', 'self-assessment');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Words a slug spells in lower case that are written otherwise in a title. */
const WORD_CASE: Record<string, string> = {
  jira: 'Jira', confluence: 'Confluence', api: 'API', llm: 'LLM', rag: 'RAG', ci: 'CI', e2e: 'E2E', a11y: 'accessibility',
};

export interface RunNames {
  /** An assessment team's name (TEAM-003 is "Northstar Payments"). */
  team(id: string): string | null;
  /** A work item's title and the initiative it belongs to. */
  workItem(id: string): { title: string; initiative: string | null } | null;
  /** A bot's name and the initiative it maintains. */
  bot(id: string): { name: string; initiative: string | null } | null;
  /** The initiative a linked repository belongs to (by agent project id). */
  project(id: string): string | null;
  /** The owner's name for a definition id (a recorded author, a bot's creator). */
  owner(definitionId: string): string | null;
}

/** Rewrite each run's title (and add the initiative it acts for) from the names known; mutates the runs. */
export function presentRunTitles(runs: Run[], names: RunNames): void {
  for (const run of runs) {
    const c = run.context;
    switch (c.table) {
      case 'assessment_runs': {
        const command = run.definitionId.replace(/^assessment:/, '');
        const teamId = c.title.split(' · ')[1];
        const team = teamId ? names.team(teamId) : null;
        c.title = team ? `${humanizeSlug(command)} · ${team}` : c.title.includes(' · ') ? c.title : humanizeSlug(c.title);
        break;
      }
      case 'bot_runs': {
        const wi = c.workItemId ? names.workItem(c.workItemId) : null;
        const bot = c.botId ? names.bot(c.botId) : null;
        if (bot) { c.title = humanizeSlug(bot.name); c.initiativeName = bot.initiative; }
        else if (wi) { c.title = `Dispatched: ${wi.title}`; c.initiativeName = wi.initiative; }
        break;
      }
      case 'agent_jobs': {
        const botId = run.definitionId.startsWith('bot:') ? run.definitionId.slice(4) : null;
        const bot = botId ? names.bot(botId) : null;
        if (bot) { c.title = humanizeSlug(bot.name); c.initiativeName = bot.initiative; }
        break;
      }
      case 'agent_project_runs': {
        // A dispatched work item's run is that item's work: its title, never
        // the prompt line that carries the item's bracketed id (E3).
        const wi = c.workItemId ? names.workItem(c.workItemId) : null;
        if (wi) c.title = wi.title;
        c.initiativeName = (c.projectId ? names.project(c.projectId) : null) ?? wi?.initiative ?? null;
        break;
      }
      default:
        break;
    }
  }
}
