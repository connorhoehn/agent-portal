import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { P, SURFACE_PAGES, page, DIFF_KEY_WARNING } from '../_shared.ts';

// R8. A run Eli Garcia sent found the presence client counting do-not-disturb as
// online, fixed the client it had kept as a skill, and its capture path proposed
// the change with the files. Nora DaSilva reads it the way a reviewer would: the
// procedure, then what the run changed in the script and the recorded fixture,
// as a file diff — text only, nothing in it runs in the page.
export default {
  family: 'runbooks', log: 'author/capture-tool', kind: 'journey', persona: P.nora, scenario: 'shared', identity: 'clone',
  goal: 'Read a run’s captured tool change: the procedure, the file diff of its script and data, and who may accept it',
  fields: { surface: 'a run’s proposal that carries files', pages: SURFACE_PAGES + ', portal/src/pages/runbooks/RunbookFiles.tsx' },
  steps: [
    page('/iq/runbooks/proposals', 'Proposals lists the run’s change to the presence client among the open edits',
      ['Proposals', "Gateway presence API"]),
    { do: 'navigate', url: '/iq/runbooks/proposals/prop-presence-busy', audit: true, proves: 'shows', expectConsole: DIFF_KEY_WARNING,
      name: 'The proposal shows the files it carries as a diff: the client, the fixture and the expected output',
      expect: { visible: [{ testId: 'proposal-review' }, { testId: 'proposal-files-diff' }], text: ['File changes', /scripts\/presence-client\.mjs/, /do-not-disturb/], noText: [/\bundefined\b/] } },
    { do: 'api', url: '/api/runbooks/proposals/prop-presence-busy', proves: 'shows',
      name: 'The proposal’s file diff is served as text: three files modified, the script among them', expect: { status: 200 } },
    { do: 'api', method: 'POST', url: '/api/runbooks/proposals/prop-presence-busy/accept', body: {},
      refusal: 'the presence client is an org-wide skill owned by Layla Hassan with no initiative area; only its owner or an org-leader decides it, so an SME elsewhere is refused before anything is written',
      proves: 'gating', name: 'Nora cannot accept a skill she neither owns nor stewards', expect: { status: 403 } },
    { do: 'api', url: '/api/skill-library', proves: 'shows',
      name: 'The org’s skill library does not have the change yet: only an accepted proposal reaches it', expect: { status: 200 } },
  ],
} satisfies JourneyMap;
