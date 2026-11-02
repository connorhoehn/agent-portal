# UI audit ownership review

Reviewed the project skill directories, their scripts, Claude instructions, the
Codex/Claude skill links, and the existing ui-components audit package.

The portable UI checks should have one owner in **ui-components**, with small
consumer adapters here. Copying entire skills into both repositories would let
their contracts drift.

| Skill or check | Decision | Reason |
| --- | --- | --- |
| `ui-dom-audit` | Already owned correctly by `ui-components/skills/ui-dom-audit` | This project's `.claude/skills/ui-dom-audit` and both user-level Codex/Claude links resolve to that directory. The engine, contract, mutation fixtures and reports are already shared. The new breadcrumb rule belongs there and was added there. |
| `scripts/audit-ui-inheritance.cjs` | Extract its reusable source-analysis and installed-package verification into ui-components next | Its TypeScript AST checks for component overrides, private CSS selectors, local compositions, and package/archive drift apply to every consumer. Its hardcoded portal paths, required RunsLedger/CollectionPage migrations and density entry point belong in an app adapter. |
| `scripts/validate-component-discipline.sh` and `scripts/lib/discipline.sh` | Share the counting/inspection primitives; retain this gate and its policy here | Per-directory ratchets, `docs/ui-components-queue.md` exceptions and tenant-specific cleanup budgets are application policy. They should not become universal library allowances. |
| Generic measurements in `portal/e2e/layout-cascade.spec.ts` and related typography/rail specs | Consolidate remaining generic rules into the existing DOM audit skill | Breadcrumb placement, title alignment, rail geometry and typography belong to shared components. Route inventories, actor setup, role visibility, tenant switching and collapse/navigation scenarios remain consumer tests. Preserve valid/broken fixtures during extraction. |
| `skills/cdp-browser` | Keep as optional browser tooling, not a second UI consistency skill | Its isolated contexts and screenshot sidecars are reusable, but it is a transport helper, not a component contract. If another repository needs it, share it through common developer tooling. Keep app sign-in outside the helper. |
| `.claude/skills/demo-recording` | Keep here | It records this product's Computer Lab story, fixture actors, dispatch and review flow. Generic recording guidance may be a reference, but the whole skill is app-specific. |
| `.claude/skills/deployed-stack-debug` | Keep here | AWS account, Aurora, Cognito, Redis, deployed task configuration and cloud smoke tests belong to this stack. Generic bundle inspection could become a separate build-tool helper if another consumer needs it. |
| Journey judges, maps and seals | Keep here | They prove product paths and permissions against this repository's source revision, rather than library appearance. |

## Recommended next extraction

Add a source-audit mode beside the existing ui-components DOM audit, accepting
project root, TypeScript installation, source globs, package identity and a
consumer policy adapter. Keep `scripts/audit-ui-inheritance.cjs` as a thin wrapper.
Move its reusable AST and archive-integrity fixtures with the implementation.
Compare the old and extracted reports on the same source tree before switching
the gate. Do not convert review candidates into hard failures or relax existing
ratchets as part of the move.

This review records the ownership decision; it does not claim that source-audit
extraction has been performed. The active DOM audit already has the intended
shared ownership, and this change extends it without creating a duplicate skill.
