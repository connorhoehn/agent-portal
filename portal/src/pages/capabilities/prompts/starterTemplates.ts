// Starter templates offered on the create form. Data, not UI — they lived
// inline in the page purely because that is where they were written.

export interface StarterTemplate {
  label: string;
  hint: string;
  template: string;
}

export const STARTER_TEMPLATES: StarterTemplate[] = [
  {
    label: 'Expert Finder',
    hint: 'Find top experts for a topic',
    template: `You are an organizational intelligence assistant.

Find the top experts in {{topic}} across the org.

For each person, provide:
- Name and current role
- Why they are an expert (projects, skills, tenure)
- Best way to engage them

Org context: {{org_context}}`,
  },
  {
    label: 'Candidate Brief',
    hint: 'Summarize a person for a role evaluation',
    template: `You are an HR analyst preparing a candidate brief.

Evaluate {{person_name}} for the {{role}} role.

Include:
- Current role and team
- Key skills and expertise areas
- Notable projects and contributions
- Collaboration patterns and reputation

Background: {{summary}}`,
  },
  {
    label: 'Decision Summary',
    hint: 'Summarize an architectural or product decision',
    template: `You are a technical writer summarizing a decision record.

Summarize the following decision for {{audience}}:

Decision: {{decision_title}}
Context: {{context}}
Options considered: {{options}}
Outcome: {{outcome}}

Keep it concise. Highlight the key tradeoff that drove the choice.`,
  },
  {
    label: 'Skill Gap',
    hint: 'Compare required skills against org capabilities',
    template: `You are a workforce planning analyst.

Assess the skill coverage for {{role}} on the {{team_name}} team.

Required skills: {{required_skills}}

For each required skill, identify:
1. Who in the team already covers it
2. Gaps that need hiring or training
3. Adjacent experts who could upskill quickly`,
  },
  {
    label: 'Org Briefing',
    hint: 'One-page briefing on a person for leadership',
    template: `You are an executive briefing assistant.

Prepare a concise briefing on {{person_name}} for {{audience}}.

Cover:
- Role, team, and tenure
- Top 3 areas of expertise with evidence
- Key ongoing projects and impact
- Primary collaborators and influence network

Keep it to 200 words or fewer.`,
  },
];
