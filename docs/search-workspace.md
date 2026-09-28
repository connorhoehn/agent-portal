# Search workspace

`/iq/search` combines Results, Answer, and Connections under one mounted conversation. The Org sidebar links to Search. Legacy `/search`, `/invoke`, `/iq/invoke`, `/explore`, `/graph`, and `/iq/explore` links retain their parameters and select the appropriate view.

The URL carries `q`, `type`, optional initiative `scope`, `tab`, pagination `offset`, `selection` and attached `context` as typed record keys, graph `layout`/`graphType`, and the existing conversation `session`. Results and graph selections use original identifiers. Selecting a record never changes its source. Designs remain initiative-linked design threads; publishing knowledge does not authorize execution.

The shared rich chat composer supports formatting, `#` record lookup, removable context, and `/agent <name or ID> <question>`. Ordinary questions use the supervisor's existing routing. Explicit agent requests use the same tenant and capability gates as all other invocations; attachment/workflow controls are not advertised without an implementation.

`GET /api/search` searches existing providers, returns permission-filtered counts, records, and verified edges, and reports partial or bounded source reads. `GET /api/search/records?keys=type:id,...` resolves selected records separately from the result page. The initial graph focuses the most relevant records; Show all expands it. Search is a bounded read model over existing providers, not a new semantic index.

Server-resolved context is emitted as a numbered `search_context` tool result and stored with the assistant turn. Inline citations, record rows, source links, and restored graph relationships use that observed metadata. Unsupported or truncated references are not turned into evidence. Context is untrusted data and grants no additional runtime permission.

Saved searches use `/api/saved-searches` CRUD and belong to the authenticated user and tenant. They store query/view/filter/selection state, not copied records or transcripts. Production deployments must apply `schema/search_workspace_schema.sql` (registered with `load_schema.py`). Mock mode follows the existing in-memory provider convention. Recent conversations continue to use AgentCore Memory; missing memory is displayed explicitly.

Verification covers query and selection persistence across views, legacy links, typed context, source restoration, saved-search ownership and CRUD, graph keyboard selection/layouts, automatic versus explicit agent routing, and composer/rail layout at desktop widths.
