surface: activity
role: community-admin
user: u-mira
url: /social/channels (the header bell, opened there)
pages: portal/src/components/shell/ActivityBell.tsx
audited: 2026-10-22 18:50–18:50 local, headless Chromium 1680×940 (Playwright), a fresh signed-in clone of u-mira (u-mira-clone-eea34410), second context the real seed persona u-sana (a separate Playwright context; its tenant was not switched); Tilt stack: Vite :5183 over middleware :3001 (dev:mock), Social platform-api :23002, SFU :3902; mock not reset (shared stack)
session: /api/session/me sub u-mira-clone-eea34410 (a clone of u-mira), tenant social, role community-admin
screenshot: activity.jpg
verdict: pass
console errors: 0
layout: pass — rail 300px at x=200, y=44, height 847px (primary rail open); content (SectionContent) starts x=500, width 1180px (gap from the rail's right edge: 0px); scrollWidth 1680 / viewport 1680; body scrollHeight 940 / 940; footer row y=891–940
keyboard: pass — 11 distinct Tab stops against 23 visible interactive controls (first stops: social-chat-rail-search-toggle, social-new-dm, social-chat-rail-shelf-activity); Enter on the focused bell opened the popover with focus inside it (on BUTTON); Tab inside the popover visited 5 controls (Clear all, Unread (1), _r_a_-panel-unread, Sana Iqbal sent you a message , Mark all read); Escape closed it (true) and focus returned to activity-bell-button
empty-state: pass — after Clear all the popover reads "Notifications Unread All Nothing new Activity will appear here."
realtime: pass — 0.03s: Sana Iqbal's DM, sent on the gateway (/ws) from the second context, turned the bell from "Activity" to "Activity, 1 unread" with no reload
role-gating: the bell and its popover are the same control for every role; items are filtered to the tenants the session holds (this session holds social only)
popover: 360×213px at (1061, 42); focus moved inside: true; the new item was in the popover: true ("Notifications 1 Unread (1) All Sana Iqbal sent you a message Social · Message — Bell probe from Sana: are you around for the 3pm review? just now"); Escape closed it: true and focus returned to activity-bell-button
reload: after a reload the bell reads "Activity, 1 unread" (the unread set replays)
item-click: 1 item(s) in the popover; clicking Sana Iqbal's item landed on /social/dms/social:dm:u-mira-clone-eea34410:u-sana (inside the social tenant); the bell then read "Activity"
mark-all-read: two more DMs made the bell read "Activity, 2 unread"; after Mark all read it read "Activity"
clear-all: Clear all (on the All tab) emptied the popover: true
notes: The second context posted over the gateway socket directly (chat send on social:dm:<this clone>:u-sana), the same frame the DM composer sends. The clone and its DM are deleted after the walk; the mock was not reset. Not exercised: items from other tenants (this session holds social only), a mention item.
