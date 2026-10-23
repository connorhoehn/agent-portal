surface: contacts
role: community-admin
user: u-mira
url: /social/contacts
pages: portal/src/pages/social/ContactsPage.tsx
audited: 2026-10-22 18:50–18:50 local, headless Chromium 1680×940 (Playwright), a fresh signed-in clone of u-mira (u-mira-clone-eea34410), second context the real seed persona u-theo (a separate Playwright context opening /iq/projects in his own orgiq tenant; not switched); Tilt stack: Vite :5183 over middleware :3001 (dev:mock), Social platform-api :23002, SFU :3902; mock not reset (shared stack)
session: /api/session/me sub u-mira-clone-eea34410 (a clone of u-mira), tenant social, role community-admin
screenshot: contacts.jpg
verdict: pass
console errors: 0
layout: pass — content column x=200px, width 1480px; scrollWidth 1680 / viewport 1680; body scrollHeight 940 / 940
keyboard: pass — 56 distinct Tab stops against 55 visible interactive controls (first stops: page-header-description-trigger, Search contacts, filter-popover-trigger); Enter on the first Message button ("Message Sana Iqbal") opened /social/dms/social:dm:u-mira-clone-eea34410:u-sana
empty-state: pass — a browser-side stub of GET /api/social/people answering { people: [] } (this context only) rendered "Nobody here yet People appear here once they hold a role in this workspace. An admin grants that from Identity."; a search that matches nobody is the table's own "No person matches these filters."
realtime: pass — 2.74s: u-theo opened /iq/projects (his orgiq shell joins social:lobby) and Here now went 2→3 after 2.74s from his navigation start (his page's load event fired at 2.47s, so 0.28s after it); when his context closed it went 3→2 after 0.06s
role-gating: Message (PostMessage) and Call (StartCall) on every other person's row (16 Message, 16 Call over 16 rows); rows marked "(you)": 0
search: typing "Mia" in the table search left 1 of 16 rows ("1 of 16 people"); before: "16 of 16 people"
message: Enter on the first row's Message opened /social/dms/social:dm:<this clone>:u-sana
presence: Here now before: "Here now 2 MO"; with u-theo on an orgiq page: "Here now 3 MO"
notes: The walker is a clone (u-mira-clone-eea34410); a clone's id is not in the workspace roster, so the table has 0 "(you)" rows and its persona's own row (u-mira) is listed like anyone else's with Message and Call. The own-row rule (no actions on "(you)") is therefore not exercised on this walk. Call was not pressed (calls are their own log).
