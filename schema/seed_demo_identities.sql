-- Demo identities: the sign-in cast for local and demo databases ONLY.
--
-- Not in schema/manifest.json and not applied by load_schema.py, a deploy, or
-- a plain `python3 schema/apply_all_seed.py`. Apply it on purpose with
-- `python3 schema/apply_all_seed.py --with-demo-users` (refused for a
-- production target; see schema/README.md). It includes
-- u-operator, which holds `admin` in all five tenants, and real-looking
-- emails: never apply it to a shared or production cluster.
--
-- Needs the tables from identity_schema.sql. person_id subqueries resolve to
-- NULL when the org graph isn't seeded yet, so this file loads cleanly in any
-- order relative to seed.sql (access_schema.sql re-links the access cast).
-- The offline mirror of these rows is FALLBACK_USERS in
-- middleware/src/providers/identity.ts; the parity tests compare the two.

INSERT INTO app_users (id, display_name, email, person_id) VALUES
  ('u-operator', 'Platform Operator', 'operator@orgiq.example', NULL),
  ('u-theo',     'Theo Chang',        'theo.chang@orgiq.example',
     (SELECT id FROM people WHERE name = 'Theo Chang' LIMIT 1)),
  ('u-vera',     'Vera Green',        'vera.green@orgiq.example',
     (SELECT id FROM people WHERE name = 'Vera Green' LIMIT 1)),
  ('u-hr',       'Helen Desai',       'helen.desai@orgiq.example', NULL),
  -- Program operating model cast (docs/program-operating-model.md): a release
  -- manager who grants SME budget envelopes, a program operator who runs the
  -- program surfaces, and SMEs who masquerade in and assign compute to work.
  ('u-release',  'Sienna Garcia',     'sienna.garcia@orgiq.example',
     (SELECT id FROM people WHERE name = 'Sienna Garcia' LIMIT 1)),
  ('u-rachel',   'Rachel Kowalski',   'rachel.kowalski@orgiq.example',
     (SELECT id FROM people WHERE name = 'Rachel Kowalski' LIMIT 1)),
  ('u-mia',      'Mia Singh',         'mia.singh@orgiq.example',
   (SELECT id FROM people WHERE id = 'p-030')),
  ('u-nora',     'Nora DaSilva',      'nora.dasilva@orgiq.example',
     (SELECT id FROM people WHERE name = 'Nora DaSilva' LIMIT 1)),
  ('u-eli',      'Eli Garcia',        'eli.garcia@orgiq.example',
     (SELECT id FROM people WHERE name = 'Eli Garcia' LIMIT 1)),
  ('u-layla',    'Layla Hassan',      'layla.hassan@orgiq.example',
     (SELECT id FROM people WHERE name = 'Layla Hassan' LIMIT 1)),
  ('u-caleb',    'Caleb Turner',      'caleb.turner@orgiq.example',
     (SELECT id FROM people WHERE name = 'Caleb Turner' LIMIT 1)),
  -- Initiative owners and deciders (docs/demo-script.md): every initiative's
  -- owner and every waiting decision's decider can sign in as themselves.
  ('u-nina',     'Nina Rivera',       'nina.rivera@orgiq.example',
     (SELECT id FROM people WHERE id = 'p-047')),
  ('u-paolo',    'Paolo Mancini',     'paolo.mancini@orgiq.example',
     (SELECT id FROM people WHERE id = 'p-049')),
  ('u-katya',    'Katya Petrov',      'katya.petrov@orgiq.example',
     (SELECT id FROM people WHERE id = 'p-042')),
  ('u-daniel',   'Daniel Novak',      'daniel.novak@orgiq.example',
     (SELECT id FROM people WHERE id = 'p-017')),
  ('u-anika',    'Anika Mehta',       'anika.mehta@orgiq.example',
     (SELECT id FROM people WHERE id = 'p-025')),
  ('u-ben',      'Ben Okafor',        'ben.okafor@orgiq.example',
     (SELECT id FROM people WHERE id = 'p-035')),
  ('u-isabel',   'Isabel Vasquez',    'isabel.vasquez@orgiq.example',
     (SELECT id FROM people WHERE id = 'p-038')),
  ('u-lucas',    'Lucas Kim',         'lucas.kim@orgiq.example',
     (SELECT id FROM people WHERE id = 'p-048')),
  ('u-diego',    'Diego Ortiz',       'diego.ortiz@orgiq.example',
     (SELECT id FROM people WHERE id = 'p-052')),
  ('u-simone',   'Simone Chang',      'simone.chang@orgiq.example',
     (SELECT id FROM people WHERE id = 'p-051')),
  -- Assessment tenant cast (docs/assessment-tenant.md Roles (Cedar)).
  ('u-asha',     'Asha Nair',         'asha.nair@assessment.example', NULL),
  ('u-jonas',    'Jonas Lindqvist',   'jonas.lindqvist@assessment.example', NULL),
  ('u-farah',    'Farah Osei',        'farah.osei@assessment.example', NULL),
  -- Social tenant cast (docs/social-tenant-design.md §4.1): one per role,
  -- holding a grant only in social so their outbound walks start clean.
  ('u-mira',     'Mira Okafor',       'mira.okafor@social.example', NULL),
  ('u-lena',     'Lena Brandt',       'lena.brandt@social.example', NULL),
  ('u-sana',     'Sana Iqbal',        'sana.iqbal@social.example', NULL),
  -- Pipelines tenant cast (docs/pipelines-tenant-goal.md §Cast): one per role,
  -- holding a grant only in pipelines.
  ('u-ines',     'Ines Moreau',       'ines.moreau@orgiq.example', NULL),
  ('u-kofi',     'Kofi Mensah',       'kofi.mensah@orgiq.example', NULL),
  ('u-dara',     'Dara Whitfield',    'dara.whitfield@orgiq.example', NULL),
  -- Not part of the pure cast above: the Communication-plane walker for
  -- pipelines (docs/communication-plane-goal.md) — a pipelines author who also
  -- holds Social, so that tenant's plane has a granted user while u-ines/u-kofi/
  -- u-dara keep their pipelines-only outbound isolation walks.
  ('u-tomas',    'Tomás Ferreira',    'tomas.ferreira@orgiq.example', NULL),
  -- Access tenant cast (docs/access-tenant-goal.md §Cast): one per role,
  -- holding a grant only in access. Their people rows (and Omar as Rhea's
  -- manager through people.manager_id) are seeded by access_schema.sql, which
  -- also re-links person_id when this file loaded before those rows existed.
  ('u-rhea',     'Rhea Castellanos',  'rhea.castellanos@orgiq.example',
     (SELECT id FROM people WHERE id = 'p-rhea')),
  ('u-omar',     'Omar Haddad',       'omar.haddad@orgiq.example',
     (SELECT id FROM people WHERE id = 'p-omar')),
  ('u-priya',    'Priya Venkataraman', 'priya.venkataraman@orgiq.example',
     (SELECT id FROM people WHERE id = 'p-priya'))
