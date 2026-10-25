# Detailed tenant journeys

Acceptance requirements for independent product use, October 25, 2026. These are proposed journeys and verification gates, not assertions that every behavior is implemented or verified. See [readiness review](README.md) for observed evidence, design proposals and backend gaps.

## Work

### Find and complete assigned work

**Actor:** Member or SME.

**Trigger:** A person starts their working day or follows an assignment notification.

**Entry:** /iq/projects → initiative → assigned work

1. See assignments, due dates and blockers without opening an operations tool.
2. Open the initiative and work item; read its owner, acceptance criteria, evidence and dependencies.
3. Add the required work or evidence, submit for review, and see who is responsible next.
4. Return from the notification or reload and see the same persisted state.

**Successful outcome:** The item advances with an owner and recorded evidence; the initiative reflects its actual state.

**Failure and recovery:** Empty assignments explain how work is assigned; failed saves retain edits; stale edits show a conflict; inaccessible deep links offer a useful return path.

**Authority:** Membership and work-write authority are checked at API and realtime boundaries, including after revocation.

**Backend acceptance:** Real Aurora write/read after process replacement; concurrent edit rejection; notification navigation; private initiative denial.

### Plan an initiative and unblock a decision

**Actor:** Program owner and decision maker.

**Trigger:** A delivery milestone is blocked by a decision.

**Entry:** /iq/projects → initiative → /iq/decisions/:id

1. State outcome, accountable owner, milestone and success criteria.
2. Create or attach the blocking decision and supporting documents.
3. Send the decision to an authorized reviewer; expose the reviewer and waiting state on the initiative.
4. Reviewer records rationale; the dependency and initiative update together.

**Successful outcome:** Everyone can explain what changed, who decided and which work is now unblocked.

**Failure and recovery:** Missing approver, rejected decision and changed evidence each show the next action; duplicate submissions create one decision.

**Authority:** An owner cannot silently act as a different reviewer; unauthorized users cannot access attached evidence.

**Backend acceptance:** Cross-record consistency, durable rationale, duplicate-submit protection and permission-aware evidence links.

### Run automation and recover a failure

**Actor:** SME or operator.

**Trigger:** Approved work is ready to execute, or a run has failed.

**Entry:** /iq/work → queue → run → findings or changes

1. Choose eligible work and a versioned procedure; show prerequisites and execution scope.
2. Launch once and see queued, running and waiting-for-review states.
3. Inspect output and evidence; accept or reject proposed changes within authority.
4. If execution fails, distinguish retryable failure from work needing correction and resume deliberately.

**Successful outcome:** The run has an attributable result or an actionable terminal failure; proposed changes are not silently applied.

**Failure and recovery:** Timeout, lost worker, budget limit, approval denial and duplicate callbacks all have explicit outcomes.

**Authority:** Run, approve and apply permissions remain separate; budget and tool authority are enforced server-side.

**Backend acceptance:** Real AgentCore dispatch/callback, restart recovery, idempotent completion, bounded retry and cost attribution.

### Find knowledge or an expert and act on it

**Actor:** Member or SME.

**Trigger:** A person needs evidence or help to complete work.

**Entry:** /iq/search → cited source or person → initiative

1. Ask a task-specific question or search in the current initiative.
2. Read an answer with source freshness and accessible citations.
3. Open the source or contact the person with the work context attached.
4. Return to the item and record the resulting decision or evidence.

**Successful outcome:** The answer leads to a verifiable source and useful work, rather than an isolated chat response.

**Failure and recovery:** No result, stale index, unavailable model and inaccessible citation are distinct; never fabricate a source.

**Authority:** Search results, snippets, citations and follow-up conversations obey current grants.

**Backend acceptance:** Fresh live ingestion → indexed retrieval → authorized citation; grant revocation removes visibility; model failure degrades clearly.

### Review delivery and funding

**Actor:** Organization leader or HR administrator.

