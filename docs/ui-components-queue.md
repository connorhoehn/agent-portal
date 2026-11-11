# Composites queued for the component library

Gaps found while building pages. Each row is a workaround in this repository and what the library should absorb. No row here exempts a file from the component-discipline gate (`scripts/lib/discipline.sh` only honours rows that say a file is composed locally).

| Found in | Gap | Worked round with |
|---|---|---|
| `portal/src/pages/iq/RunPage.tsx` (lane E1) | A "Demo data" mark: a small labelled badge for rows and sections that come from a hand-written fixture. | A neutral `Chip` reading "Demo data". |
| `portal/src/pages/iq/RunPage.tsx` (lane E1) | `DataTable` cells do not wrap long prose; a column of sentences runs off the table at 1280 wide. A column option such as `wrap` (with a max width) would do it. | `T` with `block max-w-[26rem] whitespace-normal` in the cell. |
| `portal/src/pages/iq/RunsPage.tsx` (lane E2) | `CollectionPage`'s `table` prop loses its row type through `ComponentProps` in the app's `CollectionCommandPage`, so a typed table cannot be passed. The page passes a `DataTable` as the body instead. | `DataTable` as `children`. |
| `portal/src/pages/iq/RunPage.tsx` (lane E1) | A read-only "document with a toolbar" for a frozen text (brief, report): the document reader needs a fixed-height parent, so the page wraps it in a sized `Stack`. | `ReadOnlyDocument` in `Stack className="h-[70vh]"`. |
| `portal/src/pages/runbooks/ProposalReview.tsx` (lane E4) | `ChangeReviewCard` with a confirmation step: `onAccept` fires at once, and a proposal's accept must state the scope, tick each script, then accept. A card option for a confirmation body would remove the second button. | `onAccept` left out; an Accept button in the `actions` slot opens the confirmation. |
| `portal/src/pages/runbooks/ProposalReview.tsx` (lane E4) | `ConfirmDialog` takes a string body. The scope sentence fits, but the second confirmation for a wider scope and the script ticks need a body node and a two-stage flow. | Separate dialogs and children for each stage. |
| `portal/src/pages/runbooks/EvidenceLine.tsx` (lane E4) | An evidence or summary line that pairs each figure with its sample size ("in the last 30 days N of M runs …"), so that rule lives in one place. | A few `T` sentences in a `DetailSection`. |