ON CONFLICT (id) DO NOTHING;

INSERT INTO user_tenant_roles (user_id, tenant_id, role) VALUES
  -- Cross-tenant operator: the only identity allowed to masquerade.
  ('u-operator', 'orgiq',    'admin'),
  ('u-operator', 'assessment', 'admin'),
  ('u-operator', 'social',   'admin'),
  ('u-operator', 'pipelines', 'admin'),
  ('u-operator', 'access',   'admin'),
  -- OrgIQ-only users, one per role tier.
  ('u-theo',     'orgiq',    'member'),
  ('u-vera',     'orgiq',    'org-leader'),
  ('u-vera',     'orgiq',    'member'),
  ('u-hr',       'orgiq',    'hr-admin'),
  -- Release manager: allocates initiative budgets and grants SME envelopes
  -- (org-leader carries ManageBudgets + DispatchAgentRun).
  ('u-release',  'orgiq',    'org-leader'),
  ('u-release',  'orgiq',    'member'),
  -- Program operator: runs bots/identity/program governance surfaces.
  ('u-rachel',   'orgiq',    'hr-admin'),
  ('u-rachel',   'orgiq',    'org-leader'),

  -- The program owner: runs the delivery program (sprints, bots, the board)
  -- without the allocation authority (see seeds/roles/orgiq/program-owner.cedar).
  ('u-mia',      'orgiq',    'program-owner'),
  ('u-mia',      'orgiq',    'member'),
  -- SMEs: dispatch agent work against their granted envelopes.
  ('u-nora',     'orgiq',    'sme'),
  ('u-eli',      'orgiq',    'sme'),
  ('u-layla',    'orgiq',    'sme'),
  ('u-caleb',    'orgiq',    'sme'),
  -- Initiative owners and deciders: members of Work (a decider decides as the
  -- named participant, lib/decision-authority.ts, so none needs org-leader).
  ('u-nina',     'orgiq',    'member'),
  ('u-paolo',    'orgiq',    'member'),
  ('u-katya',    'orgiq',    'member'),
  ('u-daniel',   'orgiq',    'member'),
  ('u-anika',    'orgiq',    'member'),
  ('u-ben',      'orgiq',    'member'),
  ('u-isabel',   'orgiq',    'member'),
  ('u-lucas',    'orgiq',    'member'),
  ('u-diego',    'orgiq',    'member'),
  ('u-simone',   'orgiq',    'member'),

  -- Assessment tenant: assessor -> lead-assessor -> program-lead ladder.
  ('u-asha',     'assessment', 'assessor'),
  ('u-jonas',    'assessment', 'lead-assessor'),
  ('u-jonas',    'assessment', 'assessor'),
  ('u-farah',    'assessment', 'program-lead'),
  ('u-farah',    'assessment', 'lead-assessor'),

  -- Social tenant: participant -> moderator -> community-admin ladder.
  ('u-mira',     'social',   'community-admin'),
  ('u-lena',     'social',   'moderator'),
  ('u-sana',     'social',   'participant'),
  -- The curated orgiq cast and the assessment cast join social as
  -- participants, so a channel can be embedded where they already work
  -- (design §4.1, E5). Since 2026-10-07 every orgiq cast member with a linked
  -- person holds it too (the Communication plane, docs/communication-plane-goal.md,
  -- is the Social tenant seen from the host tenant; SMEs appear in its calls),
  -- and one pipelines author (u-tomas, outside the pure pipelines cast) so that
  -- tenant's plane has a granted walker. u-hr, u-ines, u-kofi, u-dara and the cookie-less demo identity hold no
  -- social grant: the isolation walks and the no-grant journeys need them.
  ('u-theo',     'social',   'participant'),
  ('u-vera',     'social',   'participant'),
  ('u-release',  'social',   'participant'),
  ('u-rachel',   'social',   'participant'),
  ('u-mia',      'social',   'participant'),
  ('u-nora',     'social',   'participant'),
  ('u-eli',      'social',   'participant'),
  ('u-layla',    'social',   'participant'),
  ('u-caleb',    'social',   'participant'),
  ('u-nina',     'social',   'participant'),
  ('u-paolo',    'social',   'participant'),
  ('u-katya',    'social',   'participant'),
  ('u-daniel',   'social',   'participant'),
  ('u-anika',    'social',   'participant'),
  ('u-ben',      'social',   'participant'),
  ('u-isabel',   'social',   'participant'),
  ('u-lucas',    'social',   'participant'),
  ('u-diego',    'social',   'participant'),
  ('u-simone',   'social',   'participant'),
  ('u-asha',     'social',   'participant'),
  ('u-jonas',    'social',   'participant'),
  ('u-farah',    'social',   'participant'),
  ('u-tomas',    'social',   'participant'),

  -- Pipelines tenant: author / operator / pipeline-admin, separation of duties
  -- between who writes a definition and who approves its steps.
  ('u-ines',     'pipelines', 'author'),
  ('u-kofi',     'pipelines', 'operator'),
  ('u-dara',     'pipelines', 'pipeline-admin'),
  -- Communication-plane walker: pipelines author + social participant (above).
  ('u-tomas',    'pipelines', 'author'),

  -- Access tenant: requester / approver / access-admin. Nobody decides a
  -- request they submitted or benefit from (a route rule, docs/access-tenant-goal.md).
  ('u-rhea',     'access',   'requester'),
  ('u-omar',     'access',   'approver'),
  ('u-priya',    'access',   'access-admin'),
  -- Work's stewards decide the steward step of an access request themselves
  -- (lib/access/chain.ts): Rachel stewards Work roles (hr-admin), Vera owns
  -- Auth Migration. Without a deciding role in Access every steward step
  -- escalated to Priya (docs/demo-content-audit.md, Access story-breaker 2).
  ('u-vera',     'access',   'approver'),
  ('u-rachel',   'access',   'approver')
ON CONFLICT DO NOTHING;
