# Audit 2026-10-06

## Delta since last run
- new: typing is now wired in the shared chat panel. The untracked `portal/src/components/chat/composerTyping.ts` feeds `SummarizableChatPanel.tsx:18,86,98,102` (`setTyping` and `typingUsers`), and `SocialConversation.tsx:43,279,339,344` does the same. `docs/audit-loop/realtime-parity.md` §4/§4a still lists typing as ❌ in assessment, social and pipelines, so that row is stale. I did not browser-verify it or check `DocumentConversation`, so I left the cells unflipped.
- fixed: nothing new.
- still open: 2. These are the inline `style={{` hits in `WeightedEdge.tsx:57,70` and `VersionPickerStep.tsx:63,70`.
- parity ❌/⚠️ remaining, from the §4 tally and not re-verified cell by cell (typing flips pending): orgiq 20/38 · assessment 23/38 · social 19/38 · pipelines 18/38 (7 of those rows are "—").
- Both gates pass (`gates.log`). `useNotifications(` has one non-test mount, `SharedNotifications.tsx:20`, so there is no duplicate.

## Findings
| # | severity | file:line | what is hand-rolled | replace with | exists in installed dist? |
|---|---|---|---|---|---|
| 1 | low | `portal/src/components/canary/edges/WeightedEdge.tsx:57,70` | `strokeWidth` and the label `translate(...)` are computed per render. | A library weighted-edge or edge-label composite. | upstream-needed. Covered by the queue row at `ui-components-queue.md:221`. |
| 2 | low | `portal/src/components/canary/setup/VersionPickerStep.tsx:63,70` | A runtime `borderLeftColor` and a bare radio with a runtime `accentColor`. | A standalone `Radio` or a rich-row `RadioGroup`. | upstream-needed. Covered by the queue row at `ui-components-queue.md:53`. |
| 3 | low | `portal/src/components/ingest/Thumbnail.tsx:42,57` | The inline `style={{ width, height }}` is new in this scan. | A sized image or avatar primitive. | not checked. I did not look for a queue row. |

The runtime-colour hits in `ScorePanelNode`, `Leaderboard`, `CompareDeltaTable` and `PersonDetailCard` are unchanged and covered by the queue row at `ui-components-queue.md:223`.

The 11 `EventSource` uses in `raw-scan.txt` are the same BFF SSE endpoints as last run. `useWorkEvents.ts:16` and `useAssessmentEvents.ts:61` remain candidates for a gateway activity subscription. I did not verify either. No raw `new WebSocket` turned up in `portal/src`. The wide grep errored in the shell and I only saw this in the later narrower one, so treat it as likely rather than certain.

I did not walk the 66 raw-element files brace-aware. The gate budgets pass, which is the only evidence I have for them.

## Stale exemptions
- None found.
- I did not re-check the `UnavailableNotice`, `DiffFrame`, `DimensionRow` or `TemplateHighlighted` rows against the installed dist.

## realtime-examples divergences
- Typing: the portal now follows `HuddleChat.tsx:326,350` (the same `setTyping` and `typingUsers` pattern) through `composerTyping.ts`. I did not open the realtime-examples file this run.
- I did not re-read realtime-examples otherwise, so none of the matrix's citations were re-checked.
- The remaining large gaps are the ❌ rows in the matrix (message edit/delete/forward, diagram board, document review, call reactions, agent-loop cards).

ESCALATE: no — both gates pass and the open findings are low-severity upstream gaps. The typing row needs a matrix update and a browser check, but it raises no authority or fence question.