**Trigger:** A review meeting requires an explanation of progress and spend.

**Entry:** /iq/projects → initiative → budget, runs and scores

1. Start with an outcome and compare actual progress to the plan.
2. Trace cost and risk to the work and runs that caused them.
3. Inspect relevant expertise or staffing evidence where authorized.
4. Record an allocation or ownership decision and verify its effect.

**Successful outcome:** Leadership can reconcile displayed totals to source records and identify accountable owners.

**Failure and recovery:** Partial data is marked; absent spend is not shown as zero; rejected allocations preserve the current ledger.

**Authority:** Sensitive people analytics and budget writes remain restricted even when initiative summaries are readable.

**Backend acceptance:** Real spend reconciliation, budget concurrency, audit attribution and analytics privacy checks.

### Improve a reusable procedure or agent

**Actor:** Author and reviewer.

**Trigger:** A successful run reveals a procedure worth reusing, or an existing procedure needs correction.

**Entry:** /iq/runbooks or /iq/library → asset → proposal and review

1. Find the asset by the work it performs and inspect its owner and version.
2. Propose a change with evidence from a run or an explicit requirement.
3. Review the diff and validate the exact version before accepting it.
4. Use the accepted asset in a new run and trace the result back to that version.

**Successful outcome:** Reusable knowledge improves through an attributable review and affects only intended future runs.

**Failure and recovery:** A stale base, rejected proposal or failed validation preserves the existing accepted version.

**Authority:** Read, propose, accept and execute authority are distinct; asset tools do not exceed the caller’s authority.

**Backend acceptance:** Real artifact persistence, version conflict, review attribution and execution of the accepted version; verify each supported asset kind.

### Start and recover a working environment

**Actor:** Authorized builder or operator.

**Trigger:** Work needs an agent or computer environment.

**Entry:** /iq/local-compute or authorized Computer Lab → environment → session

1. See availability, permitted tools, repository and expected cost before starting.
2. Start once and wait for a positive ready state.
3. Connect to the session and keep its work linked to the initiating task.
4. Reconnect after interruption, preserve output, then stop the environment and confirm resources are released.

**Successful outcome:** The environment is usable, scoped to the right work and does not continue billing unnoticed.

**Failure and recovery:** Capacity exhaustion, failed bootstrap, lost connection and expired credentials have explicit recovery paths.

**Authority:** Environment access, repository credentials and tool execution use scoped authority; secrets are never rendered.

**Backend acceptance:** Actual environment lifecycle, remote session reconnect, persistent output, cost limits and verified shutdown.

## Assessment

### Bring a team and evidence into assessment

**Actor:** Assessor.

**Trigger:** A team is ready for its first assessment.

**Entry:** /assessment/teams → team → /assessment/submissions

1. Identify the team, lead and assessment scope.
2. Upload or connect evidence; distinguish parsing, validation and committed submission.
3. Resolve missing fields and inspect the import summary before committing.
4. See the committed evidence attached to the correct team and assessment cycle.

**Successful outcome:** One durable submission has clear ownership, source and version.

**Failure and recovery:** Parse errors retain source context; expired staging asks for re-upload; duplicate commits do not duplicate evidence.

**Authority:** Only authorized assessors import for the selected team; storage access matches document authority.

**Backend acceptance:** Real upload/storage, parse/commit lifecycle, duplicate submission, staging expiry and durable evidence access.

### Verify a claim against evidence

**Actor:** Assessor and lead assessor.

**Trigger:** An assessment has claims awaiting verification.

**Entry:** /assessment/teams/:id → dimension → evidence

1. See claimed level, verified level and exact missing evidence together.
2. Open cited evidence and record the reasoning for a score.
3. Create a follow-up with an owner when evidence is insufficient.
4. Save and verify that team status and the report agree.

**Successful outcome:** A score is attributable, evidence-backed and consistent across team and report views.

