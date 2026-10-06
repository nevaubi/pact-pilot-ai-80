# Office AI — pass 2 verification

Scope: the code-review findings P0-1 to P0-7, formatting proposals (8), and the fidelity/save work (9–12). **Not deployed.**

## Commands and results (run 2026-10-06, sandbox)

| Command | Result |
| --- | --- |
| `bunx vitest run` | **7 files, 70 tests passed** |
| `bunx tsgo --noEmit` | no errors |
| `bunx eslint <changed files>` | 0 errors (4 `react-refresh/only-export-components` warnings in editor files that export helpers) |
| `bunx vite build` | built OK |
| `grep -lE "search_public_law\|fetch_public_source\|LOVABLE_API_KEY\|ai.gateway.lovable.dev\|COURTLISTENER_API_TOKEN\|SUPABASE_SERVICE_ROLE" dist/client/assets/*.js` | no matches: the server tool loop, gateway and secrets are not in browser bundles |
| `python3 docs/office-ai-verification/harness_check.py` (dev server on :8080) | **22/22 PASS** |
| `python3 docs/office-ai-verification/route_check.py` | Save disabled when unchanged; at 1024 px the panel is 351 px and the editor 673 px; on a 390 px phone the panel closes and opens as a full-width drawer; no page errors |

Live gateway check (curl to `/v1/responses`, `openai/gpt-6-astra`): `max_output_tokens: 40` returned `status: "incomplete"` with reason `max_output_tokens`, so the cap is real. The draft loop sends it as `maxOutputTokens` (6,000 Normal, 16,000 Advanced).

## Browser scenarios (synthetic harness `/dev/office-harness`, real SuperDoc 2.20 and Univer engines)

The harness generates its own DOCX and XLSX in the browser and is a 404 outside `vite dev`. The AI endpoint is mocked at the network boundary with `page.route("**/api/assist")`. The save RPC and storage are also mocked with `page.route`.

The harness used the preview's existing sign-in. No matter data was created or changed. `route_check.py` only opened an existing sample spreadsheet; it did not save.

PASS: both editors mount · Word replace + insert_after applied as one atomic tracked plan (2 tracked changes) · Word inline format (bold, italic, 14 pt) applied as a tracked change · duplicate passage refused, nothing changed · stale anchor refused after checking the live text · `{}` receipt from the real adapter → failure, document unchanged · DOCX export then reopen keeps tracked changes (3→3) · Reject all restores the original text · Accept all keeps the change · XLSX export of an unedited workbook returns the exact original bytes · typed batch across two sheets (00123 text, `=not a formula` text, formula, number, bold + fill) · unknown sheet rejects the whole batch with no partial write · export then reopen: 00123 is still text, new formula present, untouched `=SUM(B2:B3)` kept, bold + fill kept · save conflict (RPC 40001) raises SaveConflict and deletes only the just-uploaded object · panel: proposal card applies once (double-click) and then locks as "Applied" · error shown with Retry · Retry runs as a new request · Stop ends a hanging stream · no uncaught page errors.

Screenshots: `docs/office-ai-verification/*.png`.

## Migration

`drizzle/migrations/0007_conflict_safe_file_save.sql` was **applied to the project database**. It adds `public.save_file_version(...)`:
- `SECURITY INVOKER`, so the caller's own access rules apply.
- Locks the file row (`FOR UPDATE`) and compares the stored path with the path the editing session loaded.
- Requires the new object to be under the file's matter folder and already uploaded.
- Inserts the old path into `file_versions` and updates the file in one transaction.
- Records `auth.uid()` as the actor.
- `EXECUTE` granted to `authenticated` only.

## Limits and untested paths

- **Word formatting:** applied through SuperDoc's tracked `format.apply`. Whether Word desktop shows it as a formatting revision depends on SuperDoc's export; not checked in Word.
- **Word batches:** use SuperDoc's native atomic plan. If the engine throws after the document revision moved, the result is reported as partial and is never re-applied automatically.
- **Spreadsheet rollback:** Univer has no atomic batch, so rollback restores exact snapshots and checks them; a failed restore is reported as partial.
- **XLSX saving:** patches only changed cells and appends style records. It refuses sheet add/rename/reorder, merges, row/column size changes, protected sheets, shared/array formula regions, macro or encrypted packages, and formatting beyond bold/fill/alignment/number format. After a formula edit it sets `fullCalcOnLoad` and leaves `calcChain.xml` alone; not opened in Excel desktop.
- **DOCX and PDF edited exports:** these are re-serialised by SuperDoc / EmbedPDF (review mode with tracked changes for DOCX). Only unchanged files keep their exact original bytes.
- **Public law search:** each provider reports `ok`, `no_results`, `rate_limited`, `unavailable` or `not_configured`. CourtListener runs anonymously unless a `COURTLISTENER_API_TOKEN` secret is added. `publicQuery` is a best-effort scrub, not a guarantee. Live provider responses were not exercised this pass; only unit and route logic.
- **Untested:**
  - a live model run of the tool loop against the gateway (unit-tested with the AI SDK mock model);
  - the real RPC under true concurrent saves (SQL reviewed; the network-boundary mock covers the client path);
  - restore through the UI;
  - unsaved-changes prompts on in-app navigation (`useBlocker`).
- **Harness in the build:** the harness code ships as its own chunk but refuses to load outside dev; it contains no secrets or data.
