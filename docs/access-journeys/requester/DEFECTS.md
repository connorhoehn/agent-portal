# requester walk defects, 2026-10-13 re-walk (07:04-07:10; not fixed, walk only)

No defect fails a surface. Everything from the first walk (14px titles, the agent-waiting 400, the Escape focus loss, 13px record text) no longer reproduces under ui-components 2.441.8.

Minor, still open, not verdict-changing:
- new-request: the single "Who is it for?" radio label measures 13/500, between the 12 and 14 steps of the type scale (library RadioGroup option). The title row also starts at left 264 (a back link takes 224-264); the same on the review campaign record.