**Failure and recovery:** Concurrent assessor changes are reconciled; removed evidence is flagged; a failed save preserves the draft.

**Authority:** Score writes use current role and team access; evidence does not leak through a citation.

**Backend acceptance:** Aurora transaction/concurrency, provenance stamps and report rollup consistency using real records.

### Resolve feedback and exceptions

**Actor:** Lead assessor.

**Trigger:** A contributor requests clarification or a not-applicable exception.

**Entry:** /assessment/feedback → linked team and criterion

1. Open a queue ordered by decisions awaiting the current reviewer.
2. Read the claim, supporting reason and previous conversation in context.
3. Approve, reject or request more information with a rationale.
4. Notify the submitter and update the criterion and rollup without losing the original claim.

**Successful outcome:** The requester knows the decision, the reason and their next step.

**Failure and recovery:** No eligible approver, duplicate decision and changed source evidence remain visible and recoverable.

**Authority:** Exception approval is separate from submitting the request; cross-team reads are enforced.

**Backend acceptance:** Concurrent decision tests on real persistence; actor attribution and correct notification recipient.

### Run an evidence assistant and recover

**Actor:** Assessor.

**Trigger:** Evidence needs extraction or a draft assessment.

**Entry:** /assessment/runs → team and source → run detail

1. Select an eligible command and committed source.
2. Launch and inspect queue, running and completion states.
3. Compare generated suggestions to source evidence before accepting them.
4. Stop, retry or correct failed work with a clear explanation of remote execution state.

**Successful outcome:** An attributable suggestion or failure is persisted once and never silently overwrites a stopped run.

**Failure and recovery:** Missing material fails before reservation; late callbacks after stop cannot write scores; service replacement does not lose accepted inputs.

**Authority:** The launch actor comes from the session; tool/runtime permissions and team scope are server-enforced.

**Backend acceptance:** Actual Aurora + AgentCore together, callback authentication, late completion, crash recovery and budget limits.

### Publish and revisit an assessment report

**Actor:** Program lead.

**Trigger:** A review cycle is ready for an accountable result.

**Entry:** /assessment/reports → report → source scorecard

1. Review unresolved claims and exceptions before publication.
2. Trace report summaries to scored dimensions and evidence.
3. Publish a named version and share it with an authorized reader.
4. Reopen the published version after later edits and distinguish it from current working scores.

**Successful outcome:** A reader can understand the result, its date and supporting evidence.

**Failure and recovery:** A report with missing evidence is explicit; publication failure cannot create a misleading success state.

**Authority:** Publication, draft access and shared links follow report/document permissions.

**Backend acceptance:** Durable version semantics, stable evidence links, permission-aware sharing and publish/reload round trip; verify supported publication behavior before promising it.

## Social

### Discover and join an ongoing room

**Actor:** Participant.

**Trigger:** A person wants to join colleagues without arranging a new call.

**Entry:** /social/rooms or the host workspace Communication → Rooms

1. See a room directory in the main area with purpose, access and occupancy.
2. Filter by active rooms or search a name; open details without joining unexpectedly.
3. Preview microphone/camera and join with an explicit action.
4. Keep room context visible during the call; leave and return to the directory.

**Successful outcome:** The user understands where they joined, who can hear them and how to leave.

**Failure and recovery:** No rooms gives a role-appropriate next step; denied media has recovery instructions; stale occupancy never guarantees an empty call; private rooms do not leak.

**Authority:** Only creators/members see private rooms; room creation is offered only with the right capability.

**Backend acceptance:** Real token-scoped listing, join denial, media permissions, reconnect, leave, narrow-screen navigation and two-person call.

### Start and continue a conversation

**Actor:** Participant.

**Trigger:** A person needs an answer from a colleague or group.

**Entry:** /social/dms or /social/channels

