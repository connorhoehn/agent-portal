surface: activity
role: participant
user: u-sana
url: /social/channels (the header bell, opened there)
pages: portal/src/components/shell/ActivityBell.tsx
audited: 2026-10-06 17:18Z → 17:19Z, Chromium 1680×940, Playwright headless, a separate signed-in context per user (second context u-lena); Tilt stack: Vite :5183 over middleware :3001 (mock providers) with the real SFU :3902 and platform-api :23002
session: /api/session/me sub u-sana, tenant social, role participant
screenshot: activity.jpg
verdict: pass
console errors: 0
layout: pass — content column x=200px, width 1480px, top 70px, bottom 893px; rail 300px at x=200 (0px from content start), y=70, height 823; pane x=500, width 1180; scrollWidth 1680 / viewport 1680; body scrollHeight 940 / viewport height 940; footer row y=894–940px (1680px wide)
keyboard: pass — physical Tab sweep reached 24 distinct controls in main against 39 visible enabled interactive elements (roving-focus rows and disabled controls are skipped by Tab); first stops: social-new-dm, social-rail-search, social-chat-rail-shelf-activ, social-chat-rail-shelf-menti, social-chat-rail-shelf-calls, social-chat-rail-shelf-recor, rail-section-header-toggle, social-active-now-person-u-j, social-active-now-person-u-l
empty-state: pass — after Clear all the popover reads "Nothing new Activity will appear here."
realtime: pass — 0.10s: Lena Brandt's DM turned the bell from "Activity" to "Activity, 1 unread" with no reload
role-gating: the bell and its popover are the same control for every role; items are filtered to the tenants the session holds
popover: 360×180px at (1110, 55); focus moved inside: true; new item in popover: true; Escape closed it: true and focus returned to activity-bell-button
reload: after a reload the bell reads "Activity, 1 unread" (the unread set replays)
item-click: 1 items; clicking the first landed on /social/dms/social%3Adm%3Au-lena%3Au-sana
mark-all-read: bell after Mark all read: "Activity"
environment: Tilt stack, DEV_OFFLINE with registered mock providers for chat/directory; rooms, calls and recordings come from the real platform-api and SFU. Mock state was reset per fixture after the walk; walk-created rooms/teams were left for the reviewer.
