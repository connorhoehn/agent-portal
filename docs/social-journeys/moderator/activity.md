surface: activity
role: moderator
user: u-lena
url: /social/channels (the header bell, opened there)
pages: portal/src/components/shell/ActivityBell.tsx
audited: 2026-10-06 17:06Z → 17:07Z, Chromium 1680×940, Playwright headless, a separate signed-in context per user (second context u-sana); Tilt stack: Vite :5183 over middleware :3001 (mock providers) with the real SFU :3902 and platform-api :23002
session: /api/session/me sub u-lena, tenant social, role moderator
screenshot: activity.jpg
verdict: pass
console errors: 0
layout: pass — content column x=200px, width 1480px, top 70px, bottom 893px; rail 300px at x=200 (0px from content start), y=70, height 823; pane x=500, width 1180; scrollWidth 1680 / viewport 1680; body scrollHeight 940 / viewport height 940; footer row y=894–940px (1680px wide)
keyboard: pass — physical Tab sweep reached 27 distinct controls in main against 45 visible enabled interactive elements (roving-focus rows and disabled controls are skipped by Tab); first stops: social-new-dm, social-rail-search, social-chat-rail-shelf-activ, social-chat-rail-shelf-menti, social-chat-rail-shelf-calls, social-chat-rail-shelf-recor, rail-section-header-toggle, social-active-now-person-u-a, social-active-now-person-u-j
empty-state: pass — after Clear all the popover reads "Nothing new Activity will appear here."
realtime: pass — 0.01s: Sana Iqbal's DM turned the bell from "Activity" to "Activity, 1 unread" with no reload
role-gating: the bell and its popover are the same control for every role; items are filtered to the tenants the session holds
popover: 360×180px at (1103, 55); focus moved inside: true; new item in popover: true; Escape closed it: true and focus returned to activity-bell-button
reload: after a reload the bell reads "Activity, 1 unread" (the unread set replays)
item-click: 1 items; clicking the first landed on /social/dms/social%3Adm%3Au-lena%3Au-sana
mark-all-read: bell after Mark all read: "Activity"
environment: Tilt stack, DEV_OFFLINE with registered mock providers for chat/directory; rooms, calls and recordings come from the real platform-api and SFU. Mock state was reset per fixture after the walk; walk-created rooms/teams were left for the reviewer.