1. Find the person or channel by name and see why it is relevant.
2. Send a message with a clear pending, sent or failed state.
3. Follow replies, mentions and attached work without losing the conversation.
4. Reload or change device and return to the same history and unread position.

**Successful outcome:** The message reaches the intended audience and the sender can verify its state.

**Failure and recovery:** Offline sends, duplicate retries, expired sessions and deleted messages have explicit outcomes.

**Authority:** Membership is checked on reads, writes, subscriptions, mentions and attachments.

**Backend acceptance:** Durable chat history and read cursor, reconnect replay/deduplication and revocation during an open socket.

### Create and manage a team or room

**Actor:** Moderator or community administrator.

**Trigger:** A group needs a persistent place to collaborate.

**Entry:** /social/teams or /social/rooms → create

1. Name the purpose and choose public/private access.
2. Add permitted members and explain who can invite others.
3. Open the resulting room/channel and verify member access.
4. Change membership or archive the space with clear consequences.

**Successful outcome:** The intended people can find the space; removed people lose access promptly.

**Failure and recovery:** Name conflicts, partial member updates and interrupted creation are recoverable; ordinary participants get an honest request path.

**Authority:** Creation, invitations, membership changes and archive actions are gated at both BFF and platform.

**Backend acceptance:** Real platform persistence, atomic/idempotent creation, membership race, archive/reload and immediate access revocation.

### Call someone and handle a missed call

**Actor:** Participant.

**Trigger:** A conversation needs a live discussion.

**Entry:** /social/dms → call; Calls → missed call

1. Start a call from the existing conversation with the recipient visible.
2. The recipient accepts, declines or misses the ring.
3. Both parties can leave without losing the DM or call state.
4. A missed/cancelled unanswered call has a consistent log and a clear return-call action.

**Successful outcome:** Call state and history agree for both people.

**Failure and recovery:** Caller cancellation, reconnect, busy recipient and permission denial do not leave a stuck call.

**Authority:** Only authorized conversation members can join, read call history or subscribe to call events.

**Backend acceptance:** Two-person cross-browser proof, bounded ring timeout, duplicate signals and service reconnect.

### Record, find and manage a meeting recording

**Actor:** Participant and recording manager.

**Trigger:** A meeting outcome needs to be revisited.

**Entry:** /social/recordings → recording → source conversation

1. Start recording with visible status and applicable authority.
2. See processing or failure after the call; play when media is ready.
3. Find by meeting context, open the transcript and return to the source conversation.
4. An authorized manager deletes the recording and observes consistent removal.

**Successful outcome:** Playback and transcript match the meeting; deletion is reflected in every supported view.

**Failure and recovery:** Missing media, failed processing and expired links have recoverable states; deletion cannot leave a falsely playable item.

**Authority:** Recording ownership, playback URLs, transcript reads and deletion use current permissions.

**Backend acceptance:** Durable media/object lifecycle, signed URL expiry, transcript processing, delete consistency and real-platform search indexing.

## Pipelines

### Triage a failed or stuck run

**Actor:** Operator.

**Trigger:** An alert or attention queue identifies a failure.

**Entry:** /pipelines/runs → run → failed step

1. See cause, affected work, owner and the most recent successful step.
2. Open logs and artifacts in the same run context.
3. Choose an allowed retry, resume, cancel or escalation with its effects stated.
4. Observe a new attributable attempt and a reliable terminal state.

**Successful outcome:** The operator resolves the failure without duplicating side effects.

**Failure and recovery:** Unavailable source, worker loss, poison message and exhausted retry budget are distinguishable.

**Authority:** Operators can recover allowed work but cannot bypass authoring or approval policy.

**Backend acceptance:** Real queue delivery, leases, dead-letter behavior, idempotency and recovery after worker replacement.

### Author and validate a pipeline definition

**Actor:** Author.

**Trigger:** A repeatable process needs a change.

**Entry:** /pipelines/definitions → definition → version and dry run

