// Shared pieces of the distillation family's maps (docs/distillation-journeys/PROTOCOL.md).
// org-leader holds ManageBots (Compact, Review Agree/Disagree); member does not,
// and for member those controls must be absent from the DOM.
import type { Persona, Step, Target } from '../../../../scripts/journeys/journey-map.ts';

export type Role = 'member' | 'org-leader';
export const PERSONA: Record<Role, Persona> = {
  member: { user: 'u-theo', name: 'Theo Chang', tenant: 'orgiq', role: 'member' },
  // Vera lands as member (her first grant): the walk switches her into org-leader (as a clone, only the clone's epoch moves).
  'org-leader': { user: 'u-vera', name: 'Vera Green', tenant: 'orgiq', role: 'org-leader', switchRole: true },
};
const inMain = (name: RegExp): Target => ({ role: 'button', name, within: { css: 'main' } });
const COMPACT = inMain(/^Compact/);
const AGREE: Target = { testId: 'review-agree' };
const DISAGREE: Target = { testId: 'review-disagree' };
const FOLD = 640;
const EXPLORER: Target = { role: 'navigation', name: 'Explorer' };
const firstItem: Target = { css: 'li button', within: EXPLORER, nth: 0 };
const tabWalk = (min: number): Step => ({ do: 'tab-walk', name: 'Tab from the top of the page through every control', proves: 'keyboard', expect: { minVisited: min } });

export const SURFACES = {
  knowledge: (role: Role): Step[] => [
    { do: 'navigate', url: '/iq/distillation/knowledge', name: 'Open Knowledge: guides and findings, the first row above the fold', expect: { url: '/iq/distillation/knowledge', visible: [{ role: 'heading', level: 1 }], firstRowTopMax: FOLD } },
    { do: 'navigate', url: '/iq/distillation/knowledge', name: 'No Compact, Agree or Disagree control on Knowledge for any role', proves: 'role-gating', audit: false, auditReason: 'the resting state step 1 measured', expect: { absent: [COMPACT, AGREE, DISAGREE] } },
    tabWalk(10),
    { do: 'fill', target: { role: 'textbox', name: 'Search guides & findings' }, value: 'zzzzqq', name: 'Search for zzzzqq: the list says No matches', state: 'filtered-empty', proves: 'empty-state', expect: { text: ['No matches'] } },
    { do: 'navigate', url: '/iq/distillation/knowledge', name: 'Reload Knowledge', audit: false, auditReason: 'the resting state step 1 measured' },
    { do: 'press', key: 'Enter', target: firstItem, name: 'Press Enter on the first guide: it opens in the page', state: 'row-open', proves: 'keyboard', expect: { url: /^\/iq\/distillation\/knowledge\?item=/ } },
  ],
  review: (role: Role): Step[] => [
    { do: 'navigate', url: '/iq/distillation/review', name: 'Open Review: it lands on the first pending sample', expect: { url: /^\/iq\/distillation\/review/, visible: [{ role: 'heading', level: 1 }], firstRowTopMax: FOLD } },
    role === 'org-leader'
      ? { do: 'navigate', url: '/iq/distillation/review', name: 'Agree and Disagree are offered to the org leader (ManageBots)', proves: 'role-gating', audit: false, auditReason: 'the resting state step 1 measured', expect: { visible: [AGREE, DISAGREE] } }
      : { do: 'navigate', url: '/iq/distillation/review', name: 'A member reads the review: no Agree or Disagree in the DOM', proves: 'role-gating', audit: false, auditReason: 'the resting state step 1 measured', expect: { absent: [AGREE, DISAGREE, COMPACT] } },
    tabWalk(10),
    { do: 'fill', target: { role: 'textbox', name: 'Find a review' }, value: 'zzzzqq', name: 'Search for zzzzqq: the list says No matches', state: 'filtered-empty', proves: 'empty-state', expect: { text: ['No matches'] } },
  ],
  activity: (role: Role): Step[] => [
    { do: 'navigate', url: '/iq/distillation/activity', name: 'Open Activity: compaction runs, the first row above the fold', expect: { url: '/iq/distillation/activity', visible: [{ role: 'heading', level: 1 }], firstRowTopMax: FOLD } },
    role === 'org-leader'
      ? { do: 'navigate', url: '/iq/distillation/activity', name: 'Compact is offered to the org leader (ManageBots)', proves: 'role-gating', audit: false, auditReason: 'the resting state step 1 measured', expect: { visible: [COMPACT] } }
      : { do: 'navigate', url: '/iq/distillation/activity', name: 'A member reads the activity: no Compact, Agree or Disagree in the DOM', proves: 'role-gating', audit: false, auditReason: 'the resting state step 1 measured', expect: { absent: [COMPACT, AGREE, DISAGREE] } },
    tabWalk(10),
    { do: 'fill', target: { role: 'textbox', name: 'Search runs' }, value: 'zzzzqq', name: 'Search the runs for zzzzqq: no run matches', state: 'filtered-empty', proves: 'empty-state', expect: { text: [/0 of \d+ runs/] } },
    { do: 'navigate', url: '/iq/distillation/activity', name: 'Reload Activity', audit: false, auditReason: 'the resting state step 1 measured' },
    { do: 'click', target: { role: 'button', name: 'Filter runs' }, name: 'Open the runs filter: a dialog', state: 'filters-open', expect: { visible: [{ role: 'dialog' }] } },
    { do: 'press', key: 'Escape', name: 'Escape closes the filter dialog', proves: 'keyboard', expect: { hidden: [{ role: 'dialog' }] } },
  ],
} satisfies Record<string, (role: Role) => Step[]>;

export const PAGES = {
  knowledge: 'portal/src/pages/distillation',
  review: 'portal/src/pages/distillation',
  activity: 'portal/src/pages/distillation',
};
export const GOALS: Record<Role, Record<keyof typeof SURFACES, string>> = {
  member: {
    knowledge: 'Theo reads the distilled guides and findings, narrows them and opens one with its provenance',
    review: 'Theo reads the review queue without being able to agree or disagree',
    activity: 'Theo reads the compaction activity without being able to start a compaction',
  },
  'org-leader': {
    knowledge: 'Vera reads the distilled guides and findings, narrows them and opens one with its provenance',
    review: 'Vera works the review queue, where Agree and Disagree are hers to use',
    activity: 'Vera reads the compaction activity, where Compact is hers to use',
  },
};
