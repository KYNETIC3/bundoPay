# Plan: the judge demo story (`feat/judge-demo-story`)

Branch B of the three-branch finalist plan. It merges after the PayPal checkout branch (`feat/paypal-checkout-agent-toolkit`), whose test store is step 1 of the story.

## UI rules

- **One idea per screen.** Add no new top-level navigation item (`Shell.tsx` keeps 4 tabs), add no new jargon, and use one name per concept.
- **Keyboard and focus.** Keep the global `:focus-visible` ring (`globals.css:40`). Don't set `suppressCellFocus` on new grids, because AG Grid's own keyboard navigation and ARIA grid roles must stay usable.
- **Target size and contrast.** Targets are at least 24×24 px (the app already uses 40 px). Text contrast is at least 4.5:1. Status is never shown by colour alone: always pair it with an icon and text, as `Pill` does.
- **Announcements.** Async results (payment done, chart ready, draft created) are announced with `aria-live="polite"`. Errors use `role="alert"`.
- **Motion.** Every new animation respects `prefers-reduced-motion`. Use the existing `reduced()` helper in `motion.tsx` and Tailwind's `motion-reduce:`.
- **Phones.** Phones (below 640 px) get cards, not wide grids, following the `DisputeTable` → `DisputeCards` pattern.
- **Reuse existing UI.** Reuse `Card`, `Pill`, `Button`, `IconButton`, `Details`, `Empty` and `Tooltip` from `components/ui.tsx`. Don't create new primitives.

## The plan

**Goal:** A judge logs in and follows one story in about 3 minutes: **sale → money set aside → dispute → Bundo (Gemini) drafts → owner approves → ledger proof**. The AI's role must be visible, and nothing should overwhelm.

### B1. Make the AI visible and required
- **Labels:**
  - Show `rec.source` on the dispute recommendation card (`app/money/disputes/[id]/page.tsx:140`): a `Pill` saying "Reasoned by Gemini · checked by code", or "Built-in rules" when `source == "rules"`.
  - Do the same in `components/Copilot.tsx`, using `result.source` (the type is already in `lib/treasury.ts:116`).
- **Route the injection through the model** (`treasury/copilot.py:189-207`):
  - Call the model first. The SYSTEM prompt already asks it to return `intent:"move_now"`.
  - Keep the `MOVE_NOW` regex as a backstop that runs *after* the model: if either flags it, the result is `move_now`.
  - The card then says "Gemini flagged this · the safety engine blocked it · $0.00 moved". The regex remains as defence in depth. Without a key, it behaves as today.
- **Make Gemini required for the demo:**
  - On startup, if `DEMO_EMAIL` is set and `GEMINI_API_KEY` is empty, log a loud warning, and make `/demo/info` return `ai: false`.
  - The login page then shows a short notice: "AI is off on this server; Bundo is using built-in rules."
  - Add `GEMINI_MODEL` to `render.yaml`, and mark Gemini as required for the hosted demo in `SETUP.md` §6 and §11.
- **Ask Bundo error:** handle the 503 `no_model` in the frontend with a friendly `Empty` state instead of the raw message.

### B2. Seed a story, not an empty account (`backend/app/demo/service.py` `reset()`)
- After the accounts, seed three **approved** policies through the existing policy service: 8.25% tax reserve, dispute buffer 100% + 2%, and a $15k Friday ad sweep. Then the judge sees rules working and can still try the Copilot.
- Seed no fake PayPal data. Sales come from the real `/store` (branch A), and disputes from the sandbox buyer.

### B3. A "Start here" guide (demo account only)
- **Card:** a dismissible `Card` at the top of Home (`app/page.tsx`), shown only when `/me` says it's the demo account. It shows a numbered checklist of five steps, each a single link:
  1. Make a sale in the test store.
  2. See tax set aside.
  3. Open a dispute as the buyer (opens the sandbox; one line of help text).
  4. Review Bundo's draft and approve.
  5. Check your records.
- **Step state:**
  - Ticks come from real data where it exists: a capture exists, a reserve movement exists, a dispute exists, a draft is approved, and the chain was verified.
  - Otherwise a tick is set manually (the "I did this" button), saved in localStorage.
  - Implement this as a new `GET /demo/progress`.
- **Accessibility:**
  - Use an `<ol>` with each item's state in text ("Done"/"Next"), not colour alone.
  - The current step has `aria-current="step"`.
  - Dismissal is remembered, with "Show guide" in Settings → Demo.
  - Show only one "Next" call to action at a time, to avoid overwhelm.

### B4. Remove confusion
- **One name per concept:**
  - "Jars" in the UI. Keep "Treasury" only in the pitch, saying "Treasury (Jars)" once.
  - "Rules", not "Policies".
  - "Rules helper", not both "Copilot" and "Rules Copilot".
  - Plain words for "liquidity floor" ("Keep at least") and "solo limit" ("Approve anything over").
  - Find each label with `grep` across `frontend/src`.
- Map engine codes like `6_liquidity_floor` to plain sentences in `lib/treasury.ts` (`LABEL_COPY`) so raw codes never show.
- For the demo account, hide the Home "Customize" button and range picker until the guide is dismissed, to keep the first screen calm.

### B5. Docs
- Rewrite `docs/DEMO.md` as one 3-minute story matching B3. Use current UI labels (Money → Jars, Rules, Activity, "Your records are intact") and add a "What's real" table. Remove stale labels such as "Simulate" and "Verify chain".
- Add `docs/JUDGES.md`:
  - The login.
  - The 5 steps.
  - A table mapping each featured technology (Checkout, JS SDK v6, REST APIs, Agent Toolkit, Sandbox, Gemini, AG Grid, AG Studio) to the screen and file where it is used.
- Update the README link.

### B6. Tests and verification
- **Tests:**
  - `test_treasury_copilot.py`: the injection reaches the FakeLLM; model or regex flags it as `move_now`; without an LLM it behaves as before.
  - `test_demo.py`: reset seeds 3 approved policies; `/demo/progress` derives each step.
- **Browser pane:**
  - Log in as the demo user and walk all 5 steps.
  - Confirm each label appears.
  - Do a keyboard-only pass and a mobile-width pass.
  - Check with the reduced-motion emulation if available, otherwise by reading the CSS.
- **Docs:** write `docs/plans/demo.md`. Then commit, push, and open the PR, merging after A.