1. Choose the definition, owner, input contract and allowed tools.
2. Edit a draft and compare it to the published version.
3. Run a bounded dry run and inspect outputs and failures.
4. Submit the exact tested version for approval.

**Successful outcome:** A reproducible, versioned definition is ready for a different person to approve.

**Failure and recovery:** Invalid configuration, changed base version and failing dry runs block promotion with useful feedback.

**Authority:** Authoring permission does not imply approval or production execution authority.

**Backend acceptance:** Durable versions, input validation, real dry-run records and promotion bound to the tested version.

### Review and approve a promotion

**Actor:** Authorized approver.

**Trigger:** A tested definition awaits a decision.

**Entry:** /pipelines/approvals → approval → definition and dry run

1. See the version diff, risk, owner and dry-run evidence.
2. Verify that prerequisites still apply.
3. Approve or reject with a rationale and see the resulting execution eligibility.
4. Return later and identify exactly which version was approved.

**Successful outcome:** One authorized decision applies to the intended version and is auditable.

**Failure and recovery:** Stale version, duplicate decision and missing evidence prevent silent promotion.

**Authority:** Separation of duties and required approver roles are checked at decision time.

**Backend acceptance:** Concurrent approval, stale evidence/version rejection, durable decision and permission revocation.

### Launch and follow an approved run

**Actor:** Operator.

**Trigger:** An approved process is ready to execute.

**Entry:** /pipelines/definitions → launch → /pipelines/runs/:id

1. Provide validated inputs and inspect scope, cost limit and version.
2. Launch once; show queue position/state and owner.
3. Follow steps, approvals, logs and artifacts.
4. Open the final output in its owning workspace.

**Successful outcome:** The run completes once with traceable inputs, outputs, cost and actor.

**Failure and recovery:** Transport timeout, duplicate launch and partial provider outage do not fabricate success.

**Authority:** Launch authority, artifact visibility and tool access remain scoped to the source workspace.

**Backend acceptance:** Real runner/queue/artifact store for each producer kind, restart durability and cross-workspace access.

### Operate queues and automation policy

**Actor:** Pipeline administrator.

**Trigger:** Capacity, failure volume or policy requires intervention.

**Entry:** /pipelines/queues, /pipelines/bots and /pipelines/configuration

1. Inspect backlog, active workers and dead-letter causes.
2. Pause or adjust an allowed source without losing queued work.
3. Change policy with its scope and effective time visible.
4. Verify recovery and review the change audit.

**Successful outcome:** Operations changes have bounded effects and do not lose or replay work unexpectedly.

**Failure and recovery:** Disconnected worker, unavailable metrics and failed policy save remain visible.

**Authority:** Administrative policy writes are separate from ordinary run access; secrets never appear in client payloads.

**Backend acceptance:** Backpressure/load test at an agreed target, worker rolling restart, policy durability and useful alerts.

## Access

### Understand and request access

**Actor:** Requester.

**Trigger:** A person cannot do their work or needs time-limited access.

**Entry:** /access/catalog → request → /access/requests/:id

1. See existing access and find a requestable role or resource in plain language.
2. Explain purpose, beneficiary and duration; see conflicts before submission.
3. Submit once and see the current reviewer and expected next step.
4. Follow requests for information without submitting a duplicate request.

**Successful outcome:** A durable request identifies what is requested, for whom, why and for how long.

**Failure and recovery:** Existing entitlement, duplicate request, policy conflict and no eligible reviewer get specific recovery paths.

**Authority:** Requesters act for themselves; requesting for others follows explicit role and manager authority.

**Backend acceptance:** Real provider request round trip, policy evaluation, duplicate submit and restart persistence.

### Decide a request with separation of duties

**Actor:** Approver.

**Trigger:** A request enters the approver inbox.

**Entry:** /access/approvals → request detail

