# Assessment document workflow bridge

`DOCUMENT_PLATFORM_INTERNAL_URL` is the private platform API origin. The BFF
resolves a source `id` to its canonical document mapping and obtains a short-lived,
revocable document grant. It never accepts a browser's document UUID, actor,
operation grant, platform path, or credentials. Platform authorization, assigned
reviewers, lifecycle transitions, and compare-and-swap remain authoritative.

Every endpoint starts with `/api/assessment/knowledge/doc/workflows` and requires
`?id=<source ID>`, an assessment session, and `ViewAssessment`. Responses use
`Cache-Control: no-store`. Platform success bodies are preserved with the canonical
`documentId` added; error HTTP statuses and `{error, code}` remain intact. Transport
failure returns 503. Calls are bounded to eight seconds and never follow redirects.

| Method | Suffix | Accepted body |
| --- | --- | --- |
| GET | empty | Lifecycle, availableActions, outstandingReviews |
| POST | `/transitions` | action, reason |
| POST | `/ownership` | Empty; deliberate claim only |
| GET | `/review-requests` | No body |
| POST | `/review-requests` | reviewerId, sectionId, dueDate, note, required |
| PATCH | `/review-requests/:requestKey` | state, comment, dueDate |
| GET | `/reviews` | No body |
| GET | `/sections/:sectionId/items` | No body |
| POST | `/sections/:sectionId/items/:itemId/ack` | Empty |
| POST | `/sections/:sectionId/items/:itemId/answer` | answer |

Unknown body fields are rejected. Resource keys remain single encoded URL
segments; dot traversal and separators are rejected. Items use an existing section
identity; the bridge does not fabricate anchors for imported document comments.
Existing BFF comment/reaction records remain their current compatibility authority.

A lifecycle action appears only when the platform returns it in `availableActions`.
Ownership is not claimed on a read or automatically after a refusal. A manage grant
requires the source mapping's explicit `owner_sub` to match the signed session and
`ManageKnowledge`. Ordinary browser canvas grants never carry manage. Source
publication remains a distinct action handled by the source adapter.

The lifecycle GET additionally returns `canManageWorkflow` (both explicit source
manager and platform owner) and `canClaimOwnership` (explicit source manager with
no platform owner). Neither changes ownership or widens browser transport grants.
`GET /reviewers` returns `{reviewers:[{id,displayName}]}` only to a workflow manager,
using current assessment identities with ViewAssessment. Review assignment checks
the selected identity authoritatively before contacting platform.

`POST /versions` accepts `{name?:string}` and returns the acknowledged binary
snapshot `{timestamp,name}`. `POST /versions/restore` accepts `{timestamp:number}`
and returns `{timestamp,restored:true}` only after the gateway acknowledgement.
Save requires ManageKnowledge and writable content; restore also requires the
platform owner and the existing source-manager grant. The caller must flush its
pending CRDT writes before saving a named version. The BFF hydrates the canonical
channel before either operation, never reconstructs Markdown, never accepts actor
identity, and never exposes its manage grant. Gateway authority rechecks lifecycle
locks and live session revocation when the operation runs.
