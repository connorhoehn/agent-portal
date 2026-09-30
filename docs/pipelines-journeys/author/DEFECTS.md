# author — pipelines journey defects

## Open

None.

## Closed

1. **Configuration is in the rail for every pipelines role** — closed in lane E
   (2026-09-30). Decision: author and operator see **nothing** — no rail row,
   no palette row, and `/pipelines/configuration` redirects them home
   (`RequireRole roles={['pipeline-admin']}` in `App.tsx`; `requireRoles:
   ['pipeline-admin', 'admin']` in `Layout.tsx`; `roles: ['pipeline-admin']`
   in `portalCommands.ts`; `validate-nav-parity.sh` green). The one fact of
   the setting their work depends on — who approves a step by default — is
   already on every Definition and Approval ("Operator (default)"), so hiding
   the page hides no information from them. pipeline-admin (and admin) get the
   real page: the default approver role with Save (`PUT
   /api/pipelines/configuration`, `ManagePipelineConfig`). Re-walked in the
   configuration logs.
