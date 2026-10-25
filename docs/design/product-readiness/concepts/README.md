# Hangout concept direction

Generated with the built-in Codex image-generation tool on 2026-10-25 in response
to the user's rejection of the crowded call layout and unrelated right chat pane.
These are proposed layouts with illustrative people and activity, not screenshots
of accepted implementation. Preserve the real app's logo, tokens, controls and
authorization when implementing; raster details are not a new design system.

- [Call view](hangout-call-v1.png): one hangout rail, clear page header, shared
  tabs, one main call stage and one set of call controls. Conversation belongs
  to the selected call/room and opens explicitly.
- [Saved rooms view](hangout-rooms-v1.png): one room table, people assignment,
  assigned/self-select mode, return-to-main setting and explicit Save.

## Prompt specifications

Call: high fidelity desktop UI concept for the existing AgentCore Social app;
use the supplied app screenshot as a brand reference, not as layout to preserve.
Keep the thin purple rule, compact navy type, pale navigation rail, white canvas,
subtle borders and shared rounded controls. Design studio is selected. Use
Overview, Call, Conversation, Rooms and Activity tabs. Call shows the selected
Design review room, two participant tiles with initials, one controls bar and
a small room-context line. No default far-right chat, configuration forms,
history or repeated controls. Footer shows connection status only. Illustrative
state, not live-data evidence.

Rooms: companion view using the first generated image as the visual reference.
Keep the same chrome, header and tabs with Rooms selected. Show Saved layout /
This call selection, Add room, a tidy table with room names and assigned people,
compact assignment actions, room-entry mode, return-to-main switch, an explanation
that assignment is not attendance, and Cancel / Save layout. No video, detached
chat pane, sprawling per-row forms or duplicate actions. Illustrative state.

## Mapping to existing components

| Region | Shared owner |
| --- | --- |
| Shell and hangout rail | AppShell / SocialChatWorkspace / shared sidebar |
| Header and view navigation | PageSection, Tabs, TabPanel |
| Active call | CallBlockHost, ConversationCallDock, CallDock stage |
| Room conversation | HuddleChatBody / ConversationThread / ConversationComposer; existing authorized room channel |
| Saved room layout | DataTable, PersonPicker, FormField, Input, Select, Switch, Modal |
| Live room controls | WrappedBreakoutRoomsPanel / realtime-modules useMeeting |
| Activity | Existing authorized attendance and recording-summary projection |

The illustrated Purpose column is not yet in the saved child-room model. Do not
invent or silently persist unsupported fields. The implementation must distinguish
saved assignments, temporary call changes and actual presence.