1. See the beneficiary, resource, duration and business reason.
2. Review policy conflicts and the complete decision chain.
3. Approve, reject or request information with a reason.
4. See whether another step remains or provisioning has begun.

**Successful outcome:** The decision is attributable and cannot be mistaken for completed activation.

**Failure and recovery:** Self-approval, delegated authority changes, stale requests and concurrent decisions are handled explicitly.

**Authority:** Eligible approvers are resolved live; the beneficiary cannot approve their own access.

**Backend acceptance:** Running API on real persistence, concurrent decision once, delegation expiry and server-enforced self-approval refusal.

### Activate access and verify it works

**Actor:** Requester and access administrator.

**Trigger:** All required decisions are approved.

**Entry:** /access/requests/:id → destination workspace

1. Show provisioning as a separate state from approval.
2. Apply the entitlement once and record the effective scope and expiry.
3. Refresh session authority and open the destination workspace.
4. Verify the granted action works and unrelated actions remain denied.

**Successful outcome:** Approved access becomes a usable, bounded entitlement with audit evidence.

**Failure and recovery:** Provisioning failure has retry/escalation; a worker crash resumes without duplicate grants; stale sessions refresh safely.

**Authority:** Grant changes use current authorized decisions and preserve unrelated entitlements.

**Backend acceptance:** Real grant writer, idempotent provisioning, crash recovery, Cognito/session integration and end-to-end permission proof.

### Expire or revoke access everywhere

**Actor:** Access administrator or expiry worker.

**Trigger:** Access reaches its end date or must be removed.

**Entry:** /access/requests/:id or an authorized revoke action

1. Identify the exact entitlement and any dependent access.
2. Revoke once or allow the expiry worker to act.
3. Invalidate active authority and observe refusal on the next protected action.
4. Preserve the original approval and the revocation reason in audit history.

**Successful outcome:** The removed privilege cannot be used through an old session, API call, socket or shared link.

**Failure and recovery:** Concurrent renewal/revoke, disconnected clients and delayed sweeps produce an explicit final state.

**Authority:** Only authorized revokers act; removing one grant preserves unrelated roles.

**Backend acceptance:** Real expiry scheduler, live session/socket revocation, concurrent grant edits and durable audit.

### Review entitlements and maintain policy

**Actor:** Access administrator.

**Trigger:** A periodic review or policy change is due.

**Entry:** /access/reviews → item; /access/policies and /access/audit

1. See current beneficiaries, accountable reviewers and deadlines.
2. Review evidence and attest, revoke or request clarification.
3. Adjust policy or delegation with the effective scope visible.
4. Reconcile review outcomes to actual entitlements and export an authorized audit view.

**Successful outcome:** The organization can explain who has access and why, with review actions actually applied.

**Failure and recovery:** Missing manager, expired delegate, incomplete review and failed revoke remain outstanding.

**Authority:** Policy editing, review decisions and audit visibility have separate authority; delegation never enables self-approval.

**Backend acceptance:** Real review persistence, scheduled escalation, delegation boundaries and reconciliation against live grants.

## Shared platform

### Create, review and share a document

**Actor:** Contributor, reviewer and reader.

**Trigger:** Work needs a durable document, diagram or report.

**Entry:** Owning work record → documents → draft, review and published version

1. Create or attach the document with its work context intact.
2. Edit with another authorized contributor and inspect version history.
3. Request and record review before publishing where the workflow requires it.
4. Share a stable link, revisit a prior version and verify that permissions follow the document.

**Successful outcome:** The document has an accountable version, supported collaborative behavior and a reliable link back to its work.

**Failure and recovery:** Concurrent edits, offline changes, deleted attachments and rejected review do not silently lose content.

**Authority:** Each document/deck type must use its actual read, edit, review and publish permissions; do not infer parity from a shared editor.

**Backend acceptance:** Real content/object stores, collaborative reconnect, comment migration, version restoration and cross-role share-link checks for each supported content type.

### Connect a source and keep knowledge current

