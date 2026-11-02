# Initiative portrait follow-up

The reported LLM Platform Overview had two mappings that discarded portraits:
the attention/up-next model retained only assignee names, and Recent activity
retained only its participant's name. The Work table already carried portraits.

Overview now resolves contributor photos by person id. Recent activity preserves
participant ids and optional snapshot portraits, then uses the host's authorized
contributor data when the snapshot has no image. Unknown identities and genuinely
missing photos keep initials; namesakes never supply another person's image.

The generic `demo-user` session was outside the seeded portrait cast and has no
directory person. It now has its own synthetic portrait, carried through the
shared directory's self record and the signed realtime token. The identity and
permission rules are unchanged. Reload an existing browser session to acquire a
fresh realtime token and reconnect presence.

Generated with the built-in imagegen tool in one request:

- Asset: `portal/public/avatars/photos/demo-user.jpg` (256px JPEG).
- Prompt: `scripts/avatars/prompts/2026-11-02-demo-user.txt`.
- Source hash and processing notes: the Demo User entry in
  `portal/public/avatars/photos/personas.json`.
- The generator and fixture now cover 72 identities: 59 people, 12 unlinked
  accounts and the generic demo session. Existing portraits are unchanged.

## Verification

Evidence is in `.scratch/initiative-avatars-2026-11-02/`:

- 33 focused portal tests and 23 middleware tests pass.
- Portal/middleware type checks, portal build, avatar-index validation and
  component-discipline checks pass.
- Two live browser cases verify loaded images in both themes on LLM Platform
  and Observability: overview rows, Recent activity, Work table, generic demo
  presence and the missing-photo fallback. Business writes were blocked.
- Screenshots were visually checked. No shared component API or styling changed.

The full portal suite still reports one unrelated Assessment navigation test
failure (`nav model: rail, palette and trail say Communication` expects
`Assess / Communication`; the concurrent breadcrumb edit emits `Communication`).
Those Assessment edits are outside this avatar commit and were left untouched.
Existing audit and deployed-avatar backfill debt remains in the earlier handoffs.
