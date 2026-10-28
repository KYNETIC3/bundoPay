# Plan: AG Grid and AG Studio depth (Branch C)

One of three finalist fine-tuning branches (PayPal, demo, AG). This is the AG branch, implemented on `feat/ag-studio-grid-depth`.

## UI rules (shared by all three branches)

Backed by WCAG 2.2 AA:
- **One idea per screen.** Add no new top-level navigation item (`Shell.tsx` keeps 4 tabs), add no new jargon, and use one name per concept.
- **Keyboard and focus.** Keep the global `:focus-visible` ring (`globals.css:40`). Don't set `suppressCellFocus` on new grids, because AG Grid's own keyboard navigation and ARIA grid roles must stay usable.
- **Target size and contrast.** Targets are at least 24×24 px (the app already uses 40 px). Text contrast is at least 4.5:1. Status is never shown by colour alone: always pair it with an icon and text, as `Pill` does.
- **Announcements.** Async results (payment done, chart ready, draft created) are announced with `aria-live="polite"`. Errors use `role="alert"`.
- **Motion.** Every new animation respects `prefers-reduced-motion`. Use the existing `reduced()` helper in `motion.tsx` and Tailwind's `motion-reduce:`.
- **Phones.** Phones (below 640 px) get cards, not wide grids, following the `DisputeTable` → `DisputeCards` pattern.
- **Reuse existing UI.** Reuse `Card`, `Pill`, `Button`, `IconButton`, `Details`, `Empty` and `Tooltip` from `components/ui.tsx`. Don't create new primitives.

## Branch C: `feat/ag-studio-grid-depth` (AG Grid and AG Studio)

**Goal:** AG Studio answers the seller's question ("What's at risk, can I win it, and is enough set aside?") with linked data and calculated fields, and its real AI assistant builds whole dashboards. AG Grid does the real work of reconciliation, the ledger, and evidence.

### C1. Data model (`frontend/src/lib/studio/model.ts`)
- **Extend the `disputes` source** with `dispute_id`, `opened` (date), `due` (date), `status`, `days_left` (integer), `won`/`lost` (0/1 for resolved), and `buffer_share`.
  - The data is already in `DisputeSummary` and `/disputes`. If a field is missing, add it in `disputes/router.py:65`.
- **Add `expressions`** (`AgExpressionFieldDefinition`, `isMeasure`):
  - **Net exposure:** sum(at_stake where open) − Dispute buffer balance.
  - **Win rate:** sum(won) / (sum(won)+sum(lost)).
  - **Evidence coverage:** avg of coverage.
  - **Free to spend:** already present in `money`.
  - Each expression gets a plain-English `name` and `description`, because these are what the AI and the field panel show.
- Give every source and field a `description`, so the AI assistant picks the right fields.
- **Relationships:** keep the existing ones (`model.ts:143-150`). Add `disputes.transaction_id → transactions.transaction_id` when a reconciliation dataset exists (C3).

### C2. Turn on AG Studio's AI assistant
- **Where:** only in Ask Bundo → "Build a dashboard" (`components/ChartBuilder.tsx`). Keep boards in view mode as they are, so merchants aren't overwhelmed.
- **Wiring:**
  - Register `AgStudioAiModule` on that `AgStudioProvider` (`modules={[AgStudioAiModule]}`).
  - Pass `ai={({api}) => createAiHarness(api, {adapter: bundoAdapter, promptStarters})}`.
  - Starters: "Where am I losing disputes?", "How much money is at risk this week?", "Is my dispute buffer enough?".
- **Adapter fixes** (`lib/studio/adapter.ts`):
  - Emit `RUN_STARTED`/`RUN_FINISHED`.
  - Make the chart id per harness thread rather than module-level (`startChart()`), so a multi-turn dashboard counts once against the limit.
  - Remove the `as unknown as` cast by matching `AgLlmResponseHandler` types.
- **Backend** (`agent/studio.py`): nothing needed beyond checking `MAX_TOOL_ROUNDS=40` and the 512 KB body cap against the harness's tool schemas. Raise the body cap only if a real request hits 413.
- **Keep the simple one-shot `describeChart` path** as the default "Quick chart". "Build a dashboard" is the second, clearly labelled option, using `Segmented` with 2 choices. **Pinning** stays as now (`pinToBoard`), and also allows pinning a whole page as the new "disputes" board layout.

### C3. "Dispute Command Center": upgrade the existing Disputes board
- Upgrade the curated `disputes` board (`boards.ts:106`) instead of adding a new board id, so there are no new navigation items.
- **Hero row (three value tiles):** Net exposure, Win rate, and Disputes due in 48h.
- **Second row:** "At stake by reason" (existing). Replace "No tracking" with a stacked bar of "Evidence coverage by reason".
- **Layout:** at most 5 widgets, 4 columns on desktop and 2 on phones (`forPhone`). Bump the localStorage key from `bundo.board.disputes.v2` to `.v3` so old saved layouts don't hide the new tiles.

### C4. AG Grid where a grid really helps
- **New component** `components/DataGrid.tsx`: a thin wrapper around `AgGridReact` with:
  - `theme={gridTheme}` and `AllCommunityModule`.
  - **No `suppressCellFocus`**, so keyboard navigation works.
  - `ensureDomOrder` for screen readers, `aria-label` via `gridOptions`, and `domLayout="autoHeight"`.
  - Built-in quick filter input, with a visible label.
  - "Download CSV" via `api.exportDataAsCsv()` (Community).
  - Below 640 px it renders a card list instead, the `DisputeCards` pattern; reuse `useNarrow` by moving it to `lib/hooks.ts`.
- **Reconciliation grid**, on the Settings → Store data section where uploads already live:
  - Shows PayPal transactions (`/data/records?kind=orders` joined client-side with dispute transactions) next to store orders.
  - Columns: Order, PayPal transaction, Amount, Tracking, Status.
  - Rows missing tracking or an order get a `Pill` with an icon and text ("No tracking"), not colour alone.
  - A filter chip, "Only problems", is on by default.
- **Ledger grid** on Jars → Activity (`app/money/jars/activity/page.tsx`): replace the CSV statement block with a grid of movements from `/treasury/overview` movements and `/treasury/insights`.
  - Columns: When, Jar, Amount, Outcome, Who started it, Checked by.
  - Sorted newest first. Keep the existing timeline pane and the "Your records are intact" check.
- **Evidence grid** on the dispute detail page (`app/money/disputes/[id]/page.tsx:170-200`): inside the existing `<details>`, replace the `<li>` list with a grid.
  - Columns: Proof needed, Found, Where it came from (`source_system`), Match confidence.
  - Keep the "N missing" summary line.
  - On phones, keep the current list.
- **Scope:** don't add more grids than these three, and don't use Enterprise features.

### C5. Tests and verification
- `npm run typecheck && npm run build`. Use `enableStudioDevValidations()`, which already runs in dev, to catch bad expressions and relationships in the browser console.
- **Browser pane:**
  - On the Disputes board, check the hero tiles' numbers against `/disputes`.
  - In Build a dashboard, run the "Where am I losing disputes?" starter, which should make several widgets in one run. Confirm the chart counts once against the limit and appears in `/agent/studio/turn` logs.
  - Check each grid: Tab into it, use arrow keys, filter, and export CSV.
  - Check mobile widths (cards appear) and console errors.
- **Backend:** `uv run pytest tests/test_studio_turn.py`, plus any dispute router field additions.
- **Docs:** write `docs/plans/ag-grid-studio.md`. Then commit, push, and open the PR.