**Actor:** Authorized administrator and knowledge user.

**Trigger:** An organization adds or changes a source of truth.

**Entry:** Knowledge administration → source → ingestion → search and cited answer

1. Connect the supported source with scoped credentials and inspect intended data access.
2. Run ingestion and expose validation, progress and errors.
3. Find a newly ingested item and open its exact source from search.
4. Update or remove the source item and verify that index, citations and access converge.

**Successful outcome:** Knowledge is current, traceable and subject to the source’s access rules.

**Failure and recovery:** Expired credentials, rate limits, partial imports and deleted sources show actionable states and safe resumable progress.

**Authority:** Connector credentials and document ACLs stay scoped; index results cannot broaden source authority.

**Backend acceptance:** Live connector ingestion, actual storage/index/model path, ACL propagation, freshness/deletion convergence and credential rotation.

### First sign-in and workspace selection

**Actor:** New client user.

**Trigger:** An administrator provisions a user through the supported identity system.

**Entry:** SSO → workspace chooser → role-appropriate home

1. Complete real SSO and see only granted workspaces.
2. Choose a workspace and understand its purpose and next action.
3. Follow an invited deep link without losing intended context.
4. Sign out and verify that expired sessions return safely to sign-in.

**Successful outcome:** A new user reaches useful work without fixture identities or developer setup.

**Failure and recovery:** No grants, disabled account, expired invitation and identity-provider failure each have a clear explanation.

**Authority:** Claims are server-validated; workspace choice cannot create grants.

**Backend acceptance:** Actual identity-provider provisioning, callback, logout, expiry and deprovisioning; picker-mode proof is insufficient.

### Private work remains private across every surface

**Actor:** Two users with different grants.

**Trigger:** A private record is created or a user loses access.

**Entry:** Direct URL, search, notifications, chat, files and realtime

1. Create an allowed private record and share only with the intended reader.
2. Attempt access from a different role and workspace.
3. Remove the allowed reader while their page/socket is open.
4. Recheck links, previews, files, cached search and subscriptions.

**Successful outcome:** No protected content leaks through a secondary surface.

**Failure and recovery:** Stale caches and reconnects fail closed while preserving useful user-facing explanations.

**Authority:** Separate product-workspace isolation from separate client-organization isolation.

**Backend acceptance:** Cross-user/product tests plus an agreed client deployment isolation model; two organizations if shared SaaS is intended.

### Recover from interruption without losing work

**Actor:** Any active user.

**Trigger:** The network, browser, worker or service is interrupted.

**Entry:** Any editing or running journey

1. Create a draft or start a real operation.
2. Interrupt at a known stage and restore connectivity.
3. See which data was saved, pending or failed.
4. Retry without duplicate side effects and recover the same record.

**Successful outcome:** The user can explain the final state and resume safely.

**Failure and recovery:** Conflicts, timeouts and partial success never become silent data loss.

**Authority:** Resumption revalidates current grants and operation ownership.

**Backend acceptance:** Browser offline/reconnect, BFF replacement, worker crash, database transient failure and duplicate delivery.

### Operate and restore a client environment

**Actor:** Service operator.

**Trigger:** A deployment, incident or restore is required.

**Entry:** Deployment pipeline → observability → recovery runbook

1. Deploy the exact schema and service versions with preflight checks.
2. Observe dependency readiness, errors, latency and job age.
3. Rollback or recover a failed deployment without corrupting data.
4. Restore a backup and verify selected business journeys.

**Successful outcome:** The service has an owned recovery path and measurable operating limits.

**Failure and recovery:** Migration failure, partial provider outage and missing secrets cause bounded failure and actionable alerts.

**Authority:** Operator access is restricted and audited; client data and secrets stay out of logs.

**Backend acceptance:** Staging deploy/rollback, backup restore, secret rotation, target-load test and alert exercise with explicit recovery objectives.
