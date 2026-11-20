# Milo Decide model bake-off (2026-11-20)

**Recommendation: gpt-5.4-mini for Decide.** It ties for the best dev accuracy (98.1% action, 100% silence), is the best on the hold-out (96.2% action, 100% silence), and made no false speech and no false write on either set; its misses are false silence, the safe direction. gpt-5.4-nano is the fallback (same dev score, 92.5% hold-out, one hold-out false speech). Confirm with lane 1A's real prompt before locking it in.

Stand-in decide call (name gate, follow-up window, hold, last three lines, Milo's last action, round state) on the FINAL sentence; `store: false`, reasoning off for gpt-5/6. Dev corpus: 114 decide-layer scenarios x 2 runs. Scored on the logged line (action and exact words). Error directions: false speech = Milo spoke when it should not; false write = a write tool ran when it should not; false silence = no line when one was wanted. API errors fall back to silence, so they count as false silence; the column shows how many there were.

| model | action | silence | false speech | false write | false silence | refusal/wrong tool/words | allow-list | api errors | call p50 / p90 ms | hold-out action / silence (totals only) |
|---|---|---|---|---|---|---|---|---|---|---|
| gpt-4.1-mini | 141/156 (90.4%) | 71/72 (98.6%) | 1 | 0 | 6 | 10/0/0 | 228/228 (100.0%) | 0 | 548 / 868 | 46/53 (86.8%) / 24/24 (100.0%) |
| gpt-5.4-nano | 153/156 (98.1%) | 72/72 (100.0%) | 0 | 0 | 3 | 0/0/0 | 228/228 (100.0%) | 0 | 561 / 949 | 49/53 (92.5%) / 23/24 (95.8%) |
| gpt-5.4-mini | 153/156 (98.1%) | 72/72 (100.0%) | 0 | 0 | 3 | 0/0/0 | 228/228 (100.0%) | 0 | 677 / 892 | 51/53 (96.2%) / 24/24 (100.0%) |
| gpt-5.6-luna | 135/156 (86.5%) | 72/72 (100.0%) | 0 | 0 | 17 | 2/2/0 | 228/228 (100.0%) | 0 | 693 / 878 | 42/53 (79.2%) / 24/24 (100.0%) |
| gpt-6-luna | 139/156 (89.1%) | 72/72 (100.0%) | 0 | 0 | 17 | 0/0/0 | 228/228 (100.0%) | 0 | 781 / 1056 | 43/53 (81.1%) / 24/24 (100.0%) |
| gpt-4.1 | 148/156 (94.9%) | 72/72 (100.0%) | 0 | 0 | 8 | 0/0/0 | 228/228 (100.0%) | 0 | 598 / 768 | 48/53 (90.6%) / 24/24 (100.0%) |

## Dev scenarios each model missed (id, tags, miss count of 2)
- gpt-4.1-mini: dev-031 [named,pad_write] x2; dev-035 [named,pad_write,panellist] x1; dev-043 [follow-up,cancel] x1; dev-044 [follow-up,cancel] x2; dev-052 [named,candidate-forbidden] x2; dev-085 [follow-up,for-milo] x2; dev-088 [follow-up,for-milo] x1; dev-106 [misheard-name,pad_write] x2; dev-110 [hold,not-for-milo] x1; dev-033 [named,pad_write,panellist] x1; dev-053 [named,candidate-forbidden] x1
- gpt-5.4-nano: dev-053 [named,candidate-forbidden] x2; dev-085 [follow-up,for-milo] x1
- gpt-5.4-mini: dev-053 [named,candidate-forbidden] x1; dev-085 [follow-up,for-milo] x2
- gpt-5.6-luna: dev-012 [named,time_left,panellist] x2; dev-023 [named,repeat_question,no-question] x1; dev-033 [named,pad_write,panellist] x2; dev-034 [named,pad_write,panellist] x2; dev-035 [named,pad_write,panellist] x2; dev-039 [named,leave_call] x2; dev-040 [named,leave_call] x2; dev-041 [named,leave_call] x2; dev-053 [named,candidate-forbidden] x2; dev-086 [follow-up,for-milo] x2; dev-010 [named,time_left,panellist] x1; dev-052 [named,candidate-forbidden] x1
- gpt-6-luna: dev-012 [named,time_left,panellist] x1; dev-033 [named,pad_write,panellist] x2; dev-034 [named,pad_write,panellist] x2; dev-035 [named,pad_write,panellist] x2; dev-039 [named,leave_call] x2; dev-085 [follow-up,for-milo] x2; dev-086 [follow-up,for-milo] x1; dev-088 [follow-up,for-milo] x2; dev-108 [hold,repeat_question] x2; dev-053 [named,candidate-forbidden] x1
- gpt-4.1: dev-085 [follow-up,for-milo] x2; dev-086 [follow-up,for-milo] x1; dev-087 [follow-up,for-milo] x2; dev-108 [hold,repeat_question] x2; dev-089 [follow-up,for-milo] x1

## Reading (lane 1D)
- Best on accuracy and direction: gpt-5.4-mini (98.1% dev, 96.2% hold-out action, no false speech or write, silence 100%) and gpt-5.4-nano (98.1% dev, 92.5% hold-out; one hold-out false speech). Recommend gpt-5.4-mini as the Decide default; nano is the cheaper fallback.
- gpt-5.6-luna and gpt-6-luna miss mostly by false silence (17 of 156): they decline real requests from panellists and on leave_call. gpt-4.1-mini over-refuses candidates and misses follow-ups.
- No model made a false write; every candidate output stayed inside the allow-list (100%). Call p50 is 0.55-0.8 s, p90 under 1.1 s.
- Caveat: the stand-in prompt is not lane 1A's Decide; rerun `npm run milo-judge:bakeoff` (middleware/) with 1A's prompt before locking in. Hold-out columns are totals only; do not tune on them.
- Since this run the judge changed (not re-run: the machine was on battery, so no live calls): graders are exact match on the tool, the person and the tool's arguments; a scenario now counts only when all 3 runs are right (pass^3; this table is 2 runs, each counted on its own); and 2 hold-out phrasings were replaced so that no hold-out seed phrasing is in dev. Expect the same order with slightly lower numbers; hold-out totals can move by at most 2 of 53. Re-run with `npm run milo-judge:bakeoff -- --models gpt-5.4-mini,gpt-5.4-nano --out <file>` on AC power.
