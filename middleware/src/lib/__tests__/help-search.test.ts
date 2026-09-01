// The find-help policy: evidence ranks, scores never appear, and the search
// works from roster skill strings alone (dev:mock has no skills graph).

import { findHelp, type HelpSearchInputs } from '../help-search.js';

const person = (id: string, name: string, skills: string[], influenceScore = 90) => ({
  id, name, title: 'Engineer', department: 'Platform', skills, influenceScore,
});

function inputs(over: Partial<HelpSearchInputs> = {}): HelpSearchInputs {
  return {
    graph: { nodes: [], edges: [], departments: [] },
    skillsGraph: { domains: [], skills: [], people: [], personSkillEdges: [] },
    projectsGraph: { projects: [], people: [], personProjectEdges: [] },
    ...over,
  };
}

describe('findHelp', () => {
  it('matches roster skill strings when the skills graph is empty (dev:mock)', () => {
    const out = findHelp('kubernetes', inputs({
      graph: {
        nodes: [person('p-1', 'Ada', ['Kubernetes', 'Go']), person('p-2', 'Bo', ['React'])],
        edges: [], departments: [],
      },
    }));
    expect(out.map((m) => m.id)).toEqual(['p-1']);
    expect(out[0]!.matchedSkills).toEqual([{ name: 'Kubernetes', strength: 0.5 }]);
    expect(out[0]!.otherSkills).toEqual(['Go']);
  });

  it('ranks by edge-weight evidence, not by any person score', () => {
    const out = findHelp('kubernetes', inputs({
      graph: {
        // Weak-evidence person has the far higher influence score — must lose.
        nodes: [person('p-hi', 'Hi Score', [], 99), person('p-ev', 'Evidence', [], 10)],
        edges: [], departments: [],
      },
      skillsGraph: {
        domains: [{ id: 'domain:infra', name: 'Infrastructure', skillCount: 1 }],
        skills: [{ id: 'skill:k8s', name: 'Kubernetes', domain: 'Infrastructure', personCount: 2 }],
        people: [],
        personSkillEdges: [
          { personId: 'p-hi', skillId: 'skill:k8s', weight: 0.2 },
          { personId: 'p-ev', skillId: 'skill:k8s', weight: 0.9 },
        ],
      },
    }));
    expect(out.map((m) => m.id)).toEqual(['p-ev', 'p-hi']);
    // The score-free contract: no score field ever leaves this module.
    for (const m of out) expect(Object.keys(m)).not.toContain('influenceScore');
  });

  it('a domain-name query surfaces people via every skill under the domain', () => {
    const out = findHelp('infrastructure', inputs({
      graph: { nodes: [person('p-1', 'Ada', [])], edges: [], departments: [] },
      skillsGraph: {
        domains: [{ id: 'domain:infra', name: 'Infrastructure', skillCount: 1 }],
        skills: [{ id: 'skill:tf', name: 'Terraform', domain: 'Infrastructure', personCount: 1 }],
        people: [],
        personSkillEdges: [{ personId: 'p-1', skillId: 'skill:tf', weight: 0.8 }],
      },
    }));
    expect(out).toHaveLength(1);
    expect(out[0]!.matchedSkills[0]!.name).toBe('Terraform');
  });

  it('question phrasing is stripped to its domain tokens', () => {
    const out = findHelp('who can help me with kubernetes', inputs({
      graph: { nodes: [person('p-1', 'Ada', ['Kubernetes'])], edges: [], departments: [] },
    }));
    expect(out).toHaveLength(1);
  });

  it('attaches project contexts strongest-first and caps at three', () => {
    const out = findHelp('go', inputs({
      graph: { nodes: [person('p-1', 'Ada', ['Go'])], edges: [], departments: [] },
      projectsGraph: {
        projects: [
          { id: 'proj:a', name: 'Alpha', status: 'active', contributorCount: 1 },
          { id: 'proj:b', name: 'Beta', status: 'active', contributorCount: 1 },
          { id: 'proj:c', name: 'Gamma', status: 'active', contributorCount: 1 },
          { id: 'proj:d', name: 'Delta', status: 'active', contributorCount: 1 },
        ],
        people: [],
        personProjectEdges: [
          { personId: 'p-1', projectId: 'proj:a', weight: 0.1 },
          { personId: 'p-1', projectId: 'proj:b', weight: 0.9 },
          { personId: 'p-1', projectId: 'proj:c', weight: 0.5 },
          { personId: 'p-1', projectId: 'proj:d', weight: 0.3 },
        ],
      },
    }));
    expect(out[0]!.contexts).toEqual(['Beta', 'Gamma', 'Delta']);
  });

  it('returns nothing for an empty or matchless query', () => {
    const base = inputs({
      graph: { nodes: [person('p-1', 'Ada', ['Go'])], edges: [], departments: [] },
    });
    expect(findHelp('', base)).toEqual([]);
    expect(findHelp('quantum basket weaving', base)).toEqual([]);
  });
});
