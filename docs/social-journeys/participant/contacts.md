surface: contacts
role: participant
user: u-sana
url: /social/contacts
pages: portal/src/pages/social/ContactsPage.tsx
audited: 2026-10-06 17:10Z → 17:10Z, Chromium 1680×940, Playwright headless, a separate signed-in context per user (second context u-lena); Tilt stack: Vite :5183 over middleware :3001 (mock providers) with the real SFU :3902 and platform-api :23002
session: /api/session/me sub u-sana, tenant social, role participant
screenshot: contacts.jpg
verdict: pass
console errors: 0
layout: pass — content column x=224px, width 1432px, top 70px, bottom 893px; scrollWidth 1680 / viewport 1680; body scrollHeight 940 / viewport height 940; footer row y=894–940px (1680px wide)
keyboard: pass — physical Tab sweep reached 25 distinct controls in main against 25 visible enabled interactive elements (roving-focus rows and disabled controls are skipped by Tab); first stops: datatable-search, social-contact-message, social-contact-call
empty-state: n/a — the roster always holds the viewer (a session stands in social only with a social grant)
realtime: pass — 0.31s: u-theo opened an orgiq page (the shell bar joins social:lobby): Here now 6→7 after 0.306s from navigation start incl. page load; on close 7→6 after 0.104s
role-gating: Message (PostMessage) and Call (StartCall) on every other person's row (12 Call buttons, 12 Message buttons); none on the viewer's own row
search: typing "Mia" in the table search left 1 of 12 rows
message: Enter on the first Message opened /social/dms/social:dm:u-asha:u-sana
presence: Here now before: "Here now6 JL SI RK ND LB AN"; after u-theo's orgiq page closed: "Here now6 JL SI RK ND LB AN"
environment: Tilt stack, DEV_OFFLINE with registered mock providers for chat/directory; rooms, calls and recordings come from the real platform-api and SFU. Mock state was reset per fixture after the walk; walk-created rooms/teams were left for the reviewer.
