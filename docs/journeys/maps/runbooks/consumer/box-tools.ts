import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { P, SURFACE_PAGES, page } from '../_shared.ts';

// R8. Every published runbook is a Claude Code skill in ONE org-wide library that
// every box syncs at boot into ~/.claude/skills. Theo reads a skill that carries
// a tool (the websocket-over-CDP harness): its procedure and its files, read-only.
// The brief a run would get carries the project and one line pointing at the
// installed skills, never procedure text. A captured file that tries to climb out
// of its bundle is refused before it is stored.
export default {
  family: 'runbooks', log: 'consumer/box-tools', kind: 'journey', persona: P.theo, scenario: 'shared', identity: 'clone',
  goal: 'Read a skill that carries a script and data, see what every box receives, and see a path-escaping file refused',
  fields: { surface: 'skills a box receives', pages: SURFACE_PAGES + ', middleware/src/routes/session-briefs.ts, middleware/src/lib/runbooks/library.ts' },
  steps: [
    page('/iq/runbooks/rb-ws-cdp-debug', 'The CDP harness skill shows its procedure and the files it carries',
      ["Debug a websocket app's traffic over the DevTools protocol", 'scripts/cdp-ws-frames.mjs', 'data/sample-frames.jsonl'],
      { expect: { visible: [{ testId: 'runbook-files' }] } }),
    { do: 'api', url: '/api/skill-library', proves: 'shows',
      name: 'The org’s skill library lists every published skill with one sha for the whole set', expect: { status: 200 } },
    { do: 'api', url: '/api/work-items/wi-obs-e2-b4/brief-preview', proves: 'shows',
      name: 'An Observability run’s brief points at the same installed skills and carries no procedure text', expect: { status: 200 } },
    { do: 'api', method: 'POST', url: '/api/runbooks/proposals',
      body: { kind: 'new', rationale: 'Probe: a kept file that climbs out of its bundle.', skill_md: '# x', files: [{ path: 'scripts/../../.ssh/authorized_keys', content: 'x' }] },
      refusal: 'a carried file must sit under scripts/ or data/ inside its bundle; one that climbs out with .. is refused before anything is parsed or stored',
      proves: 'gating', name: 'A captured file that climbs out of its bundle is refused', expect: { status: [400, 422] } },
  ],
} satisfies JourneyMap;
