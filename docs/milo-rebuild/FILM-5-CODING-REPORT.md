# Film 5: the coding round on the owner's v2 script

Take 2 is the final film (198 s cut from 566 s recorded, 8 scenes, 2 skip-ahead cuts). Milo was live (real OpenAI); the code ran for real in the Docker runner (Python 3.12, one throwaway container per run). The film's own checks: 18 passed, 1 failed, and that one is a false negative in the check, explained below.

## Product changes in this branch

- **Milo names the lead.** When the candidate asks for a pad change, Milo now says "Sure thing, I just need Hugo to confirm on their screen." The name is the lead's first name from the directory. The lead's spoken "Milo, go ahead" still works. The old line told the candidate what the lead should say.
- **Test cases cover every kind the asker named.** In take 4 and in this branch's take 1, the writer dropped the empty array: two_sum's reference has no answer for it, so the case was filtered out. Now the writer can list the kinds that were asked for and label which case covers each one. The server also reads the request's own words for "empty" and "duplicates", checks each case by its shape, and builds the missing case from another case's arguments when the writer wrote none. A case that was asked for but has no single right answer goes into the pad as an edge input, with no expected value, under its own note. If a kind still can't be covered, Milo says so.

## Beats (take 2)

| Beat | What happened |
|---|---|
| Welcome, small talk (h05, c04, h06), the help line | The help line is read; Milo stays silent, as it should. |
| Question in the pad, Python; Hugo reads the question | Pad synced, Python starter shown. |
| Mateo codes two_sum | Typed under his think-aloud lines. |
| Mateo: "Hey Milo, can you add a few test cases for an empty array and duplicates?" | Milo replied after 4.2 s: "Sure thing, I just need Hugo to confirm on their screen." Whisper on the film heard "I just need Hugo to confirm on their screen." |
| Hugo presses Confirm on the footer's "Pad change?" | Five cases were written. Four were checked against the reference: `([0, 4, 3, 0], 0) -> [0, 3]` (the duplicates case), `([3, 2, 4], 6)`, `([1, 5, 9, 13], 22)` and `([-3, 4, 3, 90], 0)`. The fifth was the edge input `([], 6)`. |
| Mateo runs the code | The output panel showed `Exit code 0`, then `[0, 1] [0, 1]`, four `ok ... | expected ...` rows and `edge ([], 6) -> []`. Hugo's screen showed the same output. |
| Chat beat (h40, c40) | Hugo pasted the news link through the call chat's composer; it showed on Mateo's side. |
| Skip ahead; Mateo: "Roughly how much time is left, Milo?" | Milo replied after 3.8 s: "About 2 minutes are left in this round." Whisper heard the same words. |
| Wrap, End, scorecard | The End click worked (take 4 timed out here). The scorecard had 3 ratings. Milo's recommendation pill read "Milo recommends Inconclusive. No evidence in the transcript for Code quality." |

## Scores

- **Milo's turns:** 2 spoken, both right. Latency was 4.2 s and 3.8 s. There were no overlaps and no barge-ins.
- **Gaps over 6 s:** one, 9.5 s, during the chat beat (Hugo types the link, then Mateo opens his Chat tab). It is an on-screen action, not a watch, so it misses the 6 s bar. A 5.8 s gap while Milo writes the cases is just under the bar. Every other gap is 5.1 s or less.
- **The failed check, "6 Milo's test cases (empty array, duplicates)":** this is a false negative. The check reads the pad's rendered rows, and the editor leaves rows below the fold out of the DOM, so the check never saw the edge input. The run output above shows the empty-array case was in the pad. Because the check failed, Mateo's "There they are" line (n09) was not played.

## Script changes

- Removed: Milo's intro, the lead's probe, and the nameless and mention beats.
- Kept from the old film: the small-talk beat and the chat beat.
- Added: Mateo runs the code (the Docker runner is now used in the named round too), and a retry on the End click.
- New voice line: n23, Hugo reading the question, cropped from the existing n12 take. The recap's evidence window opens on the question's words; without that line, take 1's recap had 0 of 3 competencies with evidence.

## Open

- Make the step-6 check scroll the pad before reading it, or read the run output instead.
- Shorten the chat beat's wait for Mateo's tab.
