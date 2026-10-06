# Mirza professional polish and performance pass

## Goal
Make Mirza feel like a precise, mature legal workspace: compact, fast, aligned, and close to the original product’s restrained Mac-app character, while preserving the existing matter workflows and attorney-controlled AI model.

The selected direction is **Professional monolithic grid** with the locked Mirza palette (`#0F172A`, `#172033`, `#3B82F6`, `#E5E7EB`), compact sidebar, SF Pro/Inter-like typography, low radii, hairline borders, and minimal motion.

## 1. Unify the visual system
- Tighten the global type scale, spacing, row heights, controls, dialogs, sheets, tables, and empty/loading/error states.
- Reduce corner radii to 2–6px, remove decorative shadows and pill-heavy treatments, and use crisp borders and restrained surface contrast.
- Keep dark mode equally deliberate, using the same hierarchy rather than simply inverting colors.
- Preserve semantic color roles for urgency, status, practice area, destructive actions, and AI review notices.
- Apply short 120–160ms transitions and respect reduced-motion preferences.

## 2. Refine the application shell
- Rebuild the navigation rail to match the chosen direction: slimmer, better aligned, clearer active state, consistent icon sizing, and compact labels.
- Keep navigation usable at phone widths without crowding or horizontal overflow.
- Standardize page headers into a compact fixed rhythm so titles, dates, counts, filters, and actions align across the product.

## 3. Polish every primary workspace
- **Today:** implement the selected monolithic three-column docket with compact deadline, task, and activity rows; remove unnecessary nested surfaces.
- **Matters:** make list view the professional high-density default while retaining the user’s view choice; align search, filters, status, dates, and matter actions.
- **Matter workspace:** compact the identity header and tabs, strengthen active-tab hierarchy, and normalize all task, deadline, closing, file, draft, note, contact, and activity rows.
- **Contacts and Files:** replace loose card-heavy presentation with denser directory/table patterns where that improves scanning.
- **House templates:** sharpen the library/editor split, document text area, blank markers, and upload state without changing the house-template workflow.
- **Settings:** turn profile, appearance, AI effort, and usage into a clear administrative layout with compact metrics and tables.
- **Assist and AI review flows:** visually subordinate AI to the matter, reduce chat-like bubbles and rounded prompts, and make effort, source/why, token usage, selection, review, accept/reject, and save states consistently professional.
- Preserve all current functionality and current mobile behavior while restyling.

## 4. Make navigation and loading feel faster
- Establish sensible query freshness and cache retention so returning to recently viewed pages does not immediately refetch unchanged data.
- Move first-screen reads into route loading/prefetch patterns where appropriate so navigation starts data work earlier and screens avoid serial loading.
- Replace the matter page’s eager tab loading with intent-based and active-tab prefetching, avoiding unnecessary requests for tabs the attorney never opens.
- Split heavy, infrequent tools—OCR, PDF/Word extraction, AI panels, and drafting interfaces—behind lazy boundaries so routine Today/Matters visits do not download them.
- Keep OCR browser-only and load its worker/runtime only when extraction or scanned-text reading is actually requested.
- Reduce unnecessary rerenders and broad cache invalidations while keeping all saved changes immediately visible.
- Preserve stable skeleton dimensions to prevent layout shifts.

## 5. Close the most useful remaining product gaps
Add only workflow improvements that directly support the original brief and existing Phase 1 product:
- One-click **Catch me up** on a matter, using the existing matter-scoped Assist behavior and saving only when the attorney chooses.
- **Matter summary export** for tasks, deadlines, and closing status in a portable document format.
- Better closing-checklist operations: practical reordering and multi-item status updates with confirmations and clear save feedback.
- A focused upcoming-deadline view on Today, including a 30-day horizon and an optional responsible-attorney filter where the existing data supports it.

Do not add billing, broad research, global AI prompts, public-company/complex-litigation workflows, email/calendar synchronization, e-signature, or a new document editor in this pass.

## 6. Verification and quality bar
- Check every content page in light and dark mode at desktop and phone widths for alignment, clipping, overflow, text fit, keyboard focus, and readable contrast.
- Exercise real signed-in flows for matters, lists, files/OCR entry points, templates, settings, Assist, review/accept actions, and the new workflow improvements.
- Compare the finished Today screen against the selected direction and verify the same density and hierarchy carry through all pages.
- Measure initial and route-level loading before and after; confirm heavy OCR/document code is absent from routine page loading.
- Run focused tests, type checks, lint/build checks, and inspect runtime/network errors before completion.

## Technical details
- Continue with TanStack Start, TanStack Query, Lovable Cloud, and the existing semantic design tokens/components.
- Use route/query preloading rather than effect-driven fetching for initial page data where practical.
- Use lazy imports at browser-safe boundaries for OCR, extraction, drafting, and Assist UI.
- Keep AI calls in the existing protected server functions/streaming route, keep every run logged, and preserve explicit-click, review-before-use, source/why, Normal/Advanced, and token-cost behavior.
- No schema or security-policy changes unless a selected workflow cannot be delivered safely with the existing data; any such need will be verified before implementation.
